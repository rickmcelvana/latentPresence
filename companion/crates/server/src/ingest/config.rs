//! `documents.json`: the person's own list of folders for the companion to index (ADR-44).
//!
//! ```json
//! {
//!   "folders": ["C:/Users/me/Documents/manuals"],
//!   "embedding": {
//!     "baseUrl": "http://127.0.0.1:11434/v1",
//!     "model": "nomic-embed-text",
//!     "dimensions": 768,
//!     "documentPrefix": "search_document: ",
//!     "queryPrefix": "search_query: ",
//!     "headers": {}
//!   },
//!   "watch": true
//! }
//! ```
//!
//! **The page never names a path.** The file is beside `mcp.json` in the OS config directory (or
//! the path in `COMPANION_DOCUMENTS_CONFIG`), edited by the person and read once, at start: a
//! page that could point the companion at a folder could read any file through retrieval - the
//! hole ADR-43 closed for the Files server. `embedding` is optional (absent: chunks are found
//! by keyword only); the keys in it carry a token, so the file stays out of the repo.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use latentpresence_db::memory::EmbeddingModel;
use reqwest::header::{HeaderName, HeaderValue};
use serde::Deserialize;

/// The OpenAI-compatible endpoint chunks are embedded with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingConfig {
    /// Without a trailing slash; `/embeddings` is appended.
    pub base_url: String,
    pub model: String,
    pub dimensions: u16,
    /// Put before each chunk's text (`nomic-embed-text` wants `search_document: `).
    pub document_prefix: String,
    /// P5-T04's: put before the question.
    pub query_prefix: String,
    pub headers: BTreeMap<String, String>,
}

impl EmbeddingConfig {
    /// The registry row the chunks' vectors are filed under. `provider` is the endpoint:
    /// the same model name served by two endpoints that quantise it differently is two
    /// models (`model_registry`).
    pub fn model(&self) -> EmbeddingModel {
        EmbeddingModel {
            provider: self.base_url.clone(),
            model: self.model.clone(),
            dimensions: self.dimensions,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentsConfig {
    pub folders: Vec<PathBuf>,
    pub embedding: Option<EmbeddingConfig>,
    pub watch: bool,
}

impl Default for DocumentsConfig {
    /// No file: no folders.
    fn default() -> Self {
        Self {
            folders: Vec::new(),
            embedding: None,
            watch: true,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    folders: Vec<PathBuf>,
    #[serde(default)]
    embedding: Option<RawEmbedding>,
    #[serde(default = "yes")]
    watch: bool,
}

fn yes() -> bool {
    true
}

/// Strict, unlike `mcp.json`'s servers: this file is ours alone, and a misspelt
/// `documentPrefix` that was silently ignored would embed every chunk without the prefix its
/// model was trained on - results that look fine and rank badly.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawEmbedding {
    base_url: String,
    model: String,
    dimensions: u32,
    #[serde(default)]
    document_prefix: String,
    #[serde(default)]
    query_prefix: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

impl DocumentsConfig {
    pub fn parse(text: &str) -> Result<Self, String> {
        let raw: RawConfig = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let embedding = raw.embedding.map(embedding_from).transpose()?;
        Ok(Self {
            folders: raw.folders,
            embedding,
            watch: raw.watch,
        })
    }

    /// The file at `path`: none there is no folders; one that does not parse is an error.
    pub fn load(path: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text).map_err(|error| format!("{}: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("{}: {error}", path.display())),
        }
    }
}

fn embedding_from(raw: RawEmbedding) -> Result<EmbeddingConfig, String> {
    let base_url = raw.base_url.trim().trim_end_matches('/').to_owned();
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(format!(
            "embedding.baseUrl \"{base_url}\" is not an http(s) address"
        ));
    }
    let dimensions = u16::try_from(raw.dimensions)
        .map_err(|_| format!("embedding.dimensions {} is out of range", raw.dimensions))?;
    for (name, value) in &raw.headers {
        // Said now, at start, rather than as an error on the first chunk.
        HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("embedding.headers: \"{name}\" is not a header name"))?;
        HeaderValue::from_str(value)
            .map_err(|_| format!("embedding.headers: the value of \"{name}\" is not valid"))?;
    }
    let config = EmbeddingConfig {
        base_url,
        model: raw.model.trim().to_owned(),
        dimensions,
        document_prefix: raw.document_prefix,
        query_prefix: raw.query_prefix,
        headers: raw.headers,
    };
    // The registry's own limits (name lengths, 1-16383 dimensions), said in the file's terms.
    config
        .model()
        .validate()
        .map_err(|error| format!("embedding: {error}"))?;
    Ok(config)
}

/// A folder as the ingester knows it: canonical when it could be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub path: PathBuf,
    /// The text filed in the database as the documents' folder, and shown in the status.
    pub label: String,
}

/// Canonicalise the listed folders (once, at start), in the order given. A folder that
/// cannot be resolved is kept as written, so the status can say it is not there. A folder
/// inside another listed one is returned in the second list: the outer walk already covers
/// it, and a file belongs to one folder, because a document is keyed by its path.
pub fn resolve(listed: &[PathBuf]) -> (Vec<Folder>, Vec<String>) {
    let mut resolved: Vec<Folder> = Vec::new();
    let mut notes = Vec::new();
    for path in listed {
        let canonical = std::fs::canonicalize(path)
            .map(|path| simplify(&path))
            .unwrap_or_else(|_| path.clone());
        if resolved.iter().any(|folder| folder.path == canonical) {
            notes.push(format!("{} is listed twice", canonical.display()));
            continue;
        }
        resolved.push(Folder {
            label: canonical.to_string_lossy().into_owned(),
            path: canonical,
        });
    }
    // Drop a folder that sits inside another one that exists; which of two nested folders is
    // "outer" does not depend on the order they were listed in.
    let keep: Vec<bool> = resolved
        .iter()
        .map(|folder| {
            !resolved
                .iter()
                .any(|other| other.path != folder.path && folder.path.starts_with(&other.path))
        })
        .collect();
    let mut kept = Vec::new();
    for (folder, keep) in resolved.into_iter().zip(keep) {
        if keep {
            kept.push(folder);
        } else {
            notes.push(format!(
                "{} is inside another listed folder, which covers it",
                folder.path.display()
            ));
        }
    }
    (kept, notes)
}

/// `\\?\C:\x` (what `canonicalize` returns on Windows) as `C:\x`: the verbatim form is what
/// no one wrote in `documents.json`, and it would be the text in the status and the database.
/// UNC and device paths keep theirs.
fn simplify(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        let mut chars = rest.chars();
        if let (Some(drive), Some(':')) = (chars.next(), chars.next())
            && drive.is_ascii_alphabetic()
        {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_documented_shape() {
        let config = DocumentsConfig::parse(
            r#"{
              "folders": ["C:/Users/me/Documents/manuals", "/home/me/notes"],
              "embedding": {
                "baseUrl": "http://127.0.0.1:11434/v1/",
                "model": "nomic-embed-text",
                "dimensions": 768,
                "documentPrefix": "search_document: ",
                "queryPrefix": "search_query: ",
                "headers": { "Authorization": "Bearer t" }
              },
              "watch": false
            }"#,
        )
        .expect("parses");
        assert_eq!(
            config.folders,
            [
                PathBuf::from("C:/Users/me/Documents/manuals"),
                PathBuf::from("/home/me/notes")
            ]
        );
        assert!(!config.watch);
        let embedding = config.embedding.expect("an embedding");
        // The trailing slash goes; the endpoint is the registry's provider.
        assert_eq!(embedding.base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(embedding.model().provider, "http://127.0.0.1:11434/v1");
        assert_eq!(embedding.dimensions, 768);
        assert_eq!(embedding.document_prefix, "search_document: ");
        assert_eq!(embedding.query_prefix, "search_query: ");
        assert_eq!(embedding.headers["Authorization"], "Bearer t");
    }

    #[test]
    fn everything_is_optional_and_watching_is_on_by_default() {
        let config = DocumentsConfig::parse("{}").expect("parses");
        assert_eq!(config, DocumentsConfig::default());
        assert!(config.folders.is_empty());
        assert!(config.embedding.is_none());
        assert!(config.watch);
        let config = DocumentsConfig::parse(
            r#"{ "embedding": { "baseUrl": "https://api.example.com/v1", "model": "m", "dimensions": 3 } }"#,
        )
        .expect("parses");
        let embedding = config.embedding.expect("an embedding");
        assert_eq!(embedding.document_prefix, "");
        assert_eq!(embedding.query_prefix, "");
        assert!(embedding.headers.is_empty());
    }

    #[test]
    fn what_is_wrong_is_said() {
        for (text, why) in [
            (r#"{ "folders": "#, "EOF"),
            (r#"{ "folder": [] }"#, "unknown field"),
            (r#"{ "folders": [1] }"#, "invalid type"),
            (
                r#"{ "embedding": { "baseUrl": "x", "model": "m", "dimensions": 3, "dimension": 3 } }"#,
                "unknown field",
            ),
            (
                r#"{ "embedding": { "baseUrl": "ftp://x", "model": "m", "dimensions": 3 } }"#,
                "not an http(s) address",
            ),
            (
                r#"{ "embedding": { "baseUrl": "http://x", "model": "m", "dimensions": 0 } }"#,
                "dimensions",
            ),
            (
                r#"{ "embedding": { "baseUrl": "http://x", "model": "m", "dimensions": 70000 } }"#,
                "out of range",
            ),
            (
                r#"{ "embedding": { "baseUrl": "http://x", "model": " ", "dimensions": 3 } }"#,
                "name",
            ),
            (
                r#"{ "embedding": { "baseUrl": "http://x", "model": "m" } }"#,
                "dimensions",
            ),
            (
                r#"{ "embedding": { "baseUrl": "http://x", "model": "m", "dimensions": 3, "headers": { "bad name": "v" } } }"#,
                "header name",
            ),
        ] {
            let error = DocumentsConfig::parse(text).expect_err(text);
            assert!(error.contains(why), "{text}: {error}");
        }
    }

    #[test]
    fn no_file_is_no_folders_and_a_broken_one_is_an_error_naming_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(
            DocumentsConfig::load(&dir.path().join("documents.json")),
            Ok(DocumentsConfig::default())
        );
        let path = dir.path().join("documents.json");
        std::fs::write(&path, "{ nope").expect("writes");
        let error = DocumentsConfig::load(&path).expect_err("does not parse");
        assert!(error.contains("documents.json"), "{error}");
        std::fs::write(&path, r#"{ "folders": ["/x"] }"#).expect("writes");
        assert_eq!(
            DocumentsConfig::load(&path).expect("loads").folders,
            [PathBuf::from("/x")]
        );
    }

    #[test]
    fn folders_are_canonical_and_a_nested_one_is_covered_by_its_parent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let outer = dir.path().join("manuals");
        let inner = outer.join("old");
        let other = dir.path().join("notes");
        std::fs::create_dir_all(&inner).expect("dirs");
        std::fs::create_dir_all(&other).expect("dirs");
        let missing = dir.path().join("not-there");

        // Written with a `..` in it; listed inner first, and one twice.
        let sloppy = outer.join("old").join("..").join("old");
        let (folders, notes) = resolve(&[
            sloppy,
            outer.clone(),
            other.clone(),
            other.clone(),
            missing.clone(),
        ]);
        let labels: Vec<&str> = folders.iter().map(|folder| folder.label.as_str()).collect();
        assert_eq!(folders.len(), 3, "{labels:?}");
        assert!(folders[0].path.ends_with("manuals"), "{labels:?}");
        assert!(folders[1].path.ends_with("notes"));
        // A folder that is not there is kept as written, to be reported as missing.
        assert_eq!(folders[2].path, missing);
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(!labels.iter().any(|label| label.starts_with(r"\\?\")));
    }

    #[test]
    fn the_verbatim_windows_prefix_is_dropped_only_from_drive_paths() {
        assert_eq!(
            simplify(Path::new(r"\\?\C:\Users\me")),
            PathBuf::from(r"C:\Users\me")
        );
        assert_eq!(
            simplify(Path::new(r"\\?\UNC\host\share")),
            PathBuf::from(r"\\?\UNC\host\share")
        );
        assert_eq!(simplify(Path::new("/home/me")), PathBuf::from("/home/me"));
    }
}
