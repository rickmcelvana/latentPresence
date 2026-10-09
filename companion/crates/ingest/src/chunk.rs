//! The chunker: about a thousand characters with a hundred and fifty of overlap, cut at a
//! paragraph, else a sentence, else a space - and **never across a page** (ADR-44), so a
//! citation can say "p. 12" and be right.
//!
//! Lengths count `char`s, not bytes: an embedding model's context is in tokens, and a byte
//! count would cut Cyrillic or CJK text at a third of the intended size.

use crate::Page;

/// The most characters in a chunk. Small on purpose: Ollama's `nomic-embed-text` silently
/// truncates what it is given to its context (docs/SURFACE.md).
pub const CHUNK_TARGET: usize = 1_000;
/// How much of the end of one chunk the next begins with, at most.
pub const CHUNK_OVERLAP: usize = 150;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// Counts across the document from 0.
    pub seq: u32,
    pub locator: Option<String>,
    pub text: String,
}

/// Cut every page into chunks. Empty pages make none.
pub fn chunk(pages: &[Page]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut seq = 0u32;
    for page in pages {
        for text in chunk_text(&page.text, CHUNK_TARGET, CHUNK_OVERLAP) {
            chunks.push(Chunk {
                seq,
                locator: page.locator.clone(),
                text,
            });
            seq += 1;
        }
    }
    chunks
}

/// Whitespace inside a paragraph becomes single spaces; paragraphs (a blank line between)
/// are kept as `\n\n`; empty ones are dropped.
fn normalise(text: &str) -> Vec<char> {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, paragraphs: &mut Vec<String>| {
        let collapsed = current.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            paragraphs.push(collapsed);
        }
        current.clear();
    };
    for line in text.lines() {
        if line.trim().is_empty() {
            flush(&mut current, &mut paragraphs);
        } else {
            current.push_str(line);
            current.push(' ');
        }
    }
    flush(&mut current, &mut paragraphs);
    paragraphs.join("\n\n").chars().collect()
}

fn chunk_text(text: &str, target: usize, overlap: usize) -> Vec<String> {
    let chars = normalise(text);
    let len = chars.len();
    let mut out = Vec::new();
    let mut start = 0;
    while start < len {
        let end = (start + target).min(len);
        if end == len {
            push(&mut out, &chars[start..len]);
            break;
        }
        // A cut must leave more than the overlap behind it, or the next chunk would not
        // start later than this one and the loop would not end.
        let cut = cut_point(&chars, start + overlap + 1, end).unwrap_or(end);
        push(&mut out, &chars[start..cut]);
        // The next chunk begins `overlap` characters back, moved forward to a word start
        // when there is one, so it does not open in the middle of a word.
        let back = cut - overlap;
        start = (back..cut)
            .find(|&index| index > 0 && chars[index - 1].is_whitespace())
            .unwrap_or(back);
        while start < cut && chars[start].is_whitespace() {
            start += 1;
        }
    }
    out
}

fn push(out: &mut Vec<String>, slice: &[char]) {
    let text: String = slice.iter().collect();
    let text = text.trim();
    if !text.is_empty() {
        out.push(text.to_owned());
    }
}

/// The best place to cut `chars[..end]`, no earlier than `min`: the last paragraph break, else
/// the last sentence end (`. `, `? `, `! ` before a capital letter), else the last space.
fn cut_point(chars: &[char], min: usize, end: usize) -> Option<usize> {
    let paragraph = (min..end.saturating_sub(1))
        .rev()
        .find(|&index| chars[index] == '\n' && chars[index + 1] == '\n');
    if paragraph.is_some() {
        return paragraph;
    }
    let sentence = (min..end.saturating_sub(2)).rev().find(|&index| {
        matches!(chars[index], '.' | '?' | '!')
            && chars[index + 1] == ' '
            && chars[index + 2].is_uppercase()
    });
    if let Some(index) = sentence {
        return Some(index + 1);
    }
    (min..end).rev().find(|&index| chars[index].is_whitespace())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(locator: Option<&str>, text: &str) -> Page {
        Page {
            locator: locator.map(str::to_owned),
            text: text.to_owned(),
        }
    }

    /// Sentences of about sixty characters, each different, so overlap is detectable.
    fn prose(sentences: usize) -> String {
        (0..sentences)
            .map(|n| format!("Sentence number {n} talks about basil, thyme and the watering."))
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn no_chunk_is_over_a_thousand_characters_and_consecutive_ones_overlap() {
        let chunks = chunk(&[page(None, &prose(200))]);
        assert!(chunks.len() > 5, "{}", chunks.len());
        for (index, one) in chunks.iter().enumerate() {
            assert!(one.text.chars().count() <= CHUNK_TARGET, "{index}");
            assert_eq!(one.seq as usize, index);
        }
        for pair in chunks.windows(2) {
            // The tail of one is the head of the next: its last sentence opens the second.
            let last_sentence = pair[0].text.rsplit(". ").next().expect("a last sentence");
            let words: Vec<&str> = last_sentence.split(' ').collect();
            assert!(
                pair[1]
                    .text
                    .contains(&words[words.len().saturating_sub(4)..].join(" ")),
                "no overlap between {:?} and {:?}",
                pair[0].text,
                pair[1].text
            );
        }
    }

    #[test]
    fn nothing_is_lost() {
        let text = prose(200);
        let chunks = chunk(&[page(None, &text)]);
        for word in text.split_whitespace() {
            assert!(
                chunks.iter().any(|one| one.text.contains(word)),
                "{word} is in no chunk"
            );
        }
        // And in order: the last sentence is in the last chunk.
        assert!(
            chunks
                .last()
                .expect("a chunk")
                .text
                .ends_with("Sentence number 199 talks about basil, thyme and the watering.")
        );
    }

    #[test]
    fn a_chunk_never_crosses_a_page_and_carries_its_pages_locator() {
        let pages = [
            page(Some("p. 1"), "Basil needs water."),
            page(Some("p. 2"), ""),
            page(Some("p. 3"), &prose(60)),
            page(Some("p. 4"), "Thyme likes it dry."),
        ];
        let chunks = chunk(&pages);
        // Empty pages make no chunks; `seq` runs on across pages.
        assert!(
            chunks
                .iter()
                .all(|one| one.locator.as_deref() != Some("p. 2"))
        );
        assert_eq!(chunks[0].locator.as_deref(), Some("p. 1"));
        assert_eq!(chunks[0].text, "Basil needs water.");
        let last = chunks.last().expect("a chunk");
        assert_eq!(last.locator.as_deref(), Some("p. 4"));
        assert_eq!(last.text, "Thyme likes it dry.");
        assert!(
            chunks
                .iter()
                .filter(|one| one.locator.as_deref() == Some("p. 3"))
                .count()
                > 1
        );
        for (index, one) in chunks.iter().enumerate() {
            assert_eq!(one.seq as usize, index);
        }
        // Text from page 4 is never in a page 3 chunk, nor the reverse.
        assert!(
            chunks
                .iter()
                .filter(|one| one.locator.as_deref() == Some("p. 3"))
                .all(|one| !one.text.contains("Thyme likes"))
        );
    }

    #[test]
    fn paragraphs_are_kept_and_other_whitespace_collapses() {
        let chunks = chunk(&[page(None, "one   two\nthree\n\n\n  four\t five\r\n\r\nsix")]);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "one two three\n\nfour five\n\nsix");
    }

    #[test]
    fn it_cuts_at_a_paragraph_break_when_there_is_one() {
        let first = "a".repeat(10) + &" word".repeat(150); // about 760 characters
        let text = format!("{first}\n\n{}", "Second paragraph. ".repeat(40));
        let chunks = chunk(&[page(None, &text)]);
        assert!(chunks[0].text.ends_with("word"), "{:?}", chunks[0].text);
        assert!(!chunks[0].text.contains("Second paragraph"));
    }

    #[test]
    fn it_cuts_at_a_sentence_end_when_there_is_no_paragraph() {
        let chunks = chunk(&[page(None, &prose(60))]);
        for one in &chunks[..chunks.len() - 1] {
            assert!(one.text.ends_with('.'), "{:?}", one.text);
        }
    }

    #[test]
    fn five_thousand_characters_with_no_punctuation_still_chunk() {
        let text = "abcdefghi ".repeat(500);
        let chunks = chunk(&[page(None, &text)]);
        assert!(chunks.len() >= 5);
        assert!(
            chunks
                .iter()
                .all(|one| one.text.chars().count() <= CHUNK_TARGET)
        );
        // And five thousand with no spaces at all is cut hard, not looped on.
        let solid = "x".repeat(5_000);
        let chunks = chunk(&[page(None, &solid)]);
        assert!(chunks.len() >= 5);
        assert!(
            chunks
                .iter()
                .all(|one| one.text.chars().count() <= CHUNK_TARGET)
        );
        let total: usize = chunks.iter().map(|one| one.text.chars().count()).sum();
        assert!(total >= 5_000);
    }

    #[test]
    fn lengths_are_characters_not_bytes() {
        // Two bytes a character: a byte count would cut at 500.
        let text = "ж".repeat(900);
        let chunks = chunk(&[page(None, &text)]);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text.chars().count(), 900);
    }

    #[test]
    fn a_blank_document_makes_no_chunks() {
        assert!(chunk(&[page(None, " \n\n \t ")]).is_empty());
        assert!(chunk(&[]).is_empty());
    }
}
