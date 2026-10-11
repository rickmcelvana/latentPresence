//! The web search providers (ADR-47): the person's own SearXNG, or Tavily or Brave with their
//! own key. Each answer becomes the same `Hit`s; the shapes were read from each one's docs
//! (`docs/SURFACE.md`, 2026-10-11).
//!
//! The provider's address is the person's, from `mcp.json`, so it may be on their network (a
//! SearXNG at home); only `read_page`'s addresses, which come from a model, are kept public.

use std::time::Duration;

use serde_json::{Value, json};

/// Which service answers, and how to reach it. The key is never printed.
#[derive(Clone, PartialEq, Eq)]
pub enum Provider {
    Searxng { url: String },
    Tavily { key: String },
    Brave { key: String },
}

impl std::fmt::Debug for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Searxng { .. } => "SearXNG",
            Self::Tavily { .. } => "Tavily",
            Self::Brave { .. } => "Brave Search",
        }
    }
}

/// How recent the results should be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    Day,
    Week,
    Month,
    Year,
}

impl Freshness {
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "day" => Some(Self::Day),
            "week" => Some(Self::Week),
            "month" => Some(Self::Month),
            "year" => Some(Self::Year),
            _ => None,
        }
    }
}

/// One result, as every provider's becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub published: Option<String>,
}

/// A snippet is a few sentences, not the page.
const SNIPPET_CHARS: usize = 400;
const TIMEOUT: Duration = Duration::from_secs(20);
const TAVILY_URL: &str = "https://api.tavily.com/search";
const BRAVE_URL: &str = "https://api.search.brave.com/res/v1/web/search";

/// Tags out (Brave marks matches with `<strong>`), entities a model would read aloud decoded,
/// space collapsed, and cut.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    match out.char_indices().nth(SNIPPET_CHARS) {
        Some((at, _)) => format!("{}…", &out[..at]),
        None => out,
    }
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn hit(title: String, url: String, snippet: &str, published: Option<String>) -> Option<Hit> {
    (url.starts_with("http://") || url.starts_with("https://")).then(|| Hit {
        title: if title.trim().is_empty() {
            url.clone()
        } else {
            plain(&title)
        },
        url,
        snippet: plain(snippet),
        published: published.filter(|date| !date.trim().is_empty()),
    })
}

/// `{ "results": [ { "url", "title", "content", "publishedDate" } ] }`.
pub fn from_searxng(body: &Value) -> Vec<Hit> {
    let results = body.get("results").and_then(Value::as_array);
    results
        .into_iter()
        .flatten()
        .filter_map(|result| {
            hit(
                text_of(result, "title"),
                text_of(result, "url"),
                &text_of(result, "content"),
                result
                    .get("publishedDate")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )
        })
        .collect()
}

/// `{ "results": [ { "title", "url", "content", "published_date" } ] }`.
pub fn from_tavily(body: &Value) -> Vec<Hit> {
    let results = body.get("results").and_then(Value::as_array);
    results
        .into_iter()
        .flatten()
        .filter_map(|result| {
            hit(
                text_of(result, "title"),
                text_of(result, "url"),
                &text_of(result, "content"),
                result
                    .get("published_date")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )
        })
        .collect()
}

/// `{ "web": { "results": [ { "title", "url", "description", "age" } ] } }`.
pub fn from_brave(body: &Value) -> Vec<Hit> {
    let results = body.pointer("/web/results").and_then(Value::as_array);
    results
        .into_iter()
        .flatten()
        .filter_map(|result| {
            hit(
                text_of(result, "title"),
                text_of(result, "url"),
                &text_of(result, "description"),
                result.get("age").and_then(Value::as_str).map(str::to_owned),
            )
        })
        .collect()
}

/// Words for a provider's refusal: what the status means here, never the key.
fn refusal(provider: &Provider, status: reqwest::StatusCode) -> String {
    let name = provider.name();
    match (provider, status.as_u16()) {
        (Provider::Searxng { .. }, 403) => {
            format!("{name} answered 403: its settings.yml must list json under search: formats")
        }
        (Provider::Searxng { .. }, 429) => format!(
            "{name} answered 429: its limiter is turning the companion away (server: limiter: false, or the companion's address under botdetection pass_ip)"
        ),
        (_, 401 | 403) => format!("{name} refused the key in mcp.json ({status})"),
        (_, 429) => format!("{name} says too many searches for now ({status})"),
        (_, 432 | 433) => format!("{name} says the plan's searches are used up ({status})"),
        _ => format!("{name} answered {status}"),
    }
}

pub struct Searcher {
    provider: Provider,
    client: reqwest::Client,
    /// Tests point Tavily and Brave at a local server.
    base: Option<String>,
}

impl Searcher {
    pub fn new(provider: Provider) -> Result<Self, String> {
        Self::with_base(provider, None)
    }

    pub fn with_base(provider: Provider, base: Option<String>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!(
                "latentpresence-companion/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            provider,
            client,
            base,
        })
    }

    pub fn provider(&self) -> &Provider {
        &self.provider
    }

    pub async fn search(
        &self,
        query: &str,
        limit: usize,
        freshness: Option<Freshness>,
    ) -> Result<Vec<Hit>, String> {
        let request = match &self.provider {
            Provider::Searxng { url } => {
                let mut params = vec![("q", query.to_owned()), ("format", "json".to_owned())];
                // SearXNG has day, month and year; a week asks for the month.
                if let Some(range) = freshness.map(|fresh| match fresh {
                    Freshness::Day => "day",
                    Freshness::Week | Freshness::Month => "month",
                    Freshness::Year => "year",
                }) {
                    params.push(("time_range", range.to_owned()));
                }
                self.client
                    .get(format!("{}/search", url.trim_end_matches('/')))
                    .query(&params)
                    .header(reqwest::header::ACCEPT, "application/json")
                    // Its bot detection turns away a request with no language.
                    .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            }
            Provider::Tavily { key } => {
                let mut body = json!({
                    "query": query,
                    "max_results": limit,
                    "search_depth": "basic",
                    "include_answer": false,
                });
                if let Some(fresh) = freshness {
                    body["time_range"] = json!(match fresh {
                        Freshness::Day => "day",
                        Freshness::Week => "week",
                        Freshness::Month => "month",
                        Freshness::Year => "year",
                    });
                }
                self.client
                    .post(self.base.clone().unwrap_or_else(|| TAVILY_URL.to_owned()))
                    .bearer_auth(key)
                    .json(&body)
            }
            Provider::Brave { key } => {
                let mut params = vec![("q", query.to_owned()), ("count", limit.to_string())];
                if let Some(fresh) = freshness {
                    let code = match fresh {
                        Freshness::Day => "pd",
                        Freshness::Week => "pw",
                        Freshness::Month => "pm",
                        Freshness::Year => "py",
                    };
                    params.push(("freshness", code.to_owned()));
                }
                self.client
                    .get(self.base.clone().unwrap_or_else(|| BRAVE_URL.to_owned()))
                    .query(&params)
                    .header(reqwest::header::ACCEPT, "application/json")
                    .header("X-Subscription-Token", key)
            }
        };
        let name = self.provider.name();
        let response = request
            .send()
            .await
            .map_err(|error| format!("{name} could not be reached ({})", error.without_url()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(refusal(&self.provider, status));
        }
        let body: Value = response
            .json()
            .await
            .map_err(|error| format!("{name} answered something that is not JSON ({error})"))?;
        let mut hits = match self.provider {
            Provider::Searxng { .. } => from_searxng(&body),
            Provider::Tavily { .. } => from_tavily(&body),
            Provider::Brave { .. } => from_brave(&body),
        };
        hits.truncate(limit);
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_providers_answer_becomes_the_same_hits() {
        let searxng = json!({ "query": "weather", "results": [
            { "url": "https://weather.example/halifax", "title": "Halifax weather", "content": "Cloudy, 12 &deg;C.  Wind  SW", "publishedDate": null, "engine": "brave" },
            { "url": "javascript:alert(1)", "title": "no", "content": "" }
        ] });
        assert_eq!(
            from_searxng(&searxng),
            [Hit {
                title: "Halifax weather".into(),
                url: "https://weather.example/halifax".into(),
                snippet: "Cloudy, 12 &deg;C. Wind SW".into(),
                published: None
            }]
        );
        let tavily = json!({ "results": [{ "title": "Forecast", "url": "https://w.example/f", "content": "Rain later.", "score": 0.8, "published_date": "2026-10-11" }] });
        assert_eq!(
            from_tavily(&tavily)[0].published.as_deref(),
            Some("2026-10-11")
        );
        let brave = json!({ "web": { "results": [{ "title": "<strong>Halifax</strong> &amp; area", "url": "https://b.example/", "description": "It is <strong>cold</strong>.", "age": "2 hours ago" }] } });
        let hit = &from_brave(&brave)[0];
        assert_eq!(
            (
                hit.title.as_str(),
                hit.snippet.as_str(),
                hit.published.as_deref()
            ),
            ("Halifax & area", "It is cold.", Some("2 hours ago"))
        );
        assert!(from_brave(&json!({ "type": "search" })).is_empty());
    }

    #[test]
    fn a_long_snippet_is_cut_and_a_refusal_says_what_to_change_without_the_key() {
        let long = plain(&"word ".repeat(200));
        assert!(long.ends_with('…') && long.chars().count() <= SNIPPET_CHARS + 1);
        let searx = Provider::Searxng {
            url: "http://10.0.0.1:6699".into(),
        };
        assert!(refusal(&searx, reqwest::StatusCode::TOO_MANY_REQUESTS).contains("limiter"));
        assert!(refusal(&searx, reqwest::StatusCode::FORBIDDEN).contains("formats"));
        let tavily = Provider::Tavily {
            key: "tvly-secret".into(),
        };
        let said = refusal(&tavily, reqwest::StatusCode::UNAUTHORIZED);
        assert!(said.contains("refused the key") && !said.contains("tvly-secret"));
        assert_eq!(format!("{tavily:?}"), "Tavily");
    }
}
