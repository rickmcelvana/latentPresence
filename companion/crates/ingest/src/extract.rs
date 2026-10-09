//! Extractors, one per format (ADR-44; the libraries and their calls were measured on
//! 2026-10-09, `docs/SURFACE.md`).
//!
//! A file that cannot be read is an `Err` with words for the person, never a panic and never
//! a half-result: `pdf-extract` is known to panic on some malformed files, so the PDF path
//! runs under `catch_unwind`.

use std::io::{Cursor, Read};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::Page;

/// The extensions that are indexed, lower case.
pub const EXTENSIONS: [&str; 7] = ["pdf", "docx", "html", "htm", "md", "markdown", "txt"];

/// The longest a title is kept.
const TITLE_CHARS: usize = 200;
/// What one unzipped part of a DOCX may grow to (a zip bomb costs memory before it costs time).
const DOCX_PART_LIMIT: u64 = 256 * 1024 * 1024;
/// How wide `html2text` may wrap. Wide, because the chunker does its own cutting.
const HTML_WIDTH: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub title: String,
    pub mime: &'static str,
    pub pages: Vec<Page>,
}

/// Whether the walker should pick this file up: a supported extension, any case.
pub fn is_supported(path: &Path) -> bool {
    extension(path).is_some_and(|ext| EXTENSIONS.contains(&ext.as_str()))
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
}

/// Read and extract the file at `path`.
pub fn extract(path: &Path) -> Result<Extracted, String> {
    let bytes = std::fs::read(path).map_err(|error| format!("could not be read: {error}"))?;
    extract_bytes(path, &bytes)
}

/// Extract bytes already read, so a caller that hashed them does not read them twice. `path`
/// says what format they are (its extension) and, failing a title, what to call them (its stem).
pub fn extract_bytes(path: &Path, bytes: &[u8]) -> Result<Extracted, String> {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("document")
        .to_owned();
    match extension(path).as_deref() {
        Some("pdf") => pdf(bytes, stem),
        Some("docx") => docx(bytes, stem),
        Some("html" | "htm") => html(bytes, stem),
        Some("md" | "markdown") => {
            let text = String::from_utf8_lossy(bytes).into_owned();
            let title = text
                .lines()
                .find_map(|line| line.strip_prefix("# "))
                .map(|heading| heading.trim().to_owned())
                .filter(|heading| !heading.is_empty())
                .unwrap_or(stem);
            Ok(single(title, "text/markdown", text))
        }
        Some("txt") => Ok(single(
            stem,
            "text/plain",
            String::from_utf8_lossy(bytes).into_owned(),
        )),
        _ => Err("is not a kind of file the companion reads".to_owned()),
    }
}

fn single(title: String, mime: &'static str, text: String) -> Extracted {
    Extracted {
        title: shorten(&title),
        mime,
        pages: vec![Page {
            locator: None,
            text,
        }],
    }
}

fn shorten(title: &str) -> String {
    title.trim().chars().take(TITLE_CHARS).collect()
}

fn pdf(bytes: &[u8], stem: String) -> Result<Extracted, String> {
    // A panic inside the library is this file's failure, not the companion's.
    let pages = catch_unwind(AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem_by_pages(bytes)
    }))
    .map_err(|_| "is a PDF the reader could not make sense of".to_owned())?
    .map_err(|error| format!("could not be read as a PDF: {error}"))?;
    let title = pages
        .first()
        .and_then(|page| page.lines().map(str::trim).find(|line| !line.is_empty()))
        .map(shorten)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| shorten(&stem));
    Ok(Extracted {
        title,
        mime: "application/pdf",
        pages: pages
            .into_iter()
            .enumerate()
            .map(|(index, text)| Page {
                locator: Some(format!("p. {}", index + 1)),
                text,
            })
            .collect(),
    })
}

fn docx(bytes: &[u8], stem: String) -> Result<Extracted, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("could not be read as a DOCX: {error}"))?;
    let mut xml = Vec::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "is not a DOCX (it has no word/document.xml)".to_owned())?
        .take(DOCX_PART_LIMIT)
        .read_to_end(&mut xml)
        .map_err(|error| format!("could not be unzipped: {error}"))?;
    let text = docx_text(&xml)?;
    Ok(single(
        stem,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        text,
    ))
}

/// The text of `word/document.xml`: the content of every `w:t`, a newline at the end of each
/// `w:p`, a tab for each `w:tab`, a newline for each `w:br`. Entity and character references
/// arrive as their own events in quick-xml 0.42 and are put back as the characters they name.
fn docx_text(xml: &[u8]) -> Result<String, String> {
    let mut reader = Reader::from_reader(xml);
    let mut buffer = Vec::new();
    let mut out = String::new();
    let mut in_text = false;
    // `w:tab` inside `w:tabs` is a tab *stop* in a paragraph's properties, not a tab.
    let mut in_tab_stops = false;
    loop {
        match reader.read_event_into(&mut buffer) {
            Err(error) => return Err(format!("has XML that could not be read: {error}")),
            Ok(Event::Eof) => break,
            Ok(Event::Start(element)) => match element.local_name().as_ref() {
                "t" => in_text = true,
                "tabs" => in_tab_stops = true,
                "tab" if !in_tab_stops => out.push('\t'),
                _ => {}
            },
            Ok(Event::Empty(element)) => match element.local_name().as_ref() {
                "tab" if !in_tab_stops => out.push('\t'),
                "br" | "cr" => out.push('\n'),
                _ => {}
            },
            Ok(Event::End(element)) => match element.local_name().as_ref() {
                "t" => in_text = false,
                "tabs" => in_tab_stops = false,
                "p" => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(text)) if in_text => out.push_str(&text.xml10_content()),
            Ok(Event::GeneralRef(reference)) if in_text => match reference.resolve_char_ref() {
                Ok(Some(character)) => out.push(character),
                Ok(None) => match reference.xml10_content().as_ref() {
                    "amp" => out.push('&'),
                    "lt" => out.push('<'),
                    "gt" => out.push('>'),
                    "quot" => out.push('"'),
                    "apos" => out.push('\''),
                    _ => {}
                },
                Err(error) => return Err(format!("has a bad character reference: {error}")),
            },
            Ok(_) => {}
        }
        buffer.clear();
    }
    Ok(out)
}

fn html(bytes: &[u8], stem: String) -> Result<Extracted, String> {
    let text = html2text::from_read(bytes, HTML_WIDTH)
        .map_err(|error| format!("could not be read as HTML: {error}"))?;
    let title = html_title(&String::from_utf8_lossy(bytes)).unwrap_or(stem);
    Ok(single(title, "text/html", text))
}

/// The text of the first `<title>`, with the handful of entities a title carries resolved.
fn html_title(source: &str) -> Option<String> {
    let lower = source.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let from = open + lower[open..].find('>')? + 1;
    let to = from + lower[from..].find("</title")?;
    let title = source[from..to]
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/herb-notes.pdf");

    fn docx_with(document_xml: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("[Content_Types].xml", options)
            .expect("starts a part");
        writer.write_all(b"<Types/>").expect("writes");
        writer
            .start_file("word/document.xml", options)
            .expect("starts a part");
        writer
            .write_all(document_xml.as_bytes())
            .expect("writes the document");
        writer.finish().expect("finishes").into_inner()
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("writes a fixture");
        path
    }

    #[test]
    fn the_pdf_fixture_is_two_pages_with_locators() {
        let extracted = extract(Path::new(FIXTURE)).expect("the fixture reads");
        assert_eq!(extracted.mime, "application/pdf");
        assert_eq!(extracted.pages.len(), 2);
        assert_eq!(extracted.pages[0].locator.as_deref(), Some("p. 1"));
        assert_eq!(extracted.pages[1].locator.as_deref(), Some("p. 2"));
        assert!(extracted.pages[0].text.contains("Basil"));
        assert!(!extracted.pages[0].text.contains("Thyme"));
        assert!(extracted.pages[1].text.contains("Thyme"));
        // The title is the first line of page 1.
        let first_line = extracted.pages[0]
            .text
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .expect("a first line");
        assert_eq!(extracted.title, first_line);
    }

    #[test]
    fn a_corrupt_pdf_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Random-looking bytes, and bytes that start like a PDF and then stop making sense.
        let noise: Vec<u8> = (0..4096u32)
            .map(|n| (n.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        let path = write(dir.path(), "noise.pdf", &noise);
        assert!(extract(&path).is_err());
        let mut truncated = std::fs::read(FIXTURE).expect("fixture");
        truncated.truncate(truncated.len() / 2);
        let path = write(dir.path(), "cut.pdf", &truncated);
        assert!(extract(&path).is_err());
        let path = write(dir.path(), "empty.pdf", b"%PDF-1.4\n");
        assert!(extract(&path).is_err());
    }

    #[test]
    fn a_docx_gives_its_paragraphs_tabs_and_references() {
        let dir = tempfile::tempdir().expect("temp dir");
        let bytes = docx_with(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
              <w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>
                <w:r><w:t>Basil needs water </w:t></w:r><w:r><w:t xml:space="preserve">&amp; sun.</w:t></w:r></w:p>
              <w:p><w:r><w:t>Thyme</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>dry &#233;t&#xE9;.</w:t></w:r></w:p>
              <w:p><w:r><w:instrText>HYPERLINK "ignored"</w:instrText></w:r></w:p>
            </w:body></w:document>"#,
        );
        let path = write(dir.path(), "Garden notes.docx", &bytes);
        let extracted = extract(&path).expect("the DOCX reads");
        assert_eq!(
            extracted.mime,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(extracted.title, "Garden notes");
        assert_eq!(extracted.pages.len(), 1);
        assert_eq!(extracted.pages[0].locator, None);
        // The tab stop in the paragraph's properties is not a tab; the run's `w:tab` is.
        assert_eq!(
            extracted.pages[0].text,
            "Basil needs water & sun.\nThyme\tdry \u{e9}t\u{e9}.\n\n"
        );
    }

    #[test]
    fn a_zip_that_is_not_a_docx_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(dir.path(), "plain.docx", b"not a zip at all");
        assert!(extract(&path).is_err());
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("other.xml", zip::write::SimpleFileOptions::default())
            .expect("starts");
        let bytes = writer.finish().expect("finishes").into_inner();
        let path = write(dir.path(), "wrong.docx", &bytes);
        assert!(
            extract(&path)
                .expect_err("no document part")
                .contains("word/document.xml")
        );
    }

    #[test]
    fn html_gives_its_text_and_its_title() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(
            dir.path(),
            "page.HTML",
            b"<html><head><title>Herb &amp; spice  guide</title></head>\
              <body><h1>Basil</h1><p>Needs water.</p></body></html>",
        );
        let extracted = extract(&path).expect("the HTML reads");
        assert_eq!(extracted.mime, "text/html");
        assert_eq!(extracted.title, "Herb & spice guide");
        assert!(extracted.pages[0].text.contains("Basil"));
        assert!(extracted.pages[0].text.contains("Needs water."));
        assert!(!extracted.pages[0].text.contains("<p>"));
        // No title: the file's name.
        let path = write(dir.path(), "bare.htm", b"<p>Hello</p>");
        assert_eq!(extract(&path).expect("reads").title, "bare");
    }

    #[test]
    fn markdown_and_text_are_read_as_they_are() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(
            dir.path(),
            "notes.md",
            "Intro line\n\n## Not the title\n# The Herb Garden\ntext\n".as_bytes(),
        );
        let extracted = extract(&path).expect("reads");
        assert_eq!(extracted.mime, "text/markdown");
        assert_eq!(extracted.title, "The Herb Garden");
        assert!(extracted.pages[0].text.contains("text"));
        let path = write(dir.path(), "untitled.markdown", b"no heading here");
        assert_eq!(extract(&path).expect("reads").title, "untitled");
        // Bytes that are not UTF-8 are read lossily, not refused.
        let path = write(dir.path(), "latin.txt", &[b'c', b'a', b'f', 0xE9]);
        let extracted = extract(&path).expect("reads");
        assert_eq!(extracted.mime, "text/plain");
        assert_eq!(extracted.title, "latin");
        assert_eq!(extracted.pages[0].text, "caf\u{fffd}");
    }

    #[test]
    fn other_kinds_are_not_supported_and_extensions_match_in_any_case() {
        for name in ["a.PDF", "b.Docx", "c.htm", "d.markdown", "e.TXT"] {
            assert!(is_supported(Path::new(name)), "{name}");
        }
        for name in ["a.exe", "b", "c.pdf.bak", ".md"] {
            assert!(!is_supported(Path::new(name)), "{name}");
        }
        let dir = tempfile::tempdir().expect("temp dir");
        let path = write(dir.path(), "a.exe", b"MZ");
        assert!(extract(&path).is_err());
    }

    #[test]
    fn a_file_that_cannot_be_read_is_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(extract(&dir.path().join("missing.txt")).is_err());
    }
}
