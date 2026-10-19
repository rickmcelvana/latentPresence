//! Editing `mcp.json` and `documents.json` from the desktop app (P8-T06, ADR-63).
//!
//! The files stay what they were (ADR-43, ADR-44): in the OS config folder, read by the companion
//! at start, editable by hand. The app reads them through `view` and changes them through
//! `apply`, one `Change` at a time, so that a person never has to open them. Three rules:
//!
//! - **Only the safe sections.** Home Assistant, the folders the Files server may read, web
//!   search, the databases, and the documents' folders and embedding. `mcpServers` — entries
//!   that start programs — are shown, never written: a page that could add one could run anything.
//! - **The page never names a folder.** `Change` has no "add folder": `add_root` and
//!   `add_documents_folder` are called by the desktop shell with a path the person picked in the
//!   system's folder dialog (ADR-44's guarantee, kept).
//! - **No secret is written into a file.** A token, a key or a database address goes to the OS
//!   store, and a secret found in the file is moved there when its section is saved. The
//!   companion looks a missing one up there (`secrets`), so a hand-edited file still works.
//!
//! Every change is checked with the companion's own parsers before anything is written: a change
//! the companion would refuse is refused here, in the companion's words. Unknown fields are kept.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::ingest::config::DocumentsConfig;
use crate::mcp::config::{DatabaseSpec, HomeSpec, McpConfig, WebSpec, read_config};
use crate::secrets;

/// Where the two files are.
#[derive(Debug, Clone)]
pub struct ConfigFiles {
    pub mcp: PathBuf,
    pub documents: PathBuf,
}

impl ConfigFiles {
    /// The paths the companion itself reads (`config_path`), or `None` when the OS gives none.
    pub fn locate() -> Option<Self> {
        Some(Self {
            mcp: crate::mcp::config::config_path("mcp.json", "COMPANION_MCP_CONFIG")?,
            documents: crate::mcp::config::config_path(
                "documents.json",
                "COMPANION_DOCUMENTS_CONFIG",
            )?,
        })
    }
}

/// Where a secret lives. The OS store in the app; a map in a test.
pub trait SecretStore {
    fn get(&self, account: &str) -> Option<String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// Windows Credential Manager, under the companion's service (`secrets::SERVICE`).
pub struct OsStore;

#[cfg(windows)]
impl SecretStore for OsStore {
    fn get(&self, account: &str) -> Option<String> {
        secrets::os(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        keyring::v1::Entry::new(secrets::SERVICE, account)
            .and_then(|entry| entry.set_password(value))
            .map_err(|error| error.to_string())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        match keyring::v1::Entry::new(secrets::SERVICE, account)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(not(windows))]
impl SecretStore for OsStore {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("there is no secret store on this system".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Where a secret is, as the page may know it: never its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretState {
    /// Nowhere: the entry will say what it lacks.
    Missing,
    /// Written in the file, in plain text: saving the section moves it to the store.
    InFile,
    /// In the OS store.
    Stored,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeView {
    pub url: String,
    pub token: SecretState,
    /// What the companion would say about it, when it would refuse it.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebView {
    /// `searxng`, `tavily` or `brave`; `None` without search.
    pub provider: Option<String>,
    /// SearXNG's address.
    pub url: Option<String>,
    pub key: SecretState,
    pub read_pages: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseView {
    pub name: String,
    pub description: Option<String>,
    /// The address without its password, when there is one to show.
    pub address: Option<String>,
    /// A SQLite file's path.
    pub path: Option<String>,
    pub secret: SecretState,
    pub disabled: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub name: String,
    /// The command line or the address, for a person to recognise it; never a header or an env value.
    pub summary: String,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingView {
    pub base_url: String,
    pub model: String,
    pub dimensions: u32,
    #[serde(default)]
    pub document_prefix: String,
    #[serde(default)]
    pub query_prefix: String,
}

/// Everything the app shows about the two files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub mcp_path: String,
    pub documents_path: String,
    /// A file that does not parse, in the companion's words. Its sections then show as empty and
    /// cannot be changed here until it is fixed by hand.
    pub problems: Vec<String>,
    pub home: Option<HomeView>,
    pub roots: Vec<String>,
    pub web: Option<WebView>,
    pub databases: Vec<DatabaseView>,
    pub servers: Vec<ServerView>,
    pub folders: Vec<String>,
    pub embedding: Option<EmbeddingView>,
}

/// One change the page may ask for. There is no way here to add a folder or a program.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    /// Home Assistant at `url`. `token`: a new one; absent, keep the one there is (and move it out
    /// of the file if it is in it).
    Home {
        url: String,
        token: Option<String>,
    },
    /// No Home Assistant; its token is forgotten.
    RemoveHome,
    /// Web search and page reading. `key` as `token` above; `url` for SearXNG.
    Web {
        provider: Option<String>,
        url: Option<String>,
        key: Option<String>,
        read_pages: bool,
    },
    RemoveWeb,
    RemoveRoot {
        path: String,
    },
    /// A database by address (`postgres://`, `mysql://`, `mariadb://`); the address goes to the store.
    AddDatabase {
        name: String,
        url: String,
        description: Option<String>,
    },
    RemoveDatabase {
        name: String,
    },
    /// A database whose address is written in the file: the address moves to the store.
    StoreDatabase {
        name: String,
    },
    RemoveDocumentsFolder {
        path: String,
    },
    /// The documents' embedding endpoint, or none (keyword search only).
    Embedding {
        embedding: Option<EmbeddingView>,
    },
}

fn read_json(path: &Path) -> Result<Value, String> {
    match read_config(path)? {
        None => Ok(Value::Object(Map::new())),
        Some(text) => {
            let value: Value = serde_json::from_str(&text)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            if value.is_object() {
                Ok(value)
            } else {
                Err(format!("{}: it is not a JSON object", path.display()))
            }
        }
    }
}

/// Written whole, through a file beside it, so a crash never leaves half a file.
fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    }
    let mut text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    text.push('\n');
    let temporary = path.with_extension("json.saving");
    std::fs::write(&temporary, text)
        .map_err(|error| format!("{}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("{}: {error}", path.display()))
}

fn string_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

fn secret_state(in_file: bool, store: &dyn SecretStore, account: &str) -> SecretState {
    if in_file {
        SecretState::InFile
    } else if store.get(account).is_some() {
        SecretState::Stored
    } else {
        SecretState::Missing
    }
}

/// An address with its password left out; anything that does not parse shows only its scheme.
pub fn redact(address: &str) -> String {
    match url::Url::parse(address) {
        Ok(mut parsed) => {
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        Err(_) => format!("{}:…", address.split(':').next().unwrap_or("")),
    }
}

fn lookup(store: &dyn SecretStore) -> impl Fn(&str) -> Option<String> + '_ {
    move |account| store.get(account)
}

/// What the files say, for the app: secrets as where they are, never what they are.
pub fn view(files: &ConfigFiles, store: &dyn SecretStore) -> ConfigView {
    let mut problems = Vec::new();
    let mcp = read_json(&files.mcp).unwrap_or_else(|error| {
        problems.push(error);
        Value::Object(Map::new())
    });
    let documents = read_json(&files.documents).unwrap_or_else(|error| {
        problems.push(error);
        Value::Object(Map::new())
    });
    // The companion's own reading, for its verdict on each entry.
    let parsed = serde_json::to_string(&mcp).ok().and_then(|text| {
        match McpConfig::parse_with(&text, &lookup(store)) {
            Ok(config) => Some(config),
            Err(error) => {
                problems.push(format!("{}: {error}", files.mcp.display()));
                None
            }
        }
    });

    let home = mcp.get("homeAssistant").map(|_| HomeView {
        url: string_at(&mcp, "/homeAssistant/url")
            .unwrap_or_default()
            .to_owned(),
        token: secret_state(
            string_at(&mcp, "/homeAssistant/token").is_some(),
            store,
            secrets::HOME_TOKEN,
        ),
        problem: match parsed.as_ref().and_then(|config| config.home.as_ref()) {
            Some(HomeSpec::Invalid(why)) => Some(why.clone()),
            _ => None,
        },
    });

    let web = mcp.get("web").map(|_| WebView {
        provider: string_at(&mcp, "/web/search/provider").map(str::to_ascii_lowercase),
        url: string_at(&mcp, "/web/search/url").map(str::to_owned),
        key: secret_state(
            string_at(&mcp, "/web/search/key").is_some(),
            store,
            secrets::WEB_SEARCH_KEY,
        ),
        read_pages: mcp
            .pointer("/web/readPages")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        problem: match parsed.as_ref().and_then(|config| config.web.as_ref()) {
            Some(WebSpec::Invalid(why)) => Some(why.clone()),
            _ => None,
        },
    });

    let databases = mcp
        .get("databases")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(name, entry)| {
                    let url = entry.get("url").and_then(Value::as_str);
                    let path = entry.get("path").and_then(Value::as_str);
                    let account = secrets::database_url(name);
                    let stored = store.get(&account);
                    let address = url.or(stored.as_deref()).map(redact);
                    DatabaseView {
                        name: name.clone(),
                        description: entry
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        address: if path.is_some() { None } else { address },
                        path: path.map(str::to_owned),
                        secret: if path.is_some() {
                            SecretState::Missing
                        } else {
                            secret_state(url.is_some(), store, &account)
                        },
                        disabled: entry
                            .get("disabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        problem: parsed.as_ref().and_then(|config| {
                            config
                                .databases
                                .iter()
                                .find_map(|(found, spec)| match spec {
                                    DatabaseSpec::Invalid(why) if found == name => {
                                        Some(why.clone())
                                    }
                                    _ => None,
                                })
                        }),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let servers = mcp
        .get("mcpServers")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .map(|(name, entry)| {
                    let summary = match (
                        entry.get("command").and_then(Value::as_str),
                        entry.get("url").and_then(Value::as_str),
                    ) {
                        (Some(command), _) => {
                            let args: Vec<&str> = entry
                                .get("args")
                                .and_then(Value::as_array)
                                .map(|args| args.iter().filter_map(Value::as_str).collect())
                                .unwrap_or_default();
                            std::iter::once(command)
                                .chain(args)
                                .collect::<Vec<_>>()
                                .join(" ")
                        }
                        (None, Some(url)) => redact(url),
                        (None, None) => String::new(),
                    };
                    ServerView {
                        name: name.clone(),
                        summary,
                        disabled: entry
                            .get("disabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    let strings = |value: &Value, pointer: &str| -> Vec<String> {
        value
            .pointer(pointer)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };

    ConfigView {
        mcp_path: files.mcp.display().to_string(),
        documents_path: files.documents.display().to_string(),
        problems,
        home,
        roots: strings(&mcp, "/files/roots"),
        web,
        databases,
        servers,
        folders: strings(&documents, "/folders"),
        embedding: documents
            .get("embedding")
            .and_then(|embedding| serde_json::from_value(embedding.clone()).ok()),
    }
}

fn object<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    let root = value.as_object_mut().expect("read_json returns an object");
    let entry = root
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().expect("just made an object")
}

fn remove(value: &mut Value, key: &str) {
    if let Some(root) = value.as_object_mut() {
        root.remove(key);
    }
}

/// A secret given now, or the one in the file moved out of it, goes to the store; `None` keeps
/// what the store has.
fn settle_secret(
    store: &dyn SecretStore,
    account: &str,
    given: Option<&str>,
    in_file: Option<String>,
) -> Result<(), String> {
    match given.map(str::trim).filter(|text| !text.is_empty()) {
        Some(secret) => store.set(account, secret),
        None => match in_file {
            Some(secret) => store.set(account, &secret),
            None => Ok(()),
        },
    }
}

fn check_mcp(
    value: &Value,
    store: &dyn SecretStore,
    pending: &[(&str, &str)],
) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    let with_pending = |account: &str| {
        pending
            .iter()
            .find(|(name, _)| *name == account)
            .map(|(_, secret)| (*secret).to_owned())
            .or_else(|| store.get(account))
    };
    let config = McpConfig::parse_with(&text, &with_pending)?;
    if let Some(HomeSpec::Invalid(why)) = &config.home {
        return Err(format!("Home Assistant: {why}"));
    }
    if let Some(WebSpec::Invalid(why)) = &config.web {
        return Err(format!("Web: {why}"));
    }
    if let Some((name, DatabaseSpec::Invalid(why))) = config
        .databases
        .iter()
        .find(|(_, spec)| matches!(spec, DatabaseSpec::Invalid(_)))
    {
        return Err(format!("Database \"{name}\": {why}"));
    }
    Ok(())
}

fn valid_database_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Applies one change: checked with the companion's parsers first, then written, secrets to the
/// store. A refused change writes nothing.
pub fn apply(files: &ConfigFiles, change: Change, store: &dyn SecretStore) -> Result<(), String> {
    match change {
        Change::Home { url, token } => {
            let mut mcp = read_json(&files.mcp)?;
            let in_file = string_at(&mcp, "/homeAssistant/token").map(str::to_owned);
            let section = object(&mut mcp, "homeAssistant");
            section.insert("url".into(), Value::String(url.trim().to_owned()));
            section.remove("token");
            let pending = token
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .or(in_file.as_deref());
            let pending: Vec<(&str, &str)> = pending
                .map(|secret| vec![(secrets::HOME_TOKEN, secret)])
                .unwrap_or_default();
            check_mcp(&mcp, store, &pending)?;
            settle_secret(store, secrets::HOME_TOKEN, token.as_deref(), in_file)?;
            write_json(&files.mcp, &mcp)
        }
        Change::RemoveHome => {
            let mut mcp = read_json(&files.mcp)?;
            remove(&mut mcp, "homeAssistant");
            write_json(&files.mcp, &mcp)?;
            store.delete(secrets::HOME_TOKEN)
        }
        Change::Web {
            provider,
            url,
            key,
            read_pages,
        } => {
            let mut mcp = read_json(&files.mcp)?;
            let in_file = string_at(&mcp, "/web/search/key").map(str::to_owned);
            let section = object(&mut mcp, "web");
            section.insert("readPages".into(), Value::Bool(read_pages));
            match provider.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                None => {
                    section.remove("search");
                }
                Some(provider) => {
                    let mut search = Map::new();
                    search.insert(
                        "provider".into(),
                        Value::String(provider.to_ascii_lowercase()),
                    );
                    if let Some(url) = url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
                        search.insert("url".into(), Value::String(url.to_owned()));
                    }
                    section.insert("search".into(), Value::Object(search));
                }
            }
            let pending = key
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .or(in_file.as_deref());
            let pending: Vec<(&str, &str)> = pending
                .map(|secret| vec![(secrets::WEB_SEARCH_KEY, secret)])
                .unwrap_or_default();
            check_mcp(&mcp, store, &pending)?;
            settle_secret(store, secrets::WEB_SEARCH_KEY, key.as_deref(), in_file)?;
            write_json(&files.mcp, &mcp)
        }
        Change::RemoveWeb => {
            let mut mcp = read_json(&files.mcp)?;
            remove(&mut mcp, "web");
            write_json(&files.mcp, &mcp)?;
            store.delete(secrets::WEB_SEARCH_KEY)
        }
        Change::RemoveRoot { path } => {
            let mut mcp = read_json(&files.mcp)?;
            let files_section = object(&mut mcp, "files");
            if let Some(roots) = files_section.get_mut("roots").and_then(Value::as_array_mut) {
                roots.retain(|root| root.as_str() != Some(path.as_str()));
            }
            write_json(&files.mcp, &mcp)
        }
        Change::AddDatabase {
            name,
            url,
            description,
        } => {
            let name = name.trim().to_owned();
            if !valid_database_name(&name) {
                return Err(
                    "A database's name is letters, digits, - or _, up to 40 characters.".into(),
                );
            }
            let mut mcp = read_json(&files.mcp)?;
            let databases = object(&mut mcp, "databases");
            if databases.contains_key(&name) {
                return Err(format!("There is already a database called \"{name}\"."));
            }
            let url = url.trim().to_owned();
            if url.starts_with("sqlite:") {
                return Err(
                    "A SQLite file is added with its own button, from the file dialog.".into(),
                );
            }
            let mut entry = Map::new();
            if let Some(description) = description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
            {
                entry.insert("description".into(), Value::String(description.to_owned()));
            }
            databases.insert(name.clone(), Value::Object(entry));
            let account = secrets::database_url(&name);
            check_mcp(&mcp, store, &[(account.as_str(), url.as_str())])?;
            store.set(&account, &url)?;
            write_json(&files.mcp, &mcp)
        }
        Change::RemoveDatabase { name } => {
            let mut mcp = read_json(&files.mcp)?;
            object(&mut mcp, "databases").remove(&name);
            write_json(&files.mcp, &mcp)?;
            store.delete(&secrets::database_url(&name))
        }
        Change::StoreDatabase { name } => {
            let mut mcp = read_json(&files.mcp)?;
            let entry = object(&mut mcp, "databases")
                .get_mut(&name)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| format!("There is no database called \"{name}\"."))?;
            let url = match entry.remove("url") {
                Some(Value::String(url)) if !url.trim().is_empty() => url.trim().to_owned(),
                _ => return Err(format!("\"{name}\" has no address in mcp.json to move.")),
            };
            let account = secrets::database_url(&name);
            check_mcp(&mcp, store, &[(account.as_str(), url.as_str())])?;
            store.set(&account, &url)?;
            write_json(&files.mcp, &mcp)
        }
        Change::RemoveDocumentsFolder { path } => {
            let mut documents = read_json(&files.documents)?;
            if let Some(folders) = documents.get_mut("folders").and_then(Value::as_array_mut) {
                folders.retain(|folder| folder.as_str() != Some(path.as_str()));
            }
            write_json(&files.documents, &documents)
        }
        Change::Embedding { embedding } => {
            let mut documents = read_json(&files.documents)?;
            match embedding {
                None => remove(&mut documents, "embedding"),
                Some(edit) => {
                    // Headers someone wrote by hand are kept.
                    let headers = documents
                        .pointer("/embedding/headers")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let mut value = serde_json::to_value(&edit).map_err(|e| e.to_string())?;
                    if let Some(map) = value.as_object_mut() {
                        map.insert("headers".into(), headers);
                    }
                    object(&mut documents, "embedding");
                    if let Some(root) = documents.as_object_mut() {
                        root.insert("embedding".into(), value);
                    }
                }
            }
            let text = serde_json::to_string(&documents).map_err(|error| error.to_string())?;
            DocumentsConfig::parse(&text).map_err(|error| format!("Documents: {error}"))?;
            write_json(&files.documents, &documents)
        }
    }
}

fn push_unique(list: &mut Map<String, Value>, key: &str, path: &Path) {
    let text = path.display().to_string();
    let entry = list
        .entry(key.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    let items = entry.as_array_mut().expect("just made an array");
    if !items
        .iter()
        .any(|item| item.as_str() == Some(text.as_str()))
    {
        items.push(Value::String(text));
    }
}

/// A folder the Files server may read. **Only for a path the person picked in the system's folder
/// dialog** (the desktop shell's own command): never one a page named.
pub fn add_root(files: &ConfigFiles, picked: &Path) -> Result<(), String> {
    let mut mcp = read_json(&files.mcp)?;
    push_unique(object(&mut mcp, "files"), "roots", picked);
    write_json(&files.mcp, &mcp)
}

/// A folder of documents to index. **Only for a path the person picked**, as `add_root`.
pub fn add_documents_folder(files: &ConfigFiles, picked: &Path) -> Result<(), String> {
    let mut documents = read_json(&files.documents)?;
    let root = documents
        .as_object_mut()
        .expect("read_json returns an object");
    push_unique(root, "folders", picked);
    let text = serde_json::to_string(&documents).map_err(|error| error.to_string())?;
    DocumentsConfig::parse(&text).map_err(|error| format!("Documents: {error}"))?;
    write_json(&files.documents, &documents)
}

/// A SQLite file as a database. **Only for a file the person picked** in the system's dialog.
pub fn add_sqlite_database(files: &ConfigFiles, name: &str, picked: &Path) -> Result<(), String> {
    let name = name.trim();
    if !valid_database_name(name) {
        return Err("A database's name is letters, digits, - or _, up to 40 characters.".into());
    }
    let mut mcp = read_json(&files.mcp)?;
    let databases = object(&mut mcp, "databases");
    if databases.contains_key(name) {
        return Err(format!("There is already a database called \"{name}\"."));
    }
    databases.insert(
        name.to_owned(),
        json!({ "path": picked.display().to_string() }),
    );
    write_json(&files.mcp, &mcp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct MapStore(RefCell<BTreeMap<String, String>>);

    impl SecretStore for MapStore {
        fn get(&self, account: &str) -> Option<String> {
            self.0.borrow().get(account).cloned()
        }
        fn set(&self, account: &str, value: &str) -> Result<(), String> {
            self.0.borrow_mut().insert(account.into(), value.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.0.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn files(dir: &tempfile::TempDir) -> ConfigFiles {
        ConfigFiles {
            mcp: dir.path().join("mcp.json"),
            documents: dir.path().join("documents.json"),
        }
    }

    fn rick_like(dir: &tempfile::TempDir) -> ConfigFiles {
        let files = files(dir);
        std::fs::write(
            &files.mcp,
            r#"{
              "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp"], "env": { "TOKEN": "env-secret" } } },
              "files": { "roots": ["C:/Users/me/Documents/notes"] },
              "databases": { "mine": { "url": "postgres://reader:db-secret@10.0.0.1/w", "description": "Whisperwind" } },
              "homeAssistant": { "url": "http://192.168.1.5/", "token": "ha-secret" },
              "web": { "search": { "provider": "tavily", "key": "web-secret" } }
            }"#,
        )
        .unwrap();
        std::fs::write(
            &files.documents,
            r#"{ "folders": ["C:/Users/me/Documents/manuals"] }"#,
        )
        .unwrap();
        files
    }

    #[test]
    fn the_view_shows_every_section_and_no_secret() {
        let dir = tempfile::tempdir().unwrap();
        let files = rick_like(&dir);
        let view = view(&files, &MapStore::default());
        let text = serde_json::to_string(&view).unwrap();
        for secret in ["ha-secret", "web-secret", "db-secret", "env-secret"] {
            assert!(!text.contains(secret), "{secret} leaked: {text}");
        }
        assert_eq!(view.home.as_ref().unwrap().token, SecretState::InFile);
        assert_eq!(
            view.web.as_ref().unwrap().provider.as_deref(),
            Some("tavily")
        );
        assert_eq!(
            view.databases[0].address.as_deref(),
            Some("postgres://reader@10.0.0.1/w")
        );
        assert_eq!(view.databases[0].secret, SecretState::InFile);
        assert_eq!(view.roots, ["C:/Users/me/Documents/notes"]);
        assert_eq!(view.folders, ["C:/Users/me/Documents/manuals"]);
        assert_eq!(view.servers[0].summary, "npx -y @playwright/mcp");
        assert!(view.problems.is_empty());
    }

    #[test]
    fn saving_a_section_moves_its_secret_out_of_the_file_and_keeps_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let files = rick_like(&dir);
        let store = MapStore::default();
        apply(
            &files,
            Change::Home {
                url: "http://192.168.1.5:8123".into(),
                token: None,
            },
            &store,
        )
        .unwrap();
        let text = std::fs::read_to_string(&files.mcp).unwrap();
        assert!(!text.contains("ha-secret"));
        assert_eq!(store.get(secrets::HOME_TOKEN).as_deref(), Some("ha-secret"));
        // The rest of the file is as it was, programs and all.
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value.pointer("/mcpServers/playwright/command"),
            Some(&json!("npx"))
        );
        assert_eq!(value.pointer("/web/search/key"), Some(&json!("web-secret")));
        // And the companion reads it whole, the token from the store.
        let config = McpConfig::parse_with(&text, &|account| store.get(account)).unwrap();
        assert!(matches!(config.home, Some(HomeSpec::Ready { .. })));
        assert_eq!(
            view(&files, &store).home.unwrap().token,
            SecretState::Stored
        );
    }

    #[test]
    fn a_database_address_in_the_file_moves_to_the_store_and_keeps_its_description() {
        let dir = tempfile::tempdir().unwrap();
        let files = rick_like(&dir);
        let store = MapStore::default();
        apply(
            &files,
            Change::StoreDatabase {
                name: "mine".into(),
            },
            &store,
        )
        .unwrap();
        let text = std::fs::read_to_string(&files.mcp).unwrap();
        assert!(!text.contains("db-secret"), "{text}");
        assert_eq!(
            store.get(&secrets::database_url("mine")).as_deref(),
            Some("postgres://reader:db-secret@10.0.0.1/w")
        );
        let shown = view(&files, &store);
        assert_eq!(shown.databases[0].secret, SecretState::Stored);
        assert_eq!(
            shown.databases[0].description.as_deref(),
            Some("Whisperwind")
        );
        assert_eq!(
            shown.databases[0].address.as_deref(),
            Some("postgres://reader@10.0.0.1/w")
        );
        // Nothing left to move, and no such database: refused, nothing written.
        let before = std::fs::read_to_string(&files.mcp).unwrap();
        for name in ["mine", "nope"] {
            assert!(apply(&files, Change::StoreDatabase { name: name.into() }, &store).is_err());
        }
        assert_eq!(std::fs::read_to_string(&files.mcp).unwrap(), before);
    }

    #[test]
    fn a_change_the_companion_would_refuse_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let files = rick_like(&dir);
        let before = std::fs::read_to_string(&files.mcp).unwrap();
        let store = MapStore::default();
        let error = apply(
            &files,
            Change::Home {
                url: "homeassistant.local".into(),
                token: None,
            },
            &store,
        )
        .unwrap_err();
        assert!(error.contains("not an http(s) address"), "{error}");
        assert_eq!(std::fs::read_to_string(&files.mcp).unwrap(), before);
        assert!(store.get(secrets::HOME_TOKEN).is_none());

        // Brave with no key anywhere: refused, and no file is made.
        let empty = tempfile::tempdir().unwrap();
        let fresh = self::files(&empty);
        let error = apply(
            &fresh,
            Change::Web {
                provider: Some("brave".into()),
                url: None,
                key: None,
                read_pages: true,
            },
            &store,
        )
        .unwrap_err();
        assert!(error.contains("needs its key"), "{error}");
        assert!(!fresh.mcp.exists());
    }

    #[test]
    fn a_new_home_assistant_and_a_new_database_keep_their_secrets_out_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let files = files(&dir);
        let store = MapStore::default();
        apply(
            &files,
            Change::Home {
                url: "http://ha.local:8123".into(),
                token: Some("t0k".into()),
            },
            &store,
        )
        .unwrap();
        apply(
            &files,
            Change::AddDatabase {
                name: "shop".into(),
                url: "mysql://u:pw@db/shop".into(),
                description: Some("orders".into()),
            },
            &store,
        )
        .unwrap();
        let text = std::fs::read_to_string(&files.mcp).unwrap();
        assert!(!text.contains("t0k") && !text.contains("pw@"), "{text}");
        assert_eq!(
            store.get(&secrets::database_url("shop")).as_deref(),
            Some("mysql://u:pw@db/shop")
        );
        let config = McpConfig::parse_with(&text, &|account| store.get(account)).unwrap();
        assert!(matches!(config.databases[0].1, DatabaseSpec::Ready { .. }));
        // Without the store (a hand-edit elsewhere), the entry says what it lacks.
        assert!(matches!(
            McpConfig::parse(&text).unwrap().databases[0].1,
            DatabaseSpec::Invalid(_)
        ));

        assert!(
            apply(
                &files,
                Change::AddDatabase {
                    name: "shop".into(),
                    url: "mysql://x@y/z".into(),
                    description: None
                },
                &store
            )
            .is_err()
        );
        assert!(
            apply(
                &files,
                Change::AddDatabase {
                    name: "bad name".into(),
                    url: "mysql://x@y/z".into(),
                    description: None
                },
                &store
            )
            .is_err()
        );
        assert!(
            apply(
                &files,
                Change::AddDatabase {
                    name: "f".into(),
                    url: "ftp://x".into(),
                    description: None
                },
                &store
            )
            .is_err()
        );

        apply(
            &files,
            Change::RemoveDatabase {
                name: "shop".into(),
            },
            &store,
        )
        .unwrap();
        apply(&files, Change::RemoveHome, &store).unwrap();
        assert!(store.0.borrow().is_empty());
    }

    #[test]
    fn folders_are_added_only_by_the_picked_path_functions_and_removed_by_change() {
        let dir = tempfile::tempdir().unwrap();
        let files = files(&dir);
        let store = MapStore::default();
        add_root(&files, Path::new("C:/notes")).unwrap();
        add_root(&files, Path::new("C:/notes")).unwrap();
        add_documents_folder(&files, Path::new("C:/manuals")).unwrap();
        let shown = view(&files, &store);
        assert_eq!(shown.roots, ["C:/notes"]);
        assert_eq!(shown.folders, ["C:/manuals"]);
        apply(
            &files,
            Change::RemoveRoot {
                path: "C:/notes".into(),
            },
            &store,
        )
        .unwrap();
        apply(
            &files,
            Change::RemoveDocumentsFolder {
                path: "C:/manuals".into(),
            },
            &store,
        )
        .unwrap();
        let shown = view(&files, &store);
        assert!(shown.roots.is_empty() && shown.folders.is_empty());
        // A page cannot ask for a folder: there is no such change.
        assert!(
            serde_json::from_value::<Change>(json!({ "kind": "addRoot", "path": "C:/" })).is_err()
        );
    }

    #[test]
    fn the_embedding_is_set_checked_and_keeps_hand_written_headers() {
        let dir = tempfile::tempdir().unwrap();
        let files = files(&dir);
        std::fs::write(&files.documents, r#"{ "embedding": { "baseUrl": "http://x/v1", "model": "m", "dimensions": 8, "headers": { "x-a": "1" } } }"#).unwrap();
        let store = MapStore::default();
        let edit = EmbeddingView {
            base_url: "http://127.0.0.1:11434/v1".into(),
            model: "nomic-embed-text".into(),
            dimensions: 768,
            document_prefix: "search_document: ".into(),
            query_prefix: "search_query: ".into(),
        };
        apply(
            &files,
            Change::Embedding {
                embedding: Some(edit.clone()),
            },
            &store,
        )
        .unwrap();
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(&files.documents).unwrap()).unwrap();
        assert_eq!(value.pointer("/embedding/headers/x-a"), Some(&json!("1")));
        assert_eq!(view(&files, &store).embedding, Some(edit));
        let bad = EmbeddingView {
            base_url: "ftp://x".into(),
            model: "m".into(),
            dimensions: 8,
            document_prefix: String::new(),
            query_prefix: String::new(),
        };
        assert!(
            apply(
                &files,
                Change::Embedding {
                    embedding: Some(bad)
                },
                &store
            )
            .is_err()
        );
        apply(&files, Change::Embedding { embedding: None }, &store).unwrap();
        assert_eq!(view(&files, &store).embedding, None);
    }

    #[test]
    fn a_file_that_does_not_parse_is_reported_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let files = files(&dir);
        std::fs::write(&files.mcp, "{ not json").unwrap();
        let shown = view(&files, &MapStore::default());
        assert_eq!(shown.problems.len(), 1);
        assert!(apply(&files, Change::RemoveHome, &MapStore::default()).is_err());
        assert_eq!(std::fs::read_to_string(&files.mcp).unwrap(), "{ not json");
    }
}
