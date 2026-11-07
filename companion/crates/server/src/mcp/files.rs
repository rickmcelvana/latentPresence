//! Files: the companion's own MCP server, inside the roots `mcp.json` names (ADR-43). It reads in
//! every root and, since ADR-73, makes spreadsheets and documents in the roots opened for writing
//! (`files.write`), never over a file she did not make (`office.rs`).
//!
//! Every path is canonicalised and must stay under a canonical root, so `..` and a symlink that
//! points out are refused alike.
//!
//! A file is read a page at a time, and every page but a whole file says where it stops and how
//! to read on: the page cuts a tool result at 8 000 characters, and in R-29 she took the end of
//! that cut for the end of the notes and said a herb further down was not there.

use std::fs::FileType;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::office;
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
/// The largest spreadsheet or document read or edited (they are zipped XML).
const OFFICE_LIMIT: u64 = 20 * 1024 * 1024;
/// The most rows of a sheet one `read_spreadsheet` shows.
const SHEET_ROWS: usize = 80;

pub struct FilesServer {
    /// Canonical, as the filesystem names them.
    roots: Vec<PathBuf>,
    /// The folders she may also write in (ADR-73): canonical, each a root or inside one.
    writable: Vec<PathBuf>,
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
    /// The roots that exist, canonicalised, and the folders of `writable` inside them; the ones
    /// that are not are returned with why.
    pub fn new(roots: &[PathBuf], writable: &[PathBuf]) -> (Self, Vec<String>) {
        let mut kept = Vec::new();
        let mut problems = Vec::new();
        for root in roots {
            match root.canonicalize() {
                Ok(path) if path.is_dir() => kept.push(path),
                Ok(_) => problems.push(format!("{} is not a folder", root.display())),
                Err(error) => problems.push(format!("{}: {error}", root.display())),
            }
        }
        let mut open = Vec::new();
        for folder in writable {
            match folder.canonicalize() {
                Ok(path) if path.is_dir() && kept.iter().any(|root| path.starts_with(root)) => {
                    open.push(path);
                }
                Ok(_) => problems.push(format!(
                    "{} is open for writing but is not one of the Files folders",
                    folder.display()
                )),
                Err(error) => problems.push(format!("{}: {error}", folder.display())),
            }
        }
        (
            Self {
                roots: kept,
                writable: open,
            },
            problems,
        )
    }

    pub fn has_roots(&self) -> bool {
        !self.roots.is_empty()
    }

    /// Whether any folder is open for writing, so the write tools are offered.
    pub fn can_write(&self) -> bool {
        !self.writable.is_empty()
    }

    pub fn tools(&self) -> Vec<ToolInfo> {
        let mut tools = Self::read_tools();
        if self.can_write() {
            tools.extend(Self::write_tools());
        }
        tools
    }

    fn read_tools() -> Vec<ToolInfo> {
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
                read_only.clone(),
            ),
            ToolInfo::new(
                "read_spreadsheet",
                "Read a spreadsheet (.xlsx, .xls or .ods): each row's cells by name (A1: …, B1: …), formulas as formulas, a page of rows at a time. Leave sheet out for the first; the answer names the others.",
                json!({ "type": "object", "properties": {
                    "path": path("The spreadsheet: absolute, or relative to an allowed folder."),
                    "sheet": { "type": "string", "description": "The sheet's name; leave it out for the first." },
                    "from_row": { "type": "integer", "minimum": 1, "description": "The row to start at; 1, or leave it out, for the top." }
                }, "required": ["path"] }),
                read_only.clone(),
            ),
            ToolInfo::new(
                "read_document",
                "Read a Word document (.docx) as Markdown, one line per paragraph: # title, ## headings, - and 1. lists, **bold**, *italic*. A long one comes a page of lines at a time.",
                json!({ "type": "object", "properties": {
                    "path": path("The document: absolute, or relative to an allowed folder."),
                    "from_line": { "type": "integer", "minimum": 1, "description": "The line to start at; 1, or leave it out, for the start." }
                }, "required": ["path"] }),
                read_only,
            ),
        ]
    }

    fn write_tools() -> Vec<ToolInfo> {
        let writes = json!({ "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false });
        let target = |kind: &str| json!({ "type": "string", "description": format!("Where, ending in .{kind}: a file name for the first folder you may write in, or a path inside one. The folder must exist.") });
        let replace = json!({ "type": "boolean", "description": "true to write over a file you made before. A file you did not make is never written over." });
        let cell = json!({ "anyOf": [{ "type": "string" }, { "type": "number" }, { "type": "boolean" }, { "type": "null" }] });
        vec![
            ToolInfo::new(
                "write_spreadsheet",
                "Make a spreadsheet (.xlsx) in a folder you may write in, or replace one you made. Each sheet has a name and rows, the first row its headings. A cell is text, a number, true or false, or a formula starting with = (like =SUM(B2:B9)), so totals stay right when a number changes. formats gives each column's kind: text, number, money, percent or date (dates written 2026-11-06).",
                json!({ "type": "object", "properties": {
                    "path": target("xlsx"),
                    "sheets": { "type": "array", "minItems": 1, "maxItems": office::MAX_SHEETS, "items": { "type": "object", "properties": {
                        "name": { "type": "string", "description": "The sheet's tab name, up to 31 characters." },
                        "rows": { "type": "array", "items": { "type": "array", "items": cell } },
                        "formats": { "type": "array", "description": "One per column, left to right.", "items": { "type": "string", "enum": ["text", "number", "money", "percent", "date"] } },
                        "header": { "type": "boolean", "description": "Whether the first row is headings (bold, kept in view). Yes when left out." }
                    }, "required": ["name", "rows"] } },
                    "replace": replace.clone()
                }, "required": ["path", "sheets"] }),
                writes.clone(),
            ),
            ToolInfo::new(
                "write_document",
                "Write a Word document (.docx) in a folder you may write in, or replace one you made, from Markdown: # title, ## and ### headings, - bullets, 1. numbered items, **bold**, *italic*, a blank line between paragraphs. To change part of one, use edit_document.",
                json!({ "type": "object", "properties": {
                    "path": target("docx"),
                    "markdown": { "type": "string", "description": "The whole document." },
                    "replace": replace
                }, "required": ["path", "markdown"] }),
                writes.clone(),
            ),
            ToolInfo::new(
                "edit_document",
                "Change part of a Word document (.docx) you made: the text in find, as read_document shows it, becomes replace_with. find must appear exactly once, so give enough of it; leave find empty to add replace_with at the end.",
                json!({ "type": "object", "properties": {
                    "path": { "type": "string", "description": "The document: absolute, or relative to a folder you may write in." },
                    "find": { "type": "string", "description": "Text the document has now, exactly as read_document shows it." },
                    "replace_with": { "type": "string", "description": "What it becomes, in the same Markdown. Empty to delete it." }
                }, "required": ["path", "find", "replace_with"] }),
                writes,
            ),
        ]
    }

    pub fn call(&self, name: &str, args: &serde_json::Map<String, Value>) -> CallOutcome {
        let arg = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").trim();
        let raw = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("");
        let replace = args
            .get("replace")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match name {
            "list_allowed_directories" => text(
                self.roots
                    .iter()
                    .map(|root| {
                        let mut line = shown(root);
                        if self.writable.contains(root) {
                            line.push_str("  (you may write here)");
                        } else if self.writable.iter().any(|open| open.starts_with(root)) {
                            line.push_str("  (you may write in some folders inside)");
                        }
                        line
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            "read_spreadsheet" => match from_line(args.get("from_row")) {
                Ok(from) => self.read_spreadsheet(arg("path"), arg("sheet"), from),
                Err(_) => refuse("from_row is a row number: 1 or more."),
            },
            "read_document" => match from_line(args.get("from_line")) {
                Ok(from) => self.read_document(arg("path"), from),
                Err(why) => refuse(why),
            },
            "write_spreadsheet" | "write_document" | "edit_document" if !self.can_write() => {
                refuse(NOT_OPEN)
            }
            "write_spreadsheet" => match office::sheets_from(args.get("sheets")) {
                Ok(sheets) => self.write_spreadsheet(arg("path"), &sheets, replace),
                Err(why) => refuse(why),
            },
            "write_document" => self.write_document(arg("path"), raw("markdown"), replace),
            "edit_document" => self.edit_document(arg("path"), raw("find"), raw("replace_with")),
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
        // A bare name is also looked for in the folders open for writing, where she makes files
        // by a bare name (live, 2026-11-06: she could not read back the letter she had just written).
        let candidates: Vec<PathBuf> = if given.is_absolute() {
            vec![given.to_path_buf()]
        } else {
            self.roots
                .iter()
                .chain(&self.writable)
                .map(|root| root.join(given))
                .collect()
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
        let Some(LinesPage { page, next, total }) = lines_page(&content, from_line, PAGE_BYTES)
        else {
            let total = content.split_inclusive('\n').count();
            return refuse(format!(
                "{} has {total} lines; there is no line {from_line}.",
                shown(&file)
            ));
        };
        if from_line == 1 && next == total && size.is_none() {
            return text(content);
        }
        let mut out = page;
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

const NOT_OPEN: &str =
    "No Files folder is open for writing. The person can open one in Settings → Companion → Files.";

/// Office (ADR-73): reading spreadsheets and documents in every root, writing them in the open ones.
impl FilesServer {
    /// An existing spreadsheet or document to read, with its bytes.
    fn office_file(&self, path: &str, kinds: &[&str]) -> Result<(PathBuf, Vec<u8>), String> {
        if path.is_empty() {
            return Err(format!("Give the path of the file ({}).", kinds.join(", ")));
        }
        let file = self.resolve(path)?;
        if !has_extension(&file, kinds) {
            return Err(format!(
                "{} is not a {} file; read_text_file reads text.",
                shown(&file),
                kinds.join(" or ")
            ));
        }
        let size = std::fs::metadata(&file)
            .map_err(|error| format!("{} could not be read: {error}", shown(&file)))?
            .len();
        if size > OFFICE_LIMIT {
            return Err(format!(
                "{} is {size} bytes; only files up to {} MB are read.",
                shown(&file),
                OFFICE_LIMIT / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(&file)
            .map_err(|error| format!("{} could not be read: {error}", shown(&file)))?;
        Ok((file, bytes))
    }

    fn read_spreadsheet(&self, path: &str, sheet: &str, from_row: usize) -> CallOutcome {
        match self.office_file(path, &["xlsx", "xls", "ods"]) {
            Ok((file, bytes)) => {
                match office::spreadsheet_text(&bytes, sheet, from_row, SHEET_ROWS, PAGE_BYTES) {
                    Ok(content) => text(format!("{}\n{content}", shown(&file))),
                    Err(why) => refuse(format!("{} {why}.", shown(&file))),
                }
            }
            Err(why) => refuse(why),
        }
    }

    fn read_document(&self, path: &str, from_line: usize) -> CallOutcome {
        let (file, bytes) = match self.office_file(path, &["docx"]) {
            Ok(read) => read,
            Err(why) => return refuse(why),
        };
        let markdown = match office::document_markdown(&bytes) {
            Ok(markdown) => markdown,
            Err(why) => return refuse(format!("{} {why}.", shown(&file))),
        };
        let mine = if office::made_by_her(&bytes) {
            "You made this one; edit_document changes it."
        } else {
            "You did not make this one, so you may read it but not change it."
        };
        if markdown.trim().is_empty() {
            return text(format!("{} has no text. {mine}", shown(&file)));
        }
        let Some(LinesPage { page, next, total }) = lines_page(&markdown, from_line, PAGE_BYTES)
        else {
            return refuse(format!(
                "{} has fewer than {from_line} lines.",
                shown(&file)
            ));
        };
        let place = if next < total {
            format!(
                "[lines {from_line}–{next} of {total}. Not the whole document: read on with from_line {}.]",
                next + 1
            )
        } else if from_line == 1 {
            "[the whole document]".to_owned()
        } else {
            format!("[lines {from_line}–{next} of {total}: the end.]")
        };
        text(format!("{}\n{mine}\n\n{page}\n{place}", shown(&file)))
    }

    /// Where a file she writes goes: inside a folder open for writing, in a folder that exists,
    /// with the right extension. A relative path is tried in each open folder in turn.
    fn target(&self, path: &str, kind: &str) -> Result<PathBuf, String> {
        let open = || {
            self.writable
                .iter()
                .map(|folder| shown(folder))
                .collect::<Vec<_>>()
                .join(", ")
        };
        if path.is_empty() {
            return Err(format!("Give the file's name, ending in .{kind}."));
        }
        let given = Path::new(path);
        let Some(name) = given.file_name().and_then(|name| name.to_str()) else {
            return Err(format!("{path} does not end in a file name."));
        };
        if !has_extension(given, &[kind]) {
            return Err(format!("{name} must end in .{kind}."));
        }
        if name.starts_with('.') || name.starts_with("~$") {
            return Err(format!("{name} is not a name she gives a file."));
        }
        // Relative: in an open folder; else from a root or from beside an open folder, as models
        // often name the folder itself ("Office/Letter.docx"; live, 2026-11-06, gemma4 and qwen3.5).
        let candidates: Vec<PathBuf> = if given.is_absolute() {
            vec![given.to_path_buf()]
        } else {
            let beside = |folder: &PathBuf| folder.parent().map(|parent| parent.join(given));
            self.writable
                .iter()
                .map(|folder| folder.join(given))
                .chain(self.roots.iter().map(|root| root.join(given)))
                .chain(self.writable.iter().filter_map(beside))
                .chain(self.roots.iter().filter_map(beside))
                .collect()
        };
        let hint = format!(
            " Give just a file name, like \"Budget.{kind}\", and it goes in {}.",
            self.writable
                .first()
                .map(|folder| shown(folder))
                .unwrap_or_default()
        );
        let mut outside = false;
        for candidate in candidates {
            let Some(parent) = candidate.parent() else {
                continue;
            };
            let Ok(folder) = parent.canonicalize() else {
                continue;
            };
            if !self.writable.iter().any(|open| folder.starts_with(open)) {
                outside = true;
                continue;
            }
            let file = folder.join(name);
            // A link that points somewhere else is not written through.
            if std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.file_type().is_symlink()) {
                return Err(format!(
                    "{} is a link; she does not write through links.",
                    shown(&file)
                ));
            }
            if file.is_dir() {
                return Err(format!("{} is a folder.", shown(&file)));
            }
            return Ok(file);
        }
        Err(if outside {
            format!(
                "{path} is outside the folders you may write in ({}).{hint}",
                open()
            )
        } else {
            format!(
                "The folder for {path} does not exist in the folders you may write in ({}); files go only into folders that are there.{hint}",
                open()
            )
        })
    }

    /// Writes `bytes` to `file`, refusing to replace one she did not make, or one of hers unasked.
    fn put(&self, file: &Path, bytes: &[u8], replace: bool) -> Result<bool, String> {
        let existed = file.exists();
        if existed {
            let current = std::fs::read(file)
                .map_err(|error| format!("{} could not be checked: {error}", shown(file)))?;
            if !office::made_by_her(&current) {
                return Err(format!(
                    "{} is already there and you did not make it, so it is left as it is. Choose another name.",
                    shown(file)
                ));
            }
            if !replace {
                return Err(format!(
                    "{} is already there (you made it). Say replace: true to write over it, or choose another name.",
                    shown(file)
                ));
            }
        }
        // Written beside it, then moved into place, so a failure never leaves half a file.
        let name = file
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let staging = file.with_file_name(format!(".{name}.writing"));
        std::fs::write(&staging, bytes)
            .map_err(|error| format!("{} could not be written: {error}", shown(file)))?;
        if let Err(error) = std::fs::rename(&staging, file) {
            let _ = std::fs::remove_file(&staging);
            return Err(format!(
                "{} could not be written ({error}); if it is open in another program, close it and ask again.",
                shown(file)
            ));
        }
        Ok(existed)
    }

    fn write_spreadsheet(
        &self,
        path: &str,
        sheets: &[office::Sheet],
        replace: bool,
    ) -> CallOutcome {
        let file = match self.target(path, "xlsx") {
            Ok(file) => file,
            Err(why) => return refuse(why),
        };
        let title = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = match office::spreadsheet_bytes(sheets, &title) {
            Ok(bytes) => bytes,
            Err(why) => return refuse(why),
        };
        match self.put(&file, &bytes, replace) {
            Ok(replaced) => {
                let rows: usize = sheets.iter().map(|sheet| sheet.rows.len()).sum();
                let names = sheets
                    .iter()
                    .map(|sheet| sheet.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                text(format!(
                    "{} {}: {} sheet{} ({names}), {rows} row{}.",
                    if replaced { "Replaced" } else { "Made" },
                    shown(&file),
                    sheets.len(),
                    if sheets.len() == 1 { "" } else { "s" },
                    if rows == 1 { "" } else { "s" },
                ))
            }
            Err(why) => refuse(why),
        }
    }

    fn write_document(&self, path: &str, markdown: &str, replace: bool) -> CallOutcome {
        if markdown.trim().is_empty() {
            return refuse("Give the document's text as markdown.");
        }
        if markdown.chars().count() > office::MAX_DOCUMENT_CHARS {
            return refuse(format!(
                "A document here is at most {} characters.",
                office::MAX_DOCUMENT_CHARS
            ));
        }
        let file = match self.target(path, "docx") {
            Ok(file) => file,
            Err(why) => return refuse(why),
        };
        let stem = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let bytes = match office::document_bytes(markdown, &office::document_title(markdown, &stem))
        {
            Ok(bytes) => bytes,
            Err(why) => return refuse(why),
        };
        match self.put(&file, &bytes, replace) {
            Ok(replaced) => text(format!(
                "{} {}: {} paragraph{}.",
                if replaced { "Replaced" } else { "Wrote" },
                shown(&file),
                office::paragraphs(markdown),
                if office::paragraphs(markdown) == 1 {
                    ""
                } else {
                    "s"
                },
            )),
            Err(why) => refuse(why),
        }
    }

    fn edit_document(&self, path: &str, find: &str, with: &str) -> CallOutcome {
        let file = match self.target(path, "docx") {
            Ok(file) => file,
            Err(why) => return refuse(why),
        };
        if !file.exists() {
            return refuse(format!(
                "There is no {} to edit; write_document makes one.",
                shown(&file)
            ));
        }
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(error) => return refuse(format!("{} could not be read: {error}", shown(&file))),
        };
        if !office::made_by_her(&bytes) {
            return refuse(format!(
                "You did not make {}, so it is left as it is. write_document can make a new one from it under another name.",
                shown(&file)
            ));
        }
        let current = match office::document_markdown(&bytes) {
            Ok(markdown) => markdown,
            Err(why) => return refuse(format!("{} {why}.", shown(&file))),
        };
        let edited = if find.trim().is_empty() {
            format!("{}\n\n{}", current.trim_end(), with.trim())
        } else {
            match current.matches(find).count() {
                1 => current.replacen(find, with, 1),
                0 => {
                    return refuse(format!(
                        "\"{}\" is not in {}. Read it with read_document and give find exactly as it is there.",
                        clipped(find),
                        shown(&file)
                    ));
                }
                many => {
                    return refuse(format!(
                        "\"{}\" is in {} {many} times; give more of the text around the one to change.",
                        clipped(find),
                        shown(&file)
                    ));
                }
            }
        };
        if edited.chars().count() > office::MAX_DOCUMENT_CHARS {
            return refuse(format!(
                "A document here is at most {} characters.",
                office::MAX_DOCUMENT_CHARS
            ));
        }
        let stem = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let written = office::document_bytes(&edited, &office::document_title(&edited, &stem))
            .and_then(|bytes| self.put(&file, &bytes, true));
        match written {
            Ok(_) => text(format!(
                "Changed {}; it has {} paragraph{} now.",
                shown(&file),
                office::paragraphs(&edited),
                if office::paragraphs(&edited) == 1 {
                    ""
                } else {
                    "s"
                },
            )),
            Err(why) => refuse(why),
        }
    }
}

fn has_extension(path: &Path, kinds: &[&str]) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| kinds.iter().any(|kind| ext.eq_ignore_ascii_case(kind)))
}

/// One page of whole lines of `content` from line `from_line` (1-based), trimmed at its end.
pub struct LinesPage {
    pub page: String,
    /// The line after the page (1-based), or `total` when the page reached the end.
    pub next: usize,
    pub total: usize,
}

/// A page of `content` within `page_bytes`, starting at `from_line`; `None` when there is no such
/// line. Shared by Files and the web's `read_page`, so both read on the same way.
pub fn lines_page(content: &str, from_line: usize, page_bytes: usize) -> Option<LinesPage> {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let total = lines.len();
    if from_line == 0 || from_line > total.max(1) {
        return None;
    }
    let first = from_line - 1;
    let mut page = String::new();
    let mut next = first;
    while next < total && (next == first || page.len() + lines[next].len() <= page_bytes) {
        page.push_str(lines[next]);
        next += 1;
    }
    // One line longer than a page: its start, at a character boundary.
    if page.len() > page_bytes {
        let mut at = page_bytes;
        while !page.is_char_boundary(at) {
            at -= 1;
        }
        page.truncate(at);
        page.push_str("… [this line goes on]");
    }
    Some(LinesPage {
        page: page.trim_end().to_owned(),
        next,
        total,
    })
}

/// `from_line` as given: a number, or a number in a string, as some models send it.
pub fn from_line(value: Option<&Value>) -> Result<usize, String> {
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
        let (server, problems) = FilesServer::new(&[root.0.clone(), root.0.join("missing")], &[]);
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

    fn json_args(value: Value) -> serde_json::Map<String, Value> {
        value.as_object().expect("an object").clone()
    }

    /// A root with `notes` read-only and `office` open for writing (ADR-73).
    fn office_setup() -> (Scratch, FilesServer) {
        let root = Scratch::new("office");
        std::fs::create_dir_all(root.0.join("office")).expect("mkdir");
        std::fs::create_dir_all(root.0.join("notes")).expect("mkdir");
        let (server, problems) = FilesServer::new(
            std::slice::from_ref(&root.0),
            &[root.0.join("office"), root.0.join("elsewhere")],
        );
        assert_eq!(problems.len(), 1, "{problems:?}");
        (root, server)
    }

    #[test]
    fn the_write_tools_are_offered_only_with_a_folder_open_for_writing() {
        let (_root, _outside, read_only) = setup();
        let names = |files: &FilesServer| {
            files
                .tools()
                .into_iter()
                .map(|tool| tool.name)
                .collect::<Vec<_>>()
        };
        assert!(!read_only.can_write());
        assert!(names(&read_only).contains(&"read_spreadsheet".to_owned()));
        assert!(!names(&read_only).contains(&"write_spreadsheet".to_owned()));
        let refused = read_only.call(
            "write_document",
            &json_args(json!({ "path": "a.docx", "markdown": "Hi" })),
        );
        assert!(
            refused.is_error && refused.text.contains("No Files folder is open for writing"),
            "{}",
            refused.text
        );
        let (_root, files) = office_setup();
        assert!(names(&files).ends_with(&[
            "write_spreadsheet".to_owned(),
            "write_document".to_owned(),
            "edit_document".to_owned()
        ]));
        let listed = files.call("list_allowed_directories", &args(&[]));
        assert!(
            listed
                .text
                .ends_with("(you may write in some folders inside)"),
            "{}",
            listed.text
        );
    }

    #[test]
    fn she_makes_a_spreadsheet_in_the_open_folder_and_reads_it_back() {
        let (root, files) = office_setup();
        let sheet = json!({ "path": "Grocery budget.xlsx", "sheets": [{ "name": "November", "formats": ["text", "money"], "rows": [["Item", "Budget"], ["Milk", 6.5], ["Total", "=SUM(B2:B2)"]] }] });
        let made = files.call("write_spreadsheet", &json_args(sheet.clone()));
        assert!(!made.is_error, "{}", made.text);
        assert!(
            made.text.starts_with("Made ") && made.text.ends_with("1 sheet (November), 3 rows."),
            "{}",
            made.text
        );
        assert!(root.0.join("office").join("Grocery budget.xlsx").is_file());
        let again = files.call("write_spreadsheet", &json_args(sheet.clone()));
        assert!(
            again.is_error && again.text.contains("replace: true"),
            "{}",
            again.text
        );
        let mut replacing = sheet;
        replacing["replace"] = json!(true);
        assert!(
            files
                .call("write_spreadsheet", &json_args(replacing))
                .text
                .starts_with("Replaced ")
        );
        let read = files.call(
            "read_spreadsheet",
            &json_args(json!({ "path": "office/Grocery budget.xlsx" })),
        );
        assert!(
            read.text.contains("A3: Total | B3: =SUM(B2:B2)"),
            "{}",
            read.text
        );
        // No half-written file is left beside it.
        let left: Vec<_> = std::fs::read_dir(root.0.join("office"))
            .expect("lists")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .collect();
        assert_eq!(left.len(), 1, "{left:?}");
    }

    #[test]
    fn she_writes_and_edits_a_document_and_never_one_she_did_not_make() {
        let (root, files) = office_setup();
        let wrote = files.call(
            "write_document",
            &json_args(json!({ "path": "Plan.docx", "markdown": "# Plan\n\n- Shop\n- Cook" })),
        );
        assert!(
            wrote.text.ends_with("Plan.docx: 3 paragraphs."),
            "{}",
            wrote.text
        );
        let edited = files.call(
            "edit_document",
            &json_args(
                json!({ "path": "Plan.docx", "find": "- Cook", "replace_with": "- Cook soup" }),
            ),
        );
        assert!(!edited.is_error, "{}", edited.text);
        let added = files.call(
            "edit_document",
            &json_args(json!({ "path": "Plan.docx", "find": "", "replace_with": "Then rest." })),
        );
        assert!(added.text.ends_with("4 paragraphs now."), "{}", added.text);
        let read = files.call("read_document", &json_args(json!({ "path": "Plan.docx" })));
        assert!(
            read.text.contains("You made this one")
                && read
                    .text
                    .contains("# Plan\n\n- Shop\n- Cook soup\n\nThen rest.\n[the whole document]"),
            "{}",
            read.text
        );
        let missing = files.call(
            "edit_document",
            &json_args(json!({ "path": "Plan.docx", "find": "- Bake", "replace_with": "x" })),
        );
        assert!(
            missing.is_error && missing.text.contains("is not in"),
            "{}",
            missing.text
        );

        // Someone else's document in the open folder: read, never written over or edited.
        let mut zipped = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zipped
            .start_file(
                "word/document.xml",
                zip::write::SimpleFileOptions::default(),
            )
            .expect("part");
        std::io::Write::write_all(&mut zipped, br#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Theirs</w:t></w:r></w:p></w:body></w:document>"#).expect("writes");
        let theirs = zipped.finish().expect("zips").into_inner();
        std::fs::write(root.0.join("office").join("Theirs.docx"), &theirs).expect("write");
        let read = files.call(
            "read_document",
            &json_args(json!({ "path": "office/Theirs.docx" })),
        );
        assert!(
            read.text.contains("You did not make this one") && read.text.contains("Theirs"),
            "{}",
            read.text
        );
        let over = files.call(
            "write_document",
            &json_args(json!({ "path": "Theirs.docx", "markdown": "Mine now", "replace": true })),
        );
        assert!(
            over.is_error && over.text.contains("you did not make it"),
            "{}",
            over.text
        );
        let edit = files.call(
            "edit_document",
            &json_args(json!({ "path": "Theirs.docx", "find": "Theirs", "replace_with": "x" })),
        );
        assert!(
            edit.is_error && edit.text.contains("You did not make"),
            "{}",
            edit.text
        );
    }

    #[test]
    fn writing_stays_in_the_open_folders_with_the_right_kind_of_name() {
        let (root, files) = office_setup();
        let write = |path: &str| {
            files.call(
                "write_document",
                &json_args(json!({ "path": path, "markdown": "Hi" })),
            )
        };
        let read_only = root.0.join("notes").join("a.docx").display().to_string();
        assert!(
            write(&read_only)
                .text
                .contains("outside the folders you may write in")
        );
        assert!(
            write("../notes/a.docx")
                .text
                .contains("outside the folders you may write in")
        );
        assert!(write("missing/a.docx").text.contains("does not exist"));
        assert!(write("missing/a.docx").text.ends_with(&format!(
            "Give just a file name, like \"Budget.docx\", and it goes in {}.",
            shown(&root.0.join("office").canonicalize().unwrap())
        )));
        // The open folder named in the path, as models write it, is the open folder.
        assert!(write("office/named.docx").text.ends_with("1 paragraph."));
        assert!(root.0.join("office").join("named.docx").is_file());
        assert!(write("a.txt").text.contains("must end in .docx"));
        assert!(write(".hidden.docx").text.contains("not a name"));
        assert!(write("").is_error);
        assert!(!root.0.join("notes").join("a.docx").exists());
    }
}
