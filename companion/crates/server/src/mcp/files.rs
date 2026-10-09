//! Files: the companion's own MCP server, read-only, inside the roots `mcp.json` names (ADR-43).
//!
//! Every path is canonicalised and must stay under a canonical root, so `..` and a symlink that
//! points out are refused alike. Writing waits for its own decision.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{CallOutcome, ToolInfo};

/// How much of a file is read: a long document, not a disk image.
pub const READ_LIMIT: usize = 256 * 1024;
const LIST_LIMIT: usize = 500;
const SEARCH_RESULTS: usize = 200;
const SEARCH_VISITS: usize = 20_000;
const SEARCH_DEPTH: usize = 8;

pub struct FilesServer {
    /// Canonical, as the filesystem names them.
    roots: Vec<PathBuf>,
}

/// A path as a person reads it: no `\\?\` prefix from Windows' canonical form.
fn shown(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\")
        .map(str::to_owned)
        .unwrap_or(text)
}

fn text(message: impl Into<String>) -> CallOutcome {
    CallOutcome::text(false, message)
}

fn refuse(message: impl Into<String>) -> CallOutcome {
    CallOutcome::text(true, message)
}

impl FilesServer {
    /// The roots that exist, canonicalised; the ones that do not are returned with why.
    pub fn new(roots: &[PathBuf]) -> (Self, Vec<String>) {
        let mut kept = Vec::new();
        let mut problems = Vec::new();
        for root in roots {
            match root.canonicalize() {
                Ok(path) if path.is_dir() => kept.push(path),
                Ok(_) => problems.push(format!("{} is not a folder", root.display())),
                Err(error) => problems.push(format!("{}: {error}", root.display())),
            }
        }
        (Self { roots: kept }, problems)
    }

    pub fn has_roots(&self) -> bool {
        !self.roots.is_empty()
    }

    pub fn tools() -> Vec<ToolInfo> {
        let read_only =
            json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
        let path = |what: &str| json!({ "type": "string", "description": what });
        vec![
            ToolInfo::new(
                "list_allowed_directories",
                "List the folders on this computer you may read. Every other tool works only inside them.",
                json!({ "type": "object", "properties": {} }),
                read_only.clone(),
            ),
            ToolInfo::new(
                "list_directory",
                "List what is in a folder: its subfolders and its files with their sizes.",
                json!({ "type": "object", "properties": { "path": path("A folder: absolute, or relative to an allowed folder. Empty for the first allowed folder.") } }),
                read_only.clone(),
            ),
            ToolInfo::new(
                "read_text_file",
                "Read a text file (up to 256 KB of it).",
                json!({ "type": "object", "properties": { "path": path("The file: absolute, or relative to an allowed folder.") }, "required": ["path"] }),
                read_only.clone(),
            ),
            ToolInfo::new(
                "search_files",
                "Find files and folders whose names contain some text, in a folder and the folders inside it.",
                json!({ "type": "object", "properties": { "pattern": { "type": "string", "description": "Text the name contains; case does not matter." }, "path": path("Where to look. Empty for every allowed folder.") }, "required": ["pattern"] }),
                read_only,
            ),
        ]
    }

    pub fn call(&self, name: &str, args: &serde_json::Map<String, Value>) -> CallOutcome {
        let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").trim();
        match name {
            "list_allowed_directories" => text(
                self.roots
                    .iter()
                    .map(|root| shown(root))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            "list_directory" => self.list(arg("path")),
            "read_text_file" => self.read(arg("path")),
            "search_files" => self.search(arg("pattern"), arg("path")),
            other => refuse(format!("Files has no tool called {other}.")),
        }
    }

    fn allowed(&self) -> String {
        self.roots
            .iter()
            .map(|root| shown(root))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `path` inside a root, canonical; or the words to say why not.
    fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let first = self.roots.first().ok_or("No folders are allowed.")?;
        if path.is_empty() {
            return Ok(first.clone());
        }
        let given = Path::new(path);
        let candidates: Vec<PathBuf> = if given.is_absolute() {
            vec![given.to_path_buf()]
        } else {
            self.roots.iter().map(|root| root.join(given)).collect()
        };
        let mut outside = false;
        for candidate in candidates {
            let Ok(canonical) = candidate.canonicalize() else {
                continue;
            };
            if self.roots.iter().any(|root| canonical.starts_with(root)) {
                return Ok(canonical);
            }
            outside = true;
        }
        Err(if outside {
            format!(
                "{path} is outside the folders you may read ({}).",
                self.allowed()
            )
        } else {
            format!(
                "There is no {path} in the folders you may read ({}).",
                self.allowed()
            )
        })
    }

    fn list(&self, path: &str) -> CallOutcome {
        let folder = match self.resolve(path) {
            Ok(folder) => folder,
            Err(why) => return refuse(why),
        };
        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) => {
                return refuse(format!("{} could not be listed: {error}", shown(&folder)));
            }
        };
        let mut lines: Vec<String> = entries
            .filter_map(Result::ok)
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                match entry.metadata() {
                    Ok(meta) if meta.is_dir() => format!("[folder] {name}"),
                    Ok(meta) => format!("[file] {name} ({} bytes)", meta.len()),
                    Err(_) => format!("[?] {name}"),
                }
            })
            .collect();
        lines.sort();
        let total = lines.len();
        lines.truncate(LIST_LIMIT);
        let mut out = format!("{}:\n{}", shown(&folder), lines.join("\n"));
        if total > LIST_LIMIT {
            out.push_str(&format!("\n… and {} more", total - LIST_LIMIT));
        }
        if total == 0 {
            out.push_str("(empty)");
        }
        text(out)
    }

    fn read(&self, path: &str) -> CallOutcome {
        if path.is_empty() {
            return refuse("Give the path of the file to read.");
        }
        let file = match self.resolve(path) {
            Ok(file) => file,
            Err(why) => return refuse(why),
        };
        if file.is_dir() {
            return refuse(format!(
                "{} is a folder; list it with list_directory.",
                shown(&file)
            ));
        }
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(error) => return refuse(format!("{} could not be read: {error}", shown(&file))),
        };
        if bytes[..bytes.len().min(8192)].contains(&0) {
            return refuse(format!("{} is not a text file.", shown(&file)));
        }
        let cut = bytes.len() > READ_LIMIT;
        let mut content =
            String::from_utf8_lossy(&bytes[..bytes.len().min(READ_LIMIT)]).into_owned();
        if cut {
            content.push_str(&format!(
                "\n… [cut: the file is {} bytes; the first {} KB are shown]",
                bytes.len(),
                READ_LIMIT / 1024
            ));
        }
        text(content)
    }

    fn search(&self, pattern: &str, path: &str) -> CallOutcome {
        if pattern.is_empty() {
            return refuse("Give some text the name contains.");
        }
        let starts = if path.is_empty() {
            self.roots.clone()
        } else {
            match self.resolve(path) {
                Ok(start) => vec![start],
                Err(why) => return refuse(why),
            }
        };
        let needle = pattern.to_lowercase();
        let mut found = Vec::new();
        let mut visits = 0;
        // Symlinks are not followed: a link out of a root would be a way out of it.
        let mut stack: Vec<(PathBuf, usize)> = starts.into_iter().map(|start| (start, 0)).collect();
        while let Some((folder, depth)) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&folder) else {
                continue;
            };
            for entry in entries.filter_map(Result::ok) {
                visits += 1;
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if kind.is_symlink() {
                    continue;
                }
                let entry_path = entry.path();
                if entry
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .contains(&needle)
                {
                    found.push(shown(&entry_path));
                }
                if kind.is_dir() && depth < SEARCH_DEPTH {
                    stack.push((entry_path, depth + 1));
                }
                if found.len() >= SEARCH_RESULTS || visits >= SEARCH_VISITS {
                    break;
                }
            }
            if found.len() >= SEARCH_RESULTS || visits >= SEARCH_VISITS {
                break;
            }
        }
        found.sort();
        if found.is_empty() {
            return text(format!("Nothing named like \"{pattern}\"."));
        }
        let more = if found.len() >= SEARCH_RESULTS || visits >= SEARCH_VISITS {
            "\n… the search stopped early; narrow it with a path or longer text"
        } else {
            ""
        };
        text(format!("{}{more}", found.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp directory, removed when dropped.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "lp-files-{name}-{}-{}",
                std::process::id(),
                rand::random::<u32>()
            ));
            std::fs::create_dir_all(&path).expect("scratch folder");
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn args(pairs: &[(&str, &str)]) -> serde_json::Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Value::from(*value)))
            .collect()
    }

    fn setup() -> (Scratch, Scratch, FilesServer) {
        let root = Scratch::new("root");
        let outside = Scratch::new("outside");
        std::fs::create_dir_all(root.0.join("garden")).expect("mkdir");
        std::fs::write(root.0.join("garden").join("Herbs.md"), "Basil, thyme.").expect("write");
        std::fs::write(root.0.join("photo.bin"), [0u8, 1, 2]).expect("write");
        std::fs::write(outside.0.join("secret.txt"), "no").expect("write");
        let (server, problems) = FilesServer::new(&[root.0.clone(), root.0.join("missing")]);
        assert_eq!(problems.len(), 1);
        (root, outside, server)
    }

    #[test]
    fn reads_and_lists_inside_a_root_by_relative_or_absolute_path() {
        let (root, _outside, files) = setup();
        let read = files.call("read_text_file", &args(&[("path", "garden/Herbs.md")]));
        assert_eq!(
            (read.is_error, read.text.as_str()),
            (false, "Basil, thyme.")
        );
        let absolute = root.0.join("garden").join("Herbs.md");
        let read = files.call(
            "read_text_file",
            &args(&[("path", &absolute.display().to_string())]),
        );
        assert!(!read.is_error);
        let listed = files.call("list_directory", &args(&[]));
        assert!(listed.text.contains("[folder] garden"), "{}", listed.text);
        assert!(
            listed.text.contains("[file] photo.bin (3 bytes)"),
            "{}",
            listed.text
        );
        let found = files.call("search_files", &args(&[("pattern", "herb")]));
        assert!(found.text.ends_with("Herbs.md"), "{}", found.text);
        let roots = files.call("list_allowed_directories", &args(&[]));
        assert!(!roots.text.starts_with(r"\\?\"), "{}", roots.text);
    }

    #[test]
    fn refuses_a_way_out_of_the_roots_and_a_file_that_is_not_text() {
        let (_root, outside, files) = setup();
        let escape = files.call("read_text_file", &args(&[("path", "../")]));
        assert!(escape.is_error);
        let secret = outside.0.join("secret.txt").display().to_string();
        let away = files.call("read_text_file", &args(&[("path", &secret)]));
        assert!(
            away.is_error && away.text.contains("outside the folders"),
            "{}",
            away.text
        );
        let relative = format!(
            "../{}/secret.txt",
            outside.0.file_name().expect("named").to_string_lossy()
        );
        let dots = files.call("read_text_file", &args(&[("path", &relative)]));
        assert!(
            dots.is_error && dots.text.contains("outside the folders"),
            "{}",
            dots.text
        );
        let binary = files.call("read_text_file", &args(&[("path", "photo.bin")]));
        assert!(binary.is_error && binary.text.contains("not a text file"));
        let missing = files.call("read_text_file", &args(&[("path", "nope.txt")]));
        assert!(missing.is_error && missing.text.contains("There is no nope.txt"));
        assert!(files.call("delete_file", &args(&[])).is_error);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_points_out_is_refused_and_not_searched() {
        let (root, outside, files) = setup();
        std::os::unix::fs::symlink(&outside.0, root.0.join("link")).expect("symlink");
        assert!(
            files
                .call("read_text_file", &args(&[("path", "link/secret.txt")]))
                .is_error
        );
        let found = files.call("search_files", &args(&[("pattern", "secret")]));
        assert!(found.text.starts_with("Nothing"), "{}", found.text);
    }

    #[test]
    fn a_long_file_is_cut_and_says_so() {
        let (root, _outside, files) = setup();
        std::fs::write(root.0.join("long.txt"), "x".repeat(READ_LIMIT + 10)).expect("write");
        let read = files.call("read_text_file", &args(&[("path", "long.txt")]));
        assert!(read.text.ends_with("the first 256 KB are shown]"));
        assert!(read.text.len() < READ_LIMIT + 200);
    }
}
