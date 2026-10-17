//! `mcp.json`: the person's own list of MCP servers for the companion to run (ADR-43).
//!
//! The shape is the one other MCP clients already use, so an entry can be copied across:
//!
//! ```json
//! {
//!   "mcpServers": {
//!     "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] },
//!     "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } }
//!   },
//!   "files": { "roots": ["C:/Users/me/Documents/notes"] },
//!   "databases": {
//!     "shop": { "url": "postgres://reader:password@localhost/shop", "description": "orders and stock" },
//!     "garden": { "path": "C:/Users/me/garden.sqlite", "rowLimit": 50, "timeoutMs": 3000 }
//!   },
//!   "homeAssistant": { "url": "http://homeassistant.local:8123", "token": "<long-lived token>" }
//! }
//! ```
//!
//! It lives outside the repo — the OS config directory, or `COMPANION_MCP_CONFIG` — so a token
//! in it is never one `git add` away. Read once at start.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::sql::backend::Source;
use crate::secrets::Lookup;

/// The companion's own server: its name is not one the file can use.
pub const FILES_ID: &str = "files";

/// A database's server id: `sql:<name>`, never one an `mcpServers` name can be.
pub const SQL_PREFIX: &str = "sql:";

/// The companion's web server (P5-T06, ADR-47): its name is not one the file can use either.
pub const WEB_ID: &str = "web";

/// The person's Home Assistant (P5-T07, ADR-48): its name is reserved as well.
pub const HOME_ID: &str = "homeassistant";

/// `homeAssistant` in `mcp.json`: where HA is and a long-lived token. The companion speaks MCP to
/// `<url>/api/mcp`; the token never reaches the page and its `Debug` leaves it out.
#[derive(Clone, PartialEq, Eq)]
pub enum HomeSpec {
    Ready { endpoint: String, token: String },
    Invalid(String),
}

impl std::fmt::Debug for HomeSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ready { endpoint, .. } => write!(f, "HomeSpec::Ready {{ {endpoint} }}"),
            Self::Invalid(why) => write!(f, "HomeSpec::Invalid({why})"),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHome {
    url: String,
    /// Absent when the desktop app keeps it in Credential Manager (ADR-63).
    token: Option<String>,
}

impl RawHome {
    fn spec(self, secrets: Lookup<'_>) -> HomeSpec {
        let base = self.url.trim().trim_end_matches('/');
        let token = self
            .token
            .filter(|token| !token.trim().is_empty())
            .or_else(|| secrets(crate::secrets::HOME_TOKEN))
            .unwrap_or_default();
        let token = token.trim();
        if !(base.starts_with("http://") || base.starts_with("https://")) {
            return HomeSpec::Invalid(format!(
                "\"{base}\" is not an http(s) address, like http://homeassistant.local:8123"
            ));
        }
        if token.is_empty() {
            return HomeSpec::Invalid(
                "it needs a long-lived access token: in Home Assistant, your profile → Security → Long-lived access tokens → Create token"
                    .into(),
            );
        }
        let endpoint = if base.ends_with("/api/mcp") {
            base.to_owned()
        } else {
            format!("{base}/api/mcp")
        };
        HomeSpec::Ready {
            endpoint,
            token: token.to_owned(),
        }
    }
}

/// `web` in `mcp.json`: a search provider (the person's SearXNG, or Tavily or Brave with their
/// key), and whether she may read pages. The key is never printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebSpec {
    Ready {
        search: Option<super::web::search::Provider>,
        read_pages: bool,
    },
    Invalid(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawWeb {
    search: Option<RawSearch>,
    read_pages: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSearch {
    provider: String,
    url: Option<String>,
    key: Option<String>,
}

impl RawWeb {
    fn spec(self, secrets: Lookup<'_>) -> WebSpec {
        use super::web::search::Provider;
        let read_pages = self.read_pages.unwrap_or(true);
        let search = match self.search {
            None => None,
            Some(raw) => {
                let key = raw
                    .key
                    .filter(|key| !key.trim().is_empty())
                    .or_else(|| secrets(crate::secrets::WEB_SEARCH_KEY));
                match (
                    raw.provider.trim().to_ascii_lowercase().as_str(),
                    raw.url,
                    key,
                ) {
                    ("searxng", Some(url), _)
                        if url.starts_with("http://") || url.starts_with("https://") =>
                    {
                        Some(Provider::Searxng { url })
                    }
                    ("searxng", _, _) => {
                        return WebSpec::Invalid(
                            "searxng needs the url of the instance, http or https".into(),
                        );
                    }
                    ("tavily", _, Some(key)) => Some(Provider::Tavily { key }),
                    ("brave", _, Some(key)) => Some(Provider::Brave { key }),
                    ("tavily" | "brave", _, None) => {
                        return WebSpec::Invalid(format!("{} needs its key", raw.provider.trim()));
                    }
                    (other, _, _) => {
                        return WebSpec::Invalid(format!(
                            "search provider \"{other}\" is not searxng, tavily or brave"
                        ));
                    }
                }
            }
        };
        if search.is_none() && !read_pages {
            return WebSpec::Invalid(
                "it has no search and readPages is false, so there is nothing to offer".into(),
            );
        }
        WebSpec::Ready { search, read_pages }
    }
}

/// Rows a query returns unless the entry says otherwise, and the most it may say.
pub const DEFAULT_ROW_LIMIT: usize = 100;
const MAX_ROW_LIMIT: u64 = 1000;
/// How long a query may run unless the entry says otherwise, and the range it may say.
pub const DEFAULT_TIMEOUT_MS: u64 = 5000;
const TIMEOUT_RANGE: std::ops::RangeInclusive<u64> = 100..=60_000;

/// A database the person listed (P5-T05, ADR-46). Its address may hold a password, so its
/// `Debug` leaves the address out.
#[derive(Clone, PartialEq, Eq)]
pub enum DatabaseSpec {
    Ready {
        source: Source,
        description: Option<String>,
        row_limit: usize,
        timeout_ms: u64,
    },
    /// An entry the companion will not open, and why — reported as failed, not dropped.
    Invalid(String),
}

impl std::fmt::Debug for DatabaseSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ready {
                row_limit,
                timeout_ms,
                ..
            } => write!(
                f,
                "DatabaseSpec::Ready {{ rows: {row_limit}, timeout: {timeout_ms} ms }}"
            ),
            Self::Invalid(why) => write!(f, "DatabaseSpec::Invalid({why:?})"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerSpec {
    Stdio {
        command: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        headers: BTreeMap<String, String>,
    },
    /// An entry the companion will not run, and why — reported as failed, not dropped.
    Invalid(String),
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct McpConfig {
    /// By name, in name order; disabled entries are left out.
    pub servers: Vec<(String, ServerSpec)>,
    /// The folders the Files server may read. Empty: no Files server.
    pub roots: Vec<PathBuf>,
    /// The databases, by name, in name order; disabled entries are left out.
    pub databases: Vec<(String, DatabaseSpec)>,
    /// The web server, when `web` is in the file.
    pub web: Option<WebSpec>,
    /// Home Assistant, when `homeAssistant` is in the file.
    pub home: Option<HomeSpec>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, RawServer>,
    #[serde(default)]
    files: Option<RawFiles>,
    #[serde(default)]
    databases: BTreeMap<String, RawDatabase>,
    #[serde(default)]
    web: Option<RawWeb>,
    #[serde(default, rename = "homeAssistant")]
    home_assistant: Option<RawHome>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawDatabase {
    url: Option<String>,
    path: Option<PathBuf>,
    description: Option<String>,
    row_limit: Option<u64>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    disabled: bool,
}

impl RawDatabase {
    fn spec(mut self, name: &str, secrets: Lookup<'_>) -> DatabaseSpec {
        // Neither in the file: the desktop app keeps the address in Credential Manager (ADR-63).
        if self.url.is_none() && self.path.is_none() {
            self.url = secrets(&crate::secrets::database_url(name));
        }
        const SCHEMES: [&str; 5] = [
            "postgres://",
            "postgresql://",
            "mysql://",
            "mariadb://",
            "sqlite:",
        ];
        let source = match (self.url, self.path) {
            (Some(url), None) if SCHEMES.iter().any(|scheme| url.starts_with(scheme)) => {
                Source::Url(url)
            }
            // Only the scheme: the rest of an address may be a password.
            (Some(url), None) => {
                let scheme = url.split(':').next().unwrap_or("");
                return DatabaseSpec::Invalid(format!(
                    "its url starts \"{scheme}:\"; it must be postgres://, mysql://, mariadb:// or sqlite:"
                ));
            }
            (None, Some(path)) => Source::SqliteFile(path),
            (Some(_), Some(_)) => {
                return DatabaseSpec::Invalid("it has both a url and a path; give it one".into());
            }
            (None, None) => {
                return DatabaseSpec::Invalid("it needs a url, or a path to a SQLite file".into());
            }
        };
        let row_limit = self.row_limit.unwrap_or(DEFAULT_ROW_LIMIT as u64);
        if !(1..=MAX_ROW_LIMIT).contains(&row_limit) {
            return DatabaseSpec::Invalid(format!(
                "rowLimit {row_limit} is not between 1 and {MAX_ROW_LIMIT}"
            ));
        }
        let timeout_ms = self.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        if !TIMEOUT_RANGE.contains(&timeout_ms) {
            return DatabaseSpec::Invalid(format!(
                "timeoutMs {timeout_ms} is not between {} and {}",
                TIMEOUT_RANGE.start(),
                TIMEOUT_RANGE.end()
            ));
        }
        DatabaseSpec::Ready {
            source,
            description: self.description.filter(|text| !text.trim().is_empty()),
            row_limit: row_limit as usize,
            timeout_ms,
        }
    }
}

#[derive(Deserialize)]
struct RawFiles {
    #[serde(default)]
    roots: Vec<PathBuf>,
}

/// Unknown fields are allowed here: other clients' files carry their own (`type`, `timeout`).
#[derive(Deserialize)]
struct RawServer {
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    disabled: bool,
}

impl McpConfig {
    /// The file's text on its own terms: a secret it leaves out stays missing.
    pub fn parse(text: &str) -> Result<Self, String> {
        Self::parse_with(text, &crate::secrets::none)
    }

    /// The file's text, with each secret it leaves out looked up in `secrets` (ADR-63).
    pub fn parse_with(text: &str, secrets: Lookup<'_>) -> Result<Self, String> {
        let raw: RawConfig = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let servers = raw
            .mcp_servers
            .into_iter()
            .filter(|(_, server)| !server.disabled)
            .map(|(name, server)| {
                let spec = if name == FILES_ID || name == WEB_ID || name == HOME_ID {
                    ServerSpec::Invalid(format!(
                        "\"{name}\" is the companion's own server; give this one another name"
                    ))
                } else {
                    match (server.command, server.url) {
                        (Some(command), None) if !command.trim().is_empty() => ServerSpec::Stdio {
                            command,
                            args: server.args,
                            env: server.env,
                        },
                        (None, Some(url))
                            if url.starts_with("http://") || url.starts_with("https://") =>
                        {
                            ServerSpec::Http {
                                url,
                                headers: server.headers,
                            }
                        }
                        (None, Some(url)) => {
                            ServerSpec::Invalid(format!("\"{url}\" is not an http(s) address"))
                        }
                        (Some(_), Some(_)) => ServerSpec::Invalid(
                            "it has both a command and a url; give it one".to_owned(),
                        ),
                        _ => ServerSpec::Invalid("it needs a command or a url".to_owned()),
                    }
                };
                (name, spec)
            })
            .collect();
        Ok(Self {
            servers,
            roots: raw.files.map(|files| files.roots).unwrap_or_default(),
            databases: raw
                .databases
                .into_iter()
                .filter(|(_, database)| !database.disabled)
                .map(|(name, database)| {
                    let spec = database.spec(&name, secrets);
                    (name, spec)
                })
                .collect(),
            web: raw.web.map(|web| web.spec(secrets)),
            home: raw.home_assistant.map(|home| home.spec(secrets)),
        })
    }

    /// The file at `path`: none there is no servers; one that does not parse is an error. A
    /// secret it leaves out comes from the OS store (Credential Manager on Windows, ADR-63).
    pub fn load(path: &Path) -> Result<Self, String> {
        match read_config(path)? {
            Some(text) => Self::parse_with(&text, &crate::secrets::os)
                .map_err(|error| format!("{}: {error}", path.display())),
            None => Ok(Self::default()),
        }
    }
}

/// A config file's text, or `None` when there is no file. An empty one says what it is: Notepad
/// makes the file, empty, the moment it offers to create it, so a companion started before Save
/// read nothing (R-30: "EOF while parsing a value at line 1 column 0"). A byte-order mark, which
/// some editors write first, is dropped. Shared by `mcp.json` and `documents.json`.
pub fn read_config(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
            if text.trim().is_empty() {
                Err(format!(
                    "{} is empty: save it (Ctrl+S in Notepad), then restart the companion",
                    path.display()
                ))
            } else {
                Ok(Some(text.to_owned()))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// The file `file_name` the person keeps in the OS config directory's `latentPresence` folder,
/// or the path in the environment variable `env_var` when it is set: `mcp.json` with
/// `COMPANION_MCP_CONFIG` (here), `documents.json` with `COMPANION_DOCUMENTS_CONFIG`
/// (`ingest::config`, ADR-44).
pub fn config_path(file_name: &str, env_var: &str) -> Option<PathBuf> {
    let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    config_path_from(file_name, var(env_var), |name| var(name))
}

fn config_path_from(
    file_name: &str,
    explicit: Option<std::ffi::OsString>,
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return Some(PathBuf::from(path));
    }
    let base = if cfg!(windows) {
        var("APPDATA").map(PathBuf::from)
    } else {
        var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| var("HOME").map(|home| PathBuf::from(home).join(".config")))
    }?;
    Some(base.join("latentPresence").join(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shape_other_clients_write_and_says_what_is_wrong_with_an_entry() {
        let config = McpConfig::parse(
            r#"{
              "mcpServers": {
                "everything": { "command": "npx", "args": ["-y", "pkg"], "env": { "A": "1" }, "type": "stdio" },
                "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer t" } },
                "both": { "command": "x", "url": "https://example.com" },
                "neither": {},
                "ftp": { "url": "ftp://example.com" },
                "files": { "command": "x" },
                "off": { "command": "x", "disabled": true }
              },
              "files": { "roots": ["/home/me/notes"] }
            }"#,
        )
        .expect("parses");
        let names: Vec<&str> = config
            .servers
            .iter()
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            names,
            ["both", "everything", "files", "ftp", "neither", "remote"]
        );
        let spec = |name: &str| {
            config
                .servers
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, spec)| spec.clone())
                .expect("listed")
        };
        assert_eq!(
            spec("everything"),
            ServerSpec::Stdio {
                command: "npx".into(),
                args: vec!["-y".into(), "pkg".into()],
                env: BTreeMap::from([("A".into(), "1".into())])
            }
        );
        assert!(
            matches!(spec("remote"), ServerSpec::Http { url, headers } if url == "https://example.com/mcp" && headers["Authorization"] == "Bearer t")
        );
        for (name, why) in [
            ("both", "both a command and a url"),
            ("neither", "needs a command or a url"),
            ("ftp", "not an http(s) address"),
            ("files", "the companion's own server"),
        ] {
            assert!(
                matches!(spec(name), ServerSpec::Invalid(message) if message.contains(why)),
                "{name}"
            );
        }
        assert_eq!(config.roots, [PathBuf::from("/home/me/notes")]);
    }

    #[test]
    fn databases_are_read_with_their_limits_and_a_bad_entry_says_why_without_its_address() {
        let config = McpConfig::parse(
            r#"{
              "databases": {
                "shop": { "url": "postgres://reader:s3cret@db/shop", "description": "orders" },
                "garden": { "path": "C:/garden.sqlite", "rowLimit": 50, "timeoutMs": 3000 },
                "odd": { "url": "oracle://reader:s3cret@db" },
                "greedy": { "url": "mysql://db/x", "rowLimit": 100000 },
                "both": { "url": "sqlite:x.db", "path": "x.db" },
                "none": {},
                "off": { "url": "mysql://db/x", "disabled": true }
              }
            }"#,
        )
        .expect("parses");
        let spec = |name: &str| {
            config
                .databases
                .iter()
                .find(|(candidate, _)| candidate == name)
                .map(|(_, spec)| spec.clone())
                .expect("listed")
        };
        assert_eq!(config.databases.len(), 6);
        assert_eq!(
            spec("shop"),
            DatabaseSpec::Ready {
                source: Source::Url("postgres://reader:s3cret@db/shop".into()),
                description: Some("orders".into()),
                row_limit: DEFAULT_ROW_LIMIT,
                timeout_ms: DEFAULT_TIMEOUT_MS
            }
        );
        assert!(matches!(
            spec("garden"),
            DatabaseSpec::Ready {
                row_limit: 50,
                timeout_ms: 3000,
                ..
            }
        ));
        for (name, why) in [
            ("odd", "starts \"oracle:\""),
            ("greedy", "rowLimit 100000"),
            ("both", "both a url and a path"),
            ("none", "needs a url"),
        ] {
            assert!(
                matches!(spec(name), DatabaseSpec::Invalid(message) if message.contains(why) && !message.contains("s3cret")),
                "{name}"
            );
        }
        assert!(!format!("{config:?}").contains("s3cret"));
        // A misspelt limit is an error, not a limit silently ignored.
        assert!(
            McpConfig::parse(r#"{ "databases": { "x": { "url": "sqlite:x", "rowlimit": 5 } } }"#)
                .is_err()
        );
    }

    #[test]
    fn the_web_entry_names_a_provider_and_says_what_is_missing_without_the_key() {
        use crate::mcp::web::search::Provider;
        let web = |json: &str| McpConfig::parse(json).expect("parses").web;
        assert_eq!(
            web(
                r#"{ "web": { "search": { "provider": "SearXNG", "url": "http://10.0.0.1:6699" } } }"#
            ),
            Some(WebSpec::Ready {
                search: Some(Provider::Searxng {
                    url: "http://10.0.0.1:6699".into()
                }),
                read_pages: true
            })
        );
        assert_eq!(
            web(
                r#"{ "web": { "search": { "provider": "tavily", "key": "tvly-s3cret" }, "readPages": false } }"#
            ),
            Some(WebSpec::Ready {
                search: Some(Provider::Tavily {
                    key: "tvly-s3cret".into()
                }),
                read_pages: false
            })
        );
        assert_eq!(
            web(r#"{ "web": {} }"#),
            Some(WebSpec::Ready {
                search: None,
                read_pages: true
            })
        );
        assert_eq!(web("{}"), None);
        for (json, says) in [
            (
                r#"{ "web": { "search": { "provider": "brave" } } }"#,
                "brave needs its key",
            ),
            (
                r#"{ "web": { "search": { "provider": "searxng" } } }"#,
                "needs the url",
            ),
            (
                r#"{ "web": { "search": { "provider": "bing", "key": "k" } } }"#,
                "\"bing\" is not",
            ),
            (r#"{ "web": { "readPages": false } }"#, "nothing to offer"),
        ] {
            assert!(
                matches!(web(json), Some(WebSpec::Invalid(why)) if why.contains(says)),
                "{json}"
            );
        }
        let printed = format!(
            "{:?}",
            McpConfig::parse(
                r#"{ "web": { "search": { "provider": "tavily", "key": "tvly-s3cret" } } }"#
            )
        );
        assert!(!printed.contains("s3cret"), "{printed}");
        let named =
            McpConfig::parse(r#"{ "mcpServers": { "web": { "command": "x" } } }"#).expect("parses");
        assert!(
            matches!(&named.servers[0].1, ServerSpec::Invalid(why) if why.contains("\"web\" is the companion's own"))
        );
    }

    #[test]
    fn home_assistant_is_its_address_and_a_token_never_printed() {
        let home = |json: &str| McpConfig::parse(json).expect("parses").home;
        let ready = |endpoint: &str| {
            Some(HomeSpec::Ready {
                endpoint: endpoint.into(),
                token: "eyJs3cret".into(),
            })
        };
        assert_eq!(
            home(
                r#"{ "homeAssistant": { "url": "http://homeassistant.local:8123/", "token": " eyJs3cret " } }"#
            ),
            ready("http://homeassistant.local:8123/api/mcp")
        );
        // The whole MCP address, as HA's own page gives it, is taken as it is.
        assert_eq!(
            home(
                r#"{ "homeAssistant": { "url": "https://ha.example.net/api/mcp", "token": "eyJs3cret" } }"#
            ),
            ready("https://ha.example.net/api/mcp")
        );
        assert_eq!(home("{}"), None);
        for (json, says) in [
            (
                r#"{ "homeAssistant": { "url": "homeassistant.local:8123", "token": "t" } }"#,
                "not an http(s) address",
            ),
            (
                r#"{ "homeAssistant": { "url": "http://ha:8123", "token": "  " } }"#,
                "Long-lived access tokens",
            ),
        ] {
            assert!(
                matches!(home(json), Some(HomeSpec::Invalid(why)) if why.contains(says)),
                "{json}"
            );
        }
        // No token in the file (ADR-63: the app keeps it in Credential Manager): read, and with
        // nothing in the store either, the entry says what it lacks.
        assert!(matches!(
            home(r#"{ "homeAssistant": { "url": "http://ha:8123" } }"#),
            Some(HomeSpec::Invalid(why)) if why.contains("Long-lived access tokens")
        ));
        assert!(matches!(
            McpConfig::parse_with(r#"{ "homeAssistant": { "url": "http://ha:8123" } }"#, &|account| {
                (account == crate::secrets::HOME_TOKEN).then(|| "from-the-store".to_owned())
            })
            .unwrap()
            .home,
            Some(HomeSpec::Ready { token, .. }) if token == "from-the-store"
        ));
        let printed = format!(
            "{:?}",
            McpConfig::parse(
                r#"{ "homeAssistant": { "url": "http://ha:8123", "token": "eyJs3cret" } }"#
            )
        );
        assert!(!printed.contains("s3cret"), "{printed}");
        let named =
            McpConfig::parse(r#"{ "mcpServers": { "homeassistant": { "url": "http://x" } } }"#)
                .expect("parses");
        assert!(
            matches!(&named.servers[0].1, ServerSpec::Invalid(why) if why.contains("companion's own"))
        );
    }

    #[test]
    fn no_file_is_no_servers_and_a_broken_file_is_an_error() {
        let missing = std::env::temp_dir().join("latentpresence-no-such-mcp.json");
        assert_eq!(McpConfig::load(&missing), Ok(McpConfig::default()));
        assert!(McpConfig::parse("{ \"mcpServers\": ").is_err());
        assert!(McpConfig::parse("{ \"servers\": {} }").is_err());
    }

    #[test]
    fn the_file_is_the_one_named_or_in_the_os_config_directory() {
        assert_eq!(
            config_path_from("mcp.json", Some("/tmp/x.json".into()), |_| None),
            Some(PathBuf::from("/tmp/x.json"))
        );
        let found = config_path_from("mcp.json", None, |name| match name {
            "APPDATA" => Some("C:\\Users\\me\\AppData\\Roaming".into()),
            "XDG_CONFIG_HOME" => Some("/home/me/.xdg".into()),
            _ => None,
        })
        .expect("a path");
        assert!(found.ends_with(Path::new("latentPresence").join("mcp.json")));
        // The same lookup finds the documents file beside it.
        let beside = config_path_from("documents.json", None, |name| match name {
            "APPDATA" => Some("C:\\Users\\me\\AppData\\Roaming".into()),
            "XDG_CONFIG_HOME" => Some("/home/me/.xdg".into()),
            _ => None,
        })
        .expect("a path");
        assert_eq!(beside.parent(), found.parent());
        assert!(beside.ends_with("documents.json"));
        if cfg!(windows) {
            assert!(found.starts_with("C:\\Users\\me\\AppData\\Roaming"));
        } else {
            assert!(found.starts_with("/home/me/.xdg"));
        }
    }
}
