//! Files: the companion's own MCP server, read-only, inside the roots `mcp.json` names (ADR-43).
//!
//! Every path is canonicalised and must stay under a canonical root, so `..` and a symlink that
//! points out are refused alike. Writing waits for its own decision.
//!
//! A file is read a page at a time, and every page but a whole file says where it stops and how
//! to read on: the page cuts a tool result at 8 000 characters, and in R-29 she took the end of
//! that cut for the end of the notes and said a herb further down was not there.

use std::fs::FileType;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{CallOutcome, ToolInfo};

/// How much of a file is read at all: a long document, not a disk image.
pub const READ_LIMIT: usize = 4 * 1024 * 1024;
/// One page of `read_text_file`, in bytes: under the page's 8 000-character cut, with room for
/// the line that says where it stops.
pub const PAGE_BYTES: usize = 6000;
const LIST_LIMIT: usize = 500;
const SEARCH_RESULTS: usize = 200;
const SEARCH_VISITS: usize = 20_000;
const SEARCH_DEPTH: usize = 8;
/// `search_text`: the matching lines shown, how long each may be, and how many files are read.
const TEXT_MATCHES: usize = 60;
const MATCH_CHARS: usize = 300;
const TEXT_FILES: usize = 2000;

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
                "Read a text file, a page of lines at a time. A long file says which lines you were given and how to read on: read on before you say something is not in it.",
                json!({ "type": "object", "properties": {
                    "path": path("The file: absolute, or relative to an allowed folder."),
                    "from_line": { "type": "integer", "minimum": 1, "description": "The line to start at; 1, or leave it out, for the start." }
                }, "required": ["path"] }),
                read_only.clone(),
            ),
            ToolInfo::new(
                "search_text",
                "Find the lines that contain some text, in one file or in every text file in a folder and the folders inside it. Use it to find where something is mentioned.",
                json!({ "type": "object", "properties": { "text": { "type": "string", "description": "The text a line contains; case does not matter." }, "path": path("A file or a folder. Empty for every allowed folder.") }, "required": ["text"] }),
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
            "read_text_file" => match from_line(args.get("from_line")) {
                Ok(from) => self.read(arg("path"), from),
                Err(why) => refuse(why),
            },
            "search_files" => self.search(arg("pattern"), arg("path")),
            "search_text" => self.search_text(arg("text"), arg("path")),
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

    fn read(&self, path: &str, from_line: usize) -> CallOutcome {
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
        let (content, size) = match text_of(&file) {
            Ok(read) => read,
            Err(why) => return refuse(why),
        };
        let lines: Vec<&str> = content.split_inclusive('\n').collect();
        let total = lines.len();
        if from_line > total.max(1) {
            return refuse(format!(
                "{} has {total} lines; there is no line {from_line}.",
                shown(&file)
            ));
        }
        let first = from_line - 1;
        let mut page = String::new();
        let mut next = first;
        while next < total && (next == first || page.len() + lines[next].len() <= PAGE_BYTES) {
            page.push_str(lines[next]);
            next += 1;
        }
        // One line longer than a page: its start, at a character boundary.
        if page.len() > PAGE_BYTES {
            let mut at = PAGE_BYTES;
            while !page.is_char_boundary(at) {
                at -= 1;
            }
            page.truncate(at);
            page.push_str("… [this line goes on]");
        }
        if first == 0 && next == total && size.is_none() {
            return text(content);
        }
        let mut out = page.trim_end().to_owned();
        if next < total {
            out.push_str(&format!(
                "\n[lines {from_line}–{next} of {total}. Not the whole file: read on with from_line {}.]",
                next + 1
            ));
        } else {
            out.push_str(&format!(
                "\n[lines {from_line}–{next} of {total}: the end of the file.]"
            ));
        }
        if let Some(size) = size {
            out.push_str(&format!(
                " The file is {size} bytes; only the first {} MB can be read.",
                READ_LIMIT / (1024 * 1024)
            ));
        }
        text(out)
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
        let finished = walk(starts, |entry, _| {
            if entry
                .file_name()
                .is_some_and(|name| name.to_string_lossy().to_lowercase().contains(&needle))
            {
                found.push(shown(entry));
            }
            found.len() < SEARCH_RESULTS
        });
        found.sort();
        if found.is_empty() {
            return text(format!("Nothing named like \"{pattern}\"."));
        }
        let more = if !finished {
            "\n… the search stopped early; narrow it with a path or longer text"
        } else {
            ""
        };
        text(format!("{}{more}", found.join("\n")))
    }
}

impl FilesServer {
    fn search_text(&self, needle: &str, path: &str) -> CallOutcome {
        if needle.is_empty() {
            return refuse("Give the text to look for.");
        }
        let (starts, place) = if path.is_empty() {
            (self.roots.clone(), "the folders you may read".to_owned())
        } else {
            match self.resolve(path) {
                Ok(start) => {
                    let place = shown(&start);
                    (vec![start], place)
                }
                Err(why) => return refuse(why),
            }
        };
        let lower = needle.to_lowercase();
        let mut matches = Vec::new();
        let look = |file: &Path, matches: &mut Vec<String>| {
            // Not text, or not readable: not a place the words can be.
            let Ok((content, _)) = text_of(file) else {
                return;
            };
            for (n, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&lower) {
                    matches.push(format!(
                        "{}:{}: {}",
                        shown(file),
                        n + 1,
                        clipped(line.trim())
                    ));
                    if matches.len() > TEXT_MATCHES {
                        return;
                    }
                }
            }
        };
        let finished = if starts.len() == 1 && starts[0].is_file() {
            look(&starts[0], &mut matches);
            matches.len() <= TEXT_MATCHES
        } else {
            let mut files = 0;
            walk(starts, |entry, kind| {
                if kind.is_file() {
                    files += 1;
                    look(entry, &mut matches);
                }
                matches.len() <= TEXT_MATCHES && files < TEXT_FILES
            })
        };
        if matches.is_empty() {
            let partly = if finished {
                ""
            } else {
                " (the search stopped early; narrow it with a path)"
            };
            return text(format!("No line contains \"{needle}\" in {place}{partly}."));
        }
        matches.truncate(TEXT_MATCHES);
        let more = if finished {
            ""
        } else {
            "\n… the search stopped early; narrow it with a path or longer text"
        };
        text(format!(
            "{}{more}\n[Read around a line with read_text_file and from_line.]",
            matches.join("\n")
        ))
    }
}

/// `from_line` as given: a number, or a number in a string, as some models send it.
fn from_line(value: Option<&Value>) -> Result<usize, String> {
    let line = match value {
        None | Some(Value::Null) => return Ok(1),
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|f| *f >= 0.0 && f.fract() == 0.0)
                .map(|f| f as u64)
        }),
        Some(Value::String(text)) => text.trim().parse().ok(),
        Some(_) => None,
    };
    line.and_then(|line| usize::try_from(line).ok())
        .map(|line| line.max(1))
        .ok_or_else(|| "from_line is a line number: 1 or more.".to_owned())
}

/// A file's text, up to `READ_LIMIT` bytes, with its size when it was longer; or why not.
fn text_of(file: &Path) -> Result<(String, Option<u64>), String> {
    let failed = |error: std::io::Error| format!("{} could not be read: {error}", shown(file));
    let size = std::fs::metadata(file).map_err(failed)?.len();
    let mut bytes = Vec::new();
    std::fs::File::open(file)
        .and_then(|opened| opened.take(READ_LIMIT as u64).read_to_end(&mut bytes))
        .map_err(failed)?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(format!("{} is not a text file.", shown(file)));
    }
    let cut = (size > bytes.len() as u64).then_some(size);
    Ok((String::from_utf8_lossy(&bytes).into_owned(), cut))
}

fn clipped(line: &str) -> String {
    match line.char_indices().nth(MATCH_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_owned(),
    }
}

/// Visit everything under `starts`, to `SEARCH_DEPTH` folders down and `SEARCH_VISITS` entries,
/// until `visit` says stop; true when it went everywhere. Symlinks are not followed: a link out
/// of a root would be a way out of it.
fn walk(starts: Vec<PathBuf>, mut visit: impl FnMut(&Path, FileType) -> bool) -> bool {
    let mut visits = 0;
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
            if !visit(&entry_path, kind) || visits >= SEARCH_VISITS {
                return false;
            }
            if kind.is_dir() && depth < SEARCH_DEPTH {
                stack.push((entry_path, depth + 1));
            }
        }
    }
    true
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
    fn a_long_file_is_read_a_page_at_a_time_and_each_page_says_how_to_read_on() {
        let (root, _outside, files) = setup();
        let notes: String = (1..=400)
            .map(|n| format!("Herb {n}: a line about it, long enough to fill a page.\n"))
            .collect();
        std::fs::write(root.0.join("herbs.txt"), &notes).expect("write");
        let first = files.call("read_text_file", &args(&[("path", "herbs.txt")]));
        assert!(!first.is_error);
        assert!(first.text.starts_with("Herb 1:"));
        assert!(first.text.len() < PAGE_BYTES + 200);
        let (_, footer) = first.text.rsplit_once('\n').expect("a footer");
        assert!(
            footer.starts_with("[lines 1–") && footer.contains("of 400. Not the whole file"),
            "{footer}"
        );
        let next: usize = footer
            .split("from_line ")
            .nth(1)
            .and_then(|rest| rest.trim_end_matches(".]").parse().ok())
            .expect("the line to read on from");
        // As a number, or as some models send it, a string.
        let mut on = args(&[("path", "herbs.txt")]);
        on.insert("from_line".into(), Value::from(next));
        let second = files.call("read_text_file", &on);
        assert!(
            second.text.starts_with(&format!("Herb {next}:")),
            "{}",
            second.text
        );
        let last = files.call(
            "read_text_file",
            &args(&[("path", "herbs.txt"), ("from_line", "400")]),
        );
        assert!(last.text.starts_with("Herb 400:"));
        assert!(
            last.text
                .ends_with("[lines 400–400 of 400: the end of the file.]"),
            "{}",
            last.text
        );
        let past = files.call(
            "read_text_file",
            &args(&[("path", "herbs.txt"), ("from_line", "401")]),
        );
        assert!(past.is_error && past.text.contains("has 400 lines"));
        let nonsense = files.call(
            "read_text_file",
            &args(&[("path", "herbs.txt"), ("from_line", "soon")]),
        );
        assert!(nonsense.is_error);
    }

    #[test]
    fn a_line_longer_than_a_page_and_a_file_past_the_read_limit_say_so() {
        let (root, _outside, files) = setup();
        std::fs::write(root.0.join("long.txt"), "é".repeat(READ_LIMIT)).expect("write");
        let read = files.call("read_text_file", &args(&[("path", "long.txt")]));
        assert!(read.text.contains("… [this line goes on]"));
        assert!(
            read.text.ends_with("only the first 4 MB can be read."),
            "{}",
            read.text
        );
        assert!(read.text.len() < PAGE_BYTES + 300);
    }

    #[test]
    fn search_text_finds_the_line_in_a_file_or_a_folder_and_skips_what_is_not_text() {
        let (root, _outside, files) = setup();
        std::fs::write(
            root.0.join("garden").join("more.txt"),
            "Rose\nYarrow, Achillea millefolium\n",
        )
        .expect("write");
        let everywhere = files.call("search_text", &args(&[("text", "achillea")]));
        assert!(!everywhere.is_error);
        assert!(
            everywhere
                .text
                .contains("more.txt:2: Yarrow, Achillea millefolium"),
            "{}",
            everywhere.text
        );
        assert!(everywhere.text.ends_with("from_line.]"));
        let one = files.call(
            "search_text",
            &args(&[("text", "THYME"), ("path", "garden/Herbs.md")]),
        );
        assert!(
            one.text.contains("Herbs.md:1: Basil, thyme."),
            "{}",
            one.text
        );
        let none = files.call("search_text", &args(&[("text", "mandrake")]));
        assert!(
            none.text.starts_with("No line contains \"mandrake\""),
            "{}",
            none.text
        );
        assert!(files.call("search_text", &args(&[("text", "")])).is_error);
        let lines: String = (0..100).map(|n| format!("sage {n}\n")).collect();
        std::fs::write(root.0.join("sage.txt"), lines).expect("write");
        let many = files.call(
            "search_text",
            &args(&[("text", "sage"), ("path", "sage.txt")]),
        );
        assert_eq!(
            many.text
                .lines()
                .filter(|line| line.contains("sage.txt:"))
                .count(),
            TEXT_MATCHES
        );
        assert!(many.text.contains("stopped early"));
    }
}
