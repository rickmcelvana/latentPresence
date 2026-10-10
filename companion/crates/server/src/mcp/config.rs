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
//!   }
//! }
//! ```
//!
//! It lives outside the repo — the OS config directory, or `COMPANION_MCP_CONFIG` — so a token
//! in it is never one `git add` away. Read once at start.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::sql::backend::Source;

/// The companion's own server: its name is not one the file can use.
pub const FILES_ID: &str = "files";

/// A database's server id: `sql:<name>`, never one an `mcpServers` name can be.
pub const SQL_PREFIX: &str = "sql:";

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
    fn spec(self) -> DatabaseSpec {
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
    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: RawConfig = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let servers = raw
            .mcp_servers
            .into_iter()
            .filter(|(_, server)| !server.disabled)
            .map(|(name, server)| {
                let spec = if name == FILES_ID {
                    ServerSpec::Invalid(format!(
                        "\"{FILES_ID}\" is the companion's own server; give this one another name"
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
                .map(|(name, database)| (name, database.spec()))
                .collect(),
        })
    }

    /// The file at `path`: none there is no servers; one that does not parse is an error.
    pub fn load(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text).map_err(|error| format!("{}: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
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
