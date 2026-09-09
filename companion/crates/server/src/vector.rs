//! Embeddings on and off the wire.
//!
//! MariaDB's `VECTOR` type crosses the MySQL protocol as `MYSQL_TYPE_VAR_STRING` with the
//! binary flag — there is no new wire type, so a driver that has never heard of vectors
//! reads it as bytes and is correct. The payload is **little-endian `f32`, four bytes per
//! dimension, with no length prefix**. Verified by protocol probe on 2026-09-09 against
//! MariaDB 11.8.8; see `docs/SURFACE.md`.
//!
//! That means no custom `sqlx::Type`, no `::text` cast, and no JSON round trip: 768
//! dimensions is 3072 bytes here against seven or eight kilobytes as a text array, and the
//! server does not have to parse it.
//!
//! It also means the encoding is unchecked by anything else in the stack. A byte order or
//! a stride mistake here does not fail — it stores embeddings that are quietly wrong, and
//! retrieval returns confident nonsense. Hence a module of its own, and the tests.

use std::fmt;

/// Dimensions in the embeddings this project stores. Fixed by the schema: the column is
/// `VECTOR(768)` and MariaDB rejects anything else, but rejecting it here costs a round
/// trip less and gives a message that says which side was wrong.
pub const EMBEDDING_DIMENSIONS: usize = 768;

/// Bytes one embedding occupies. Matches the `key_len` of 3074 on the index, less the
/// two-byte length prefix MariaDB adds for the key.
pub const EMBEDDING_BYTES: usize = EMBEDDING_DIMENSIONS * 4;

#[derive(Debug, PartialEq, Eq)]
pub enum VectorError {
    /// The caller handed over the wrong number of floats.
    Dimensions { expected: usize, found: usize },
    /// The server handed back a byte count that is not a whole number of `f32`s, or is
    /// the wrong width for this column.
    ByteLength { expected: usize, found: usize },
}

impl fmt::Display for VectorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dimensions { expected, found } => {
                write!(f, "embedding has {found} dimensions, expected {expected}")
            }
            Self::ByteLength { expected, found } => {
                write!(f, "embedding is {found} bytes, expected {expected}")
            }
        }
    }
}

impl std::error::Error for VectorError {}

/// Pack an embedding for binding straight into a `VECTOR` column.
///
/// The dimension check happens here rather than at the database, because a mismatch that
/// reaches the server comes back as a driver error one round trip later — forty
/// milliseconds over the tunnel — saying nothing about which embedding was malformed.
pub fn encode(embedding: &[f32]) -> Result<Vec<u8>, VectorError> {
    if embedding.len() != EMBEDDING_DIMENSIONS {
        return Err(VectorError::Dimensions {
            expected: EMBEDDING_DIMENSIONS,
            found: embedding.len(),
        });
    }
    Ok(encode_unchecked(embedding))
}

/// The same packing without the width check, for fixtures and for benchmarks that build
/// vectors of a deliberately different size.
pub fn encode_unchecked(embedding: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(embedding.len() * 4);
    for value in embedding {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Unpack an embedding as it came off the wire.
pub fn decode(bytes: &[u8]) -> Result<Vec<f32>, VectorError> {
    if bytes.len() != EMBEDDING_BYTES {
        return Err(VectorError::ByteLength {
            expected: EMBEDDING_BYTES,
            found: bytes.len(),
        });
    }
    Ok(decode_unchecked(bytes))
}

/// Unpack without the width check. Panics on a length that is not a multiple of four,
/// which cannot come from the protocol and would be a bug on this side.
pub fn decode_unchecked(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("chunks_exact yields four bytes")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_little_endian_f32_exactly_as_the_server_sends_it() {
        // The bytes on the right are what MariaDB 11.8.8 actually returned for
        // `VEC_FromText('[1,2,3,4]')` (docs/SURFACE.md). Asserting against the recorded
        // wire bytes rather than against our own decoder is the point: a round-trip test
        // agrees with itself even when both halves are byte-swapped.
        let packed = encode_unchecked(&[1.0, 2.0, 3.0, 4.0]);

        assert_eq!(
            packed,
            vec![
                0x00, 0x00, 0x80, 0x3f, // 1.0
                0x00, 0x00, 0x00, 0x40, // 2.0
                0x00, 0x00, 0x40, 0x40, // 3.0
                0x00, 0x00, 0x80, 0x40, // 4.0
            ]
        );
    }

    #[test]
    fn reads_back_what_the_server_sent() {
        let from_server = [
            0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x40, 0x40, 0x00, 0x00,
            0x80, 0x40,
        ];

        assert_eq!(decode_unchecked(&from_server), vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn survives_the_values_a_real_embedding_contains() {
        // Normalised embeddings are small, signed and rarely round. Zero and the sign bit
        // are where a hand-rolled encoder goes wrong.
        let awkward = [-0.5_f32, 0.0, -0.0, 0.123_456_79, -1.0, f32::MIN_POSITIVE];
        let round_tripped = decode_unchecked(&encode_unchecked(&awkward));

        assert_eq!(round_tripped.len(), awkward.len());
        for (before, after) in awkward.iter().zip(round_tripped.iter()) {
            assert_eq!(
                before.to_bits(),
                after.to_bits(),
                "{before} did not survive"
            );
        }
    }

    #[test]
    fn a_full_embedding_is_the_width_the_index_expects() {
        let embedding = vec![0.25_f32; EMBEDDING_DIMENSIONS];
        let packed = encode(&embedding).expect("768 floats encode");

        assert_eq!(packed.len(), EMBEDDING_BYTES);
        assert_eq!(packed.len(), 3072);
        assert_eq!(decode(&packed).expect("768 floats decode"), embedding);
    }

    #[test]
    fn refuses_the_wrong_number_of_dimensions_before_the_round_trip() {
        // A 767-long embedding is a model mismatch, and finding out from a driver error
        // forty milliseconds later tells you nothing about which vector was wrong.
        let short = vec![0.1_f32; EMBEDDING_DIMENSIONS - 1];
        let long = vec![0.1_f32; EMBEDDING_DIMENSIONS + 1];

        assert_eq!(
            encode(&short),
            Err(VectorError::Dimensions {
                expected: 768,
                found: 767
            })
        );
        assert_eq!(
            encode(&long),
            Err(VectorError::Dimensions {
                expected: 768,
                found: 769
            })
        );
    }

    #[test]
    fn refuses_a_byte_run_that_is_not_this_column() {
        assert_eq!(
            decode(&[0, 0, 0, 0]),
            Err(VectorError::ByteLength {
                expected: 3072,
                found: 4
            })
        );
        assert_eq!(
            decode(&[]),
            Err(VectorError::ByteLength {
                expected: 3072,
                found: 0
            })
        );
    }

    #[test]
    fn says_which_side_was_wrong() {
        // The message ends up in a log or an error body, and "expected 768" without the
        // number that arrived is a message that costs someone an afternoon.
        let message = encode(&[0.0; 3]).unwrap_err().to_string();

        assert!(message.contains('3'), "{message}");
        assert!(message.contains("768"), "{message}");
    }
}
