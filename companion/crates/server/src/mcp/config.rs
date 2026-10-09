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
//!   "files": { "roots": ["C:/Users/me/Documents/notes"] }
//! }
//! ```
//!
//! It lives outside the repo — the OS config directory, or `COMPANION_MCP_CONFIG` — so a token
//! in it is never one `git add` away. Read once at start.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The companion's own server: its name is not one the file can use.
pub const FILES_ID: &str = "files";

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
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: BTreeMap<String, RawServer>,
    #[serde(default)]
    files: Option<RawFiles>,
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
