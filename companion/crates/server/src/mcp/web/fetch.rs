//! `read_page`'s fetch (ADR-47): any page on the public internet, nothing on this machine or its
//! network. The address comes from a model — which reads web pages that can say anything — so
//! "read http://192.168.1.1/admin" must be impossible, not merely unlikely.
//!
//! - **Every address is checked after DNS**, by the client's own resolver: a name that resolves
//!   to a private address is no address, and the connection goes to the address that was
//!   checked, so a name cannot answer public to the check and private to the connect.
//! - **A literal IP in the URL, and in every redirect**, is checked the same way (a literal
//!   address never reaches a resolver). Five redirects at most, http and https only.
//! - **No proxy**: a proxy would resolve the name itself, past the check.
//! - **Text only, 2 MB at most**: HTML (to text, as ingestion reads it), XHTML or plain text.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Url;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect::{Action, Attempt, Policy};

/// A page larger than this is read to here.
pub const PAGE_LIMIT: usize = 2 * 1024 * 1024;
const REDIRECTS: usize = 5;
const TIMEOUT: Duration = Duration::from_secs(20);

/// Whether an address is somewhere on the internet rather than this machine or its network.
/// `IpAddr::is_global` is unstable, so the reserved ranges are listed here (IANA special-purpose
/// registries, 2026).
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] & 0xffc0) == 0xfec0 // site-local fec0::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64: an IPv4 address inside
                || (s[0] == 0x2002) // 6to4: an IPv4 address inside
                || (s[0] == 0x2001 && s[1] == 0)) // Teredo
        }
    }
}

fn public_v4(v4: Ipv4Addr) -> bool {
    let [a, b, c, _] = v4.octets();
    !(v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_multicast()
        || v4.is_documentation()
        || a == 0
        || (a == 100 && (64..=127).contains(&b)) // shared address space (CGNAT)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240) // reserved
}

/// The client's resolver: the system's answer, with every non-public address taken out.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let public: Vec<SocketAddr> = found
                .iter()
                .copied()
                .filter(|addr| is_public(addr.ip()))
                .collect();
            if public.is_empty() {
                let why = if found.is_empty() {
                    format!("{host} has no address")
                } else {
                    format!("{host} is on this computer or its network, not the internet")
                };
                return Err(why.into());
            }
            let addrs: Addrs = Box::new(public.into_iter());
            Ok(addrs)
        })
    }
}

/// Why a URL may not be fetched, before any connection: the scheme, a password in it, or a
/// literal address that is not public.
pub fn refused(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Some(format!(
            "only http and https pages can be read, not {}:",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Some("an address with a user name or password in it is not read".into());
    }
    match url.host() {
        None => Some("the address has no host".into()),
        Some(url::Host::Ipv4(ip)) if !is_public(IpAddr::V4(ip)) => Some(format!(
            "{ip} is on this computer or its network, not the internet"
        )),
        Some(url::Host::Ipv6(ip)) if !is_public(IpAddr::V6(ip)) => Some(format!(
            "{ip} is on this computer or its network, not the internet"
        )),
        // `localhost` and its kind resolve to loopback: the resolver refuses them.
        Some(_) => None,
    }
}

fn redirect(attempt: Attempt) -> Action {
    if attempt.previous().len() >= REDIRECTS {
        return attempt.error(format!("more than {REDIRECTS} redirects"));
    }
    match refused(attempt.url()) {
        Some(why) => attempt.error(format!("it redirected somewhere it may not go: {why}")),
        None => attempt.follow(),
    }
}

/// A page read: its title, its text, and where it ended up.
#[derive(Debug)]
pub struct Fetched {
    pub title: String,
    pub text: String,
    pub url: Url,
    pub cut: bool,
}

pub struct Fetcher {
    client: reqwest::Client,
}

impl Fetcher {
    /// `guarded: false` only in tests, which serve pages from loopback.
    pub fn new(guarded: bool) -> Result<Self, String> {
        let mut builder = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .no_proxy()
            .user_agent(concat!(
                "latentpresence-companion/",
                env!("CARGO_PKG_VERSION"),
                " (reading a page for its user)"
            ));
        if guarded {
            builder = builder
                .dns_resolver(Arc::new(PublicOnly))
                .redirect(Policy::custom(redirect));
        }
        builder
            .build()
            .map(|client| Self { client })
            .map_err(|error| error.to_string())
    }

    pub async fn fetch(&self, address: &str, guarded: bool) -> Result<Fetched, String> {
        let url = Url::parse(address.trim())
            .map_err(|error| format!("that is not a web address ({error})"))?;
        if guarded && let Some(why) = refused(&url) {
            return Err(why);
        }
        let response = self
            .client
            .get(url)
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,text/plain;q=0.9",
            )
            .send()
            .await
            .map_err(|error| {
                // The resolver's and the redirect policy's words are in the error's sources.
                let mut why = error.to_string();
                let mut source = std::error::Error::source(&error);
                while let Some(inner) = source {
                    why = inner.to_string();
                    source = inner.source();
                }
                format!("it could not be read: {why}")
            })?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the page answered {status}"));
        }
        let url = response.url().clone();
        let kind = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("text/html")
            .to_ascii_lowercase();
        let html = kind.starts_with("text/html") || kind.starts_with("application/xhtml");
        if !html && !kind.starts_with("text/plain") {
            return Err(format!("it is not a page of text ({kind})"));
        }
        let mut body = Vec::new();
        let mut cut = false;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("it stopped arriving: {error}"))?;
            let room = PAGE_LIMIT - body.len();
            if chunk.len() >= room {
                body.extend_from_slice(&chunk[..room]);
                cut = true;
                break;
            }
            body.extend_from_slice(&chunk);
        }
        let host = url.host_str().unwrap_or("the page").to_owned();
        let (title, text) = if html {
            let extracted = latentpresence_ingest::extract_bytes(Path::new("page.html"), &body)?;
            let title = if extracted.title == "page" {
                host
            } else {
                extracted.title
            };
            let text = extracted
                .pages
                .into_iter()
                .map(|page| page.text)
                .collect::<Vec<_>>()
                .join("\n");
            (title, text)
        } else {
            (host, String::from_utf8_lossy(&body).into_owned())
        };
        Ok(Fetched {
            title,
            text,
            url,
            cut,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_machine_and_its_network_are_not_public() {
        for private in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.4.2",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "198.18.0.1",
            "192.0.0.8",
            "240.0.0.1",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "2001:db8::1",
        ] {
            let ip: IpAddr = private.parse().expect("an address");
            assert!(!is_public(ip), "{private} counted as public");
        }
        for public in [
            "1.1.1.1",
            "93.184.215.14",
            "8.8.8.8",
            "2606:4700:4700::1111",
            "::ffff:1.1.1.1",
        ] {
            let ip: IpAddr = public.parse().expect("an address");
            assert!(is_public(ip), "{public} counted as private");
        }
    }

    #[test]
    fn a_url_is_refused_before_any_connection_for_its_scheme_password_or_literal_address() {
        let why = |address: &str| refused(&Url::parse(address).expect("parses"));
        assert_eq!(why("https://example.com/weather"), None);
        assert_eq!(why("http://localhost:8787/"), None); // the resolver's to refuse
        for (address, says) in [
            ("file:///C:/Windows/win.ini", "not file:"),
            ("ftp://example.com/x", "not ftp:"),
            (
                "http://127.0.0.1:8787/health",
                "127.0.0.1 is on this computer",
            ),
            ("http://10.0.0.1:6699/", "10.0.0.1 is on this computer"),
            ("http://[::1]/", "::1 is on this computer"),
            (
                "http://169.254.169.254/latest/meta-data/",
                "169.254.169.254",
            ),
            ("http://2130706433/", "127.0.0.1"), // the decimal form of 127.0.0.1
            ("http://user:pass@example.com/", "user name or password"),
        ] {
            let refusal = why(address).unwrap_or_default();
            assert!(refusal.contains(says), "{address}: {refusal:?}");
        }
    }

    #[tokio::test]
    async fn localhost_by_name_is_refused_by_the_resolver() {
        let fetcher = Fetcher::new(true).expect("builds");
        let error = fetcher
            .fetch("http://localhost:9/", true)
            .await
            .expect_err("refused");
        assert!(
            error.contains("is on this computer or its network"),
            "{error}"
        );
    }
}
