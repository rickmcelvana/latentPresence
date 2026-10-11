//! Web: the companion's own server for searching the web and reading a page (P5-T06, ADR-47).
//!
//! `search` asks the person's provider (`search::Provider`) and `read_page` reads one page as
//! text, a page of lines at a time like Files. Each result carries a `ref` — `w` and six hex
//! digits of the URL's SHA-256, the same for a search hit and the page it names — and the rule
//! to cite it with `[cite:<ref>]` (ADR-45's tag), so her answer lists its sources the way it
//! does for documents. The page's gate asks before each call: a search sends her words to the
//! provider, and a page is fetched from the internet.

pub mod fetch;
pub mod search;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::files::{LinesPage, from_line, lines_page};
use super::{CallOutcome, ToolInfo};
use fetch::Fetcher;
use search::{Freshness, Hit, Provider, Searcher};

/// What a result asks of her: the rule lands where it is used (P5-T04: 14/15 in the prompt,
/// 20/20 repeated in the result).
pub const CITE: &str = "End each sentence that uses a result with its ref as a tag, like [cite:w1a2b3c]. Do not say the ref or the address aloud.";
/// Results a search returns unless she asks for fewer, and the most.
const DEFAULT_RESULTS: usize = 5;
const MAX_RESULTS: usize = 10;
/// A page of a web page, in bytes: under the page's 8 000-character cut once it is JSON.
const PAGE_BYTES: usize = 5000;

/// A URL's ref: `w` and the first six hex digits of its SHA-256.
pub fn reference(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    format!("w{:02x}{:02x}{:02x}", digest[0], digest[1], digest[2])
}

fn site(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.trim_start_matches("www.").to_owned())
        })
        .unwrap_or_default()
}

fn refuse(message: impl Into<String>) -> CallOutcome {
    CallOutcome::text(true, message)
}

fn answer(text: String, structured: Value) -> CallOutcome {
    CallOutcome {
        is_error: false,
        text,
        structured: Some(structured),
        images: 0,
    }
}

pub struct WebServer {
    searcher: Option<Searcher>,
    fetcher: Option<Fetcher>,
    /// Off only in tests, which serve pages from loopback.
    guarded: bool,
}

impl WebServer {
    pub fn new(provider: Option<Provider>, read_pages: bool) -> Result<Self, String> {
        Self::build(provider.map(|p| (p, None)), read_pages, true)
    }

    /// For tests: a provider at a local address, and page reading without the address guard.
    pub fn unguarded(
        provider: Option<(Provider, Option<String>)>,
        read_pages: bool,
    ) -> Result<Self, String> {
        Self::build(provider, read_pages, false)
    }

    fn build(
        provider: Option<(Provider, Option<String>)>,
        read_pages: bool,
        guarded: bool,
    ) -> Result<Self, String> {
        let searcher = provider
            .map(|(provider, base)| Searcher::with_base(provider, base))
            .transpose()?;
        let fetcher = read_pages.then(|| Fetcher::new(guarded)).transpose()?;
        Ok(Self {
            searcher,
            fetcher,
            guarded,
        })
    }

    pub fn instructions(&self) -> String {
        match &self.searcher {
            Some(searcher) => format!(
                "The web, through {}: search, then read a page when a result's snippet is not enough. Cite what you use.",
                searcher.provider().name()
            ),
            None => "Read a web page whose address you have. Cite what you use.".into(),
        }
    }

    pub fn tools(&self) -> Vec<ToolInfo> {
        let annotations =
            json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": true });
        let mut tools = Vec::new();
        if let Some(searcher) = &self.searcher {
            tools.push(ToolInfo::new(
                "search",
                &format!(
                    "Search the web with {}. Results have a title, address, snippet and a ref to cite. The search words leave this computer.",
                    searcher.provider().name()
                ),
                json!({ "type": "object", "properties": {
                    "query": { "type": "string", "description": "What to search for, as you would type it." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": MAX_RESULTS, "description": "How many results; 5 if left out." },
                    "freshness": { "type": "string", "enum": ["day", "week", "month", "year"], "description": "Only results this recent. Leave it out unless it matters." }
                }, "required": ["query"] }),
                annotations.clone(),
            ));
        }
        if self.fetcher.is_some() {
            tools.push(ToolInfo::new(
                "read_page",
                "Read a web page as text, a page of lines at a time; a long one says how to read on. Pages on this computer or its network cannot be read.",
                json!({ "type": "object", "properties": {
                    "url": { "type": "string", "description": "The page's address, http or https." },
                    "from_line": { "type": "integer", "minimum": 1, "description": "The line to start at; 1, or leave it out, for the start." }
                }, "required": ["url"] }),
                annotations,
            ));
        }
        tools
    }

    pub async fn call(&self, name: &str, args: &serde_json::Map<String, Value>) -> CallOutcome {
        let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").trim();
        match (name, &self.searcher, &self.fetcher) {
            ("search", Some(searcher), _) => {
                let limit = args
                    .get("limit")
                    .and_then(|value| {
                        value
                            .as_u64()
                            .or_else(|| value.as_str()?.trim().parse().ok())
                    })
                    .map_or(DEFAULT_RESULTS, |n| (n as usize).clamp(1, MAX_RESULTS));
                let freshness = Freshness::parse(arg("freshness"));
                self.search(searcher, arg("query"), limit, freshness).await
            }
            ("read_page", _, Some(fetcher)) => match from_line(args.get("from_line")) {
                Ok(from) => self.read(fetcher, arg("url"), from).await,
                Err(why) => refuse(why),
            },
            (other, _, _) => refuse(format!("Web has no tool called {other}.")),
        }
    }

    async fn search(
        &self,
        searcher: &Searcher,
        query: &str,
        limit: usize,
        freshness: Option<Freshness>,
    ) -> CallOutcome {
        if query.is_empty() {
            return refuse("Give some words to search for.");
        }
        let hits = match searcher.search(query, limit, freshness).await {
            Ok(hits) => hits,
            Err(why) => return refuse(why),
        };
        if hits.is_empty() {
            return answer(
                format!("Nothing found for \"{query}\"."),
                json!({ "found": [], "note": format!("Nothing found for \"{query}\".") }),
            );
        }
        let found: Vec<Value> = hits.iter().map(found).collect();
        let lines: Vec<String> = hits
            .iter()
            .map(|hit| {
                let date = hit
                    .published
                    .as_deref()
                    .map(|d| format!(" ({d})"))
                    .unwrap_or_default();
                format!(
                    "[{}] {} — {}{date}\n{}",
                    reference(&hit.url),
                    hit.title,
                    hit.url,
                    hit.snippet
                )
            })
            .collect();
        answer(
            format!("{CITE}\n\n{}", lines.join("\n\n")),
            json!({ "cite": CITE, "found": found }),
        )
    }

    async fn read(&self, fetcher: &Fetcher, url: &str, from: usize) -> CallOutcome {
        if url.is_empty() {
            return refuse("Give the address of the page to read.");
        }
        let page = match fetcher.fetch(url, self.guarded).await {
            Ok(page) => page,
            Err(why) => return refuse(format!("{url}: {why}")),
        };
        let address = page.url.to_string();
        let Some(LinesPage {
            page: text,
            next,
            total,
        }) = lines_page(&page.text, from, PAGE_BYTES)
        else {
            let total = page.text.split_inclusive('\n').count();
            return refuse(format!(
                "{address} has {total} lines of text; there is no line {from}."
            ));
        };
        let more = if next < total {
            Some(format!(
                "Not the whole page: read on with from_line {}.",
                next + 1
            ))
        } else if page.cut {
            Some(format!(
                "The page is longer than the {} MB read.",
                fetch::PAGE_LIMIT / (1024 * 1024)
            ))
        } else {
            None
        };
        let reference = reference(&address);
        let lines = format!("{from}–{next} of {total}");
        let header = format!("[{reference}] {} — {address} (lines {lines})", page.title);
        answer(
            format!(
                "{CITE}\n\n{header}\n{text}{}",
                more.as_deref()
                    .map(|m| format!("\n[{m}]"))
                    .unwrap_or_default()
            ),
            json!({
                "cite": CITE,
                "tag": format!("[cite:{reference}]"),
                "ref": reference,
                "title": page.title,
                "url": address,
                "site": site(&address),
                "lines": lines,
                "text": text,
                "more": more,
            }),
        )
    }
}

fn found(hit: &Hit) -> Value {
    let reference = reference(&hit.url);
    json!({
        // The tag itself, to copy: glm left it off 1 answer in 10 when it had only the ref.
        "tag": format!("[cite:{reference}]"),
        "ref": reference,
        "title": hit.title,
        "url": hit.url,
        "site": site(&hit.url),
        "snippet": hit.snippet,
        "published": hit.published,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ref_is_short_stable_and_a_cite_tag_value() {
        let one = reference("https://weather.example/halifax");
        assert_eq!(one, reference("https://weather.example/halifax"));
        assert_ne!(one, reference("https://weather.example/toronto"));
        assert_eq!(one.len(), 7);
        assert!(
            one.starts_with('w')
                && one[1..]
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(
            site("https://www.theweathernetwork.com/ca"),
            "theweathernetwork.com"
        );
    }
}
