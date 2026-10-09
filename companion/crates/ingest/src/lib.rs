//! Document extractors and the chunker (P5-T03, ADR-44). **Pure: no database, no network.**
//!
//! `extract` turns a file into pages of text (a PDF's pages; one page for everything else), and
//! `chunk` cuts those pages into pieces of about a thousand characters that **never cross a
//! page**, so every chunk has one locator (`p. 12`) the answer can cite. What the companion
//! does with them - the database, the embeddings, the folders - lives in its server crate.

mod chunk;
mod extract;

pub use chunk::{CHUNK_OVERLAP, CHUNK_TARGET, Chunk, chunk};
pub use extract::{EXTENSIONS, Extracted, extract, extract_bytes, is_supported};

use sha2::{Digest, Sha256};

/// One page of a document: a PDF's page with its locator, or the whole text of any other
/// format with none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub locator: Option<String>,
    pub text: String,
}

/// The SHA-256 of a file's bytes: what makes a re-run over unchanged files a no-op.
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_published_vector() {
        let digest = sha256(b"abc");
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
