//! Walking a folder for the files worth indexing (ADR-44): the supported extensions, no
//! symlinks, nothing hidden, nothing over 100 MB.

use std::path::{Path, PathBuf};

use chrono::{NaiveDateTime, Timelike};

/// Bigger than this is not read: a scanned book is one thing, a disk image another.
pub const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// A supported file found on disk, with what a scan compares before it reads anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundFile {
    pub path: PathBuf,
    pub bytes: u64,
    /// UTC, to the millisecond: the precision `DATETIME(3)` keeps, so a stored time compares
    /// equal to the one read again.
    pub modified_at: NaiveDateTime,
}

#[derive(Debug, Default)]
pub struct Walk {
    pub files: Vec<FoundFile>,
    /// Folders it could not read, and why. What was in them is neither seen nor removed.
    pub problems: Vec<(PathBuf, String)>,
}

/// Every supported file under `root`, in path order. Errors inside the tree are `problems`,
/// not a failed walk; the root itself being unreadable is the first problem and nothing else.
pub fn walk(root: &Path) -> Walk {
    let mut found = Walk::default();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                found.problems.push((directory, error.to_string()));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    found.problems.push((directory.clone(), error.to_string()));
                    continue;
                }
            };
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            // `DirEntry::file_type` does not follow a symlink: a link is a link, and skipped.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() && latentpresence_ingest::is_supported(&path) {
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        found.problems.push((path, error.to_string()));
                        continue;
                    }
                };
                if metadata.len() > MAX_FILE_BYTES {
                    continue;
                }
                let Ok(modified) = metadata.modified() else {
                    continue;
                };
                found.files.push(FoundFile {
                    path,
                    bytes: metadata.len(),
                    modified_at: to_millis(modified),
                });
            }
        }
    }
    found.files.sort_by(|a, b| a.path.cmp(&b.path));
    found
}

fn to_millis(time: std::time::SystemTime) -> NaiveDateTime {
    let utc = chrono::DateTime::<chrono::Utc>::from(time).naive_utc();
    utc.with_nanosecond(utc.nanosecond() / 1_000_000 * 1_000_000)
        .unwrap_or(utc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("dirs");
        std::fs::write(path, bytes).expect("writes");
    }

    #[test]
    fn it_finds_the_supported_files_in_any_case_at_any_depth_in_path_order() {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in [
            "b.pdf",
            "a.MD",
            "sub/c.Docx",
            "sub/deeper/d.htm",
            "sub/deeper/e.html",
            "f.markdown",
            "g.txt",
        ] {
            touch(&dir.path().join(name), b"x");
        }
        let found = walk(dir.path());
        let names: Vec<String> = found
            .files
            .iter()
            .map(|file| {
                file.path
                    .strip_prefix(dir.path())
                    .expect("under the root")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        assert_eq!(
            names,
            [
                "a.MD",
                "b.pdf",
                "f.markdown",
                "g.txt",
                "sub/c.Docx",
                "sub/deeper/d.htm",
                "sub/deeper/e.html"
            ]
        );
        assert!(found.problems.is_empty());
        assert!(found.files.iter().all(|file| file.bytes == 1));
    }

    #[test]
    fn it_skips_other_kinds_hidden_names_and_what_is_too_big() {
        let dir = tempfile::tempdir().expect("temp dir");
        touch(&dir.path().join("keep.txt"), b"x");
        touch(&dir.path().join("photo.jpg"), b"x");
        touch(&dir.path().join("archive.pdf.bak"), b"x");
        touch(&dir.path().join(".secret.txt"), b"x");
        touch(&dir.path().join(".git/notes.txt"), b"x");
        touch(&dir.path().join("sub/.hidden/notes.txt"), b"x");
        let huge = dir.path().join("huge.pdf");
        let file = std::fs::File::create(&huge).expect("creates");
        file.set_len(MAX_FILE_BYTES + 1).expect("sparse");
        let found = walk(dir.path());
        let names: Vec<_> = found
            .files
            .iter()
            .filter_map(|file| file.path.file_name()?.to_str())
            .collect();
        assert_eq!(names, ["keep.txt"]);
    }

    #[test]
    fn a_symlink_is_not_followed() {
        let dir = tempfile::tempdir().expect("temp dir");
        let outside = tempfile::tempdir().expect("temp dir");
        touch(&outside.path().join("secret.txt"), b"x");
        touch(&dir.path().join("keep.txt"), b"x");
        let linked = link_dir(outside.path(), &dir.path().join("link"));
        // Making a link needs a privilege on Windows; without it there is nothing to prove.
        if linked.is_err() {
            eprintln!("symlink test skipped: cannot create a link here");
            return;
        }
        let names: Vec<_> = walk(dir.path())
            .files
            .iter()
            .filter_map(|file| Some(file.path.file_name()?.to_str()?.to_owned()))
            .collect();
        assert_eq!(names, ["keep.txt"]);
    }

    #[test]
    fn modified_times_are_whole_milliseconds() {
        let dir = tempfile::tempdir().expect("temp dir");
        touch(&dir.path().join("a.txt"), b"x");
        let file = &walk(dir.path()).files[0];
        assert_eq!(file.modified_at.nanosecond() % 1_000_000, 0);
    }

    #[test]
    fn a_missing_root_is_a_problem_not_a_panic() {
        let dir = tempfile::tempdir().expect("temp dir");
        let found = walk(&dir.path().join("gone"));
        assert!(found.files.is_empty());
        assert_eq!(found.problems.len(), 1);
    }

    #[cfg(windows)]
    fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }
}
