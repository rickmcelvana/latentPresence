//! The MariaDB side of the companion (ADR-05, ADR-17).
//!
//! Everything here is optional. A user without a database gets a companion that still
//! answers `/health` and says so, because the web app decides whether to offer memory
//! from that answer.
//!
//! The connection string is read from `DATABASE_URL` and **never printed**. sqlx's own
//! errors are careful about this, but a `{:?}` on a `MySqlConnectOptions` is not, so
//! errors out of this module are reduced to a message of our own before they go anywhere
//! a log or an HTTP body might see them.

use std::time::{Duration, Instant};

use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::{Executor, Row};

use crate::vector::{self, EMBEDDING_DIMENSIONS, VectorError};

/// Migrations are compiled in, so a release binary carries its own schema and there is no
/// "did you run the migrations" step for anyone to forget.
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug)]
pub enum DbError {
    /// Connecting, migrating or querying failed. The message is sqlx's, which does not
    /// contain credentials; the URL is never interpolated into it here.
    Backend(String),
    /// An embedding was the wrong shape. Caught before the round trip.
    Vector(VectorError),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Backend(message) => write!(f, "database error: {message}"),
            Self::Vector(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<sqlx::Error> for DbError {
    fn from(error: sqlx::Error) -> Self {
        Self::Backend(error.to_string())
    }
}

impl From<VectorError> for DbError {
    fn from(error: VectorError) -> Self {
        Self::Vector(error)
    }
}

/// One row on the way in. `text` is kept beside the vector so retrieval is one statement:
/// ADR-17 allows one round trip per turn, and a query that returns ids and then fetches
/// their text has already spent two.
#[derive(Debug, Clone)]
pub struct NewChunk {
    pub doc_id: u64,
    pub text: String,
    pub embedding: Vec<f32>,
}

/// One row on the way out, with the distance that ranked it.
#[derive(Debug, Clone)]
pub struct Hit {
    pub id: u64,
    pub doc_id: u64,
    pub text: String,
    /// Cosine distance: smaller is nearer, 0 is identical.
    pub distance: f64,
}

/// Open the pool and bring the schema up to date.
///
/// The pool is small on purpose. The companion serves one person, and a large pool against
/// a remote server buys nothing but connections to time out.
pub async fn connect(url: &str) -> Result<MySqlPool, DbError> {
    let pool = MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(10))
        .connect(url)
        .await?;
    MIGRATOR
        .run(&pool)
        .await
        .map_err(|error| DbError::Backend(error.to_string()))?;
    Ok(pool)
}

/// Round-trip time, measured on its own so it can be subtracted from everything else.
///
/// `SELECT 1` is protocol and network and nothing else. It is measured separately because
/// the interesting question in ADR-17 is how much of a retrieval is the wire — 0.43 ms on
/// the LAN against 39.8 over the tunnel — and a single end-to-end figure cannot say.
pub async fn round_trip(pool: &MySqlPool, samples: usize) -> Result<Vec<Duration>, DbError> {
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let started = Instant::now();
        pool.execute("SELECT 1").await?;
        times.push(started.elapsed());
    }
    Ok(times)
}

/// Insert a batch in one statement.
///
/// One statement rather than one per row: over a 40 ms link, a thousand inserts is forty
/// seconds of waiting and about a second of work. The vectors go in as binary — 3072 bytes
/// against seven or eight kilobytes of JSON text, and the server does not have to parse
/// them (`docs/SURFACE.md`).
pub async fn insert_chunks(pool: &MySqlPool, chunks: &[NewChunk]) -> Result<u64, DbError> {
    if chunks.is_empty() {
        return Ok(0);
    }

    // Encode everything before touching the network, so a malformed embedding is an error
    // about that embedding rather than a driver error forty milliseconds later.
    let mut encoded = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        encoded.push(vector::encode(&chunk.embedding)?);
    }

    // `QueryBuilder` rather than a formatted placeholder string: sqlx 0.9 refuses dynamic
    // SQL unless it is wrapped in `AssertSqlSafe`, and an assertion that a string is safe
    // is exactly the thing that stops being true when someone edits it later. Nothing here
    // interpolates a value - `push_values` emits placeholders and binds.
    let mut builder =
        sqlx::QueryBuilder::<sqlx::MySql>::new("INSERT INTO chunks (doc_id, text, embedding) ");
    builder.push_values(
        chunks.iter().zip(encoded.iter()),
        |mut row, (chunk, bytes)| {
            row.push_bind(chunk.doc_id)
                .push_bind(&chunk.text)
                .push_bind(&bytes[..]);
        },
    );

    Ok(builder.build().execute(pool).await?.rows_affected())
}

/// Nearest `k` by cosine distance.
///
/// `VEC_DISTANCE_COSINE` matches the index's `DISTANCE=cosine`. They must agree: a
/// mismatch is not an error, it is a full table scan that returns the right answer slowly,
/// which is the kind of result that gets believed. `EXPLAIN` on this statement is part of
/// the spike's evidence for that reason.
pub async fn nearest(pool: &MySqlPool, embedding: &[f32], k: u32) -> Result<Vec<Hit>, DbError> {
    let bytes = vector::encode(embedding)?;

    let rows = sqlx::query(
        "SELECT id, doc_id, text, VEC_DISTANCE_COSINE(embedding, ?) AS distance
         FROM chunks
         ORDER BY distance
         LIMIT ?",
    )
    .bind(&bytes[..])
    .bind(k)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            Ok(Hit {
                id: row.try_get("id")?,
                doc_id: row.try_get("doc_id")?,
                text: row.try_get("text")?,
                distance: row.try_get("distance")?,
            })
        })
        .collect()
}

/// What the planner intends to do with the retrieval query, as text.
///
/// Reported rather than inferred. A retrieval that is quick because the table is small
/// looks exactly like a retrieval that is quick because the index worked, and only one of
/// those still holds at a hundred thousand rows.
pub async fn explain_nearest(
    pool: &MySqlPool,
    embedding: &[f32],
    k: u32,
) -> Result<String, DbError> {
    let bytes = vector::encode(embedding)?;

    let rows = sqlx::query(
        "EXPLAIN SELECT id, doc_id, text, VEC_DISTANCE_COSINE(embedding, ?) AS distance
         FROM chunks
         ORDER BY distance
         LIMIT ?",
    )
    .bind(&bytes[..])
    .bind(k)
    .fetch_all(pool)
    .await?;

    let mut lines = Vec::with_capacity(rows.len());
    for row in &rows {
        let key: Option<String> = row.try_get("key").ok().flatten();
        let kind: Option<String> = row.try_get("type").ok().flatten();
        let scanned: Option<i64> = row.try_get("rows").ok().flatten();
        lines.push(format!(
            "type={} key={} rows={}",
            kind.unwrap_or_else(|| "?".into()),
            key.unwrap_or_else(|| "NULL".into()),
            scanned.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
        ));
    }
    Ok(lines.join(" | "))
}

/// Read one embedding back out, decoded.
///
/// Exists so the benchmark can prove that what went in came back. The binary encoding is
/// asserted against recorded wire bytes in `vector.rs`, but that test never touches a
/// server: this is the one check that MariaDB stores and returns the same 3072 bytes, and
/// a storage-side surprise here would corrupt every embedding while every timing stayed
/// beautiful.
pub async fn fetch_embedding(pool: &MySqlPool, id: u64) -> Result<Vec<f32>, DbError> {
    let row = sqlx::query("SELECT embedding FROM chunks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let bytes: Vec<u8> = row.try_get("embedding")?;
    Ok(vector::decode(&bytes)?)
}

/// The id of any row, so a caller has something to read back without assuming ids start
/// at one — `TRUNCATE` resets `AUTO_INCREMENT`, but a shared database might not have.
pub async fn any_id(pool: &MySqlPool) -> Result<Option<u64>, DbError> {
    let row = sqlx::query("SELECT id FROM chunks LIMIT 1")
        .fetch_optional(pool)
        .await?;
    match row {
        Some(row) => Ok(Some(row.try_get("id")?)),
        None => Ok(None),
    }
}

/// The MHNSW tuning the server is actually running, as `name=value` pairs.
///
/// Reported beside every latency. `mhnsw_ef_search` trades recall for speed at query time,
/// so a fast number at a low `ef_search` is a fast number for a worse answer, and a
/// latency quoted without it cannot be compared with anyone else's.
pub async fn mhnsw_settings(pool: &MySqlPool) -> Result<String, DbError> {
    let rows = sqlx::query("SHOW VARIABLES LIKE 'mhnsw%'")
        .fetch_all(pool)
        .await?;
    let mut pairs = Vec::with_capacity(rows.len());
    for row in &rows {
        let name: String = row.try_get("Variable_name")?;
        let value: String = row.try_get("Value")?;
        pairs.push(format!("{name}={value}"));
    }
    Ok(pairs.join(", "))
}

/// How many rows are in the table, for the benchmark's own bookkeeping.
pub async fn count(pool: &MySqlPool) -> Result<i64, DbError> {
    let row = sqlx::query("SELECT COUNT(*) AS n FROM chunks")
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("n")?)
}

/// One step of SplitMix64. Deterministic, cheap, and well spread across the whole range.
fn split_mix(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// A deterministic pseudo-embedding, for filling a table without a model.
///
/// Deterministic rather than random: a benchmark that cannot be re-run against the same
/// data is a benchmark whose second reading means nothing.
///
/// Hashed rather than smooth. The first version of this was `sin(seed * k + i * k2)`,
/// which looks like noise and is not: sine is periodic, so seeds a fixed distance apart
/// produce nearly the same vector. The benchmark noticed — a probe built from seed
/// 1_000_020 came back at **distance 0.000000** from the row for seed 6701. Colliding
/// probes are the easiest possible query for a nearest-neighbour index and would have
/// flattered every latency in the write-up.
///
/// Normalised, because cosine distance on unnormalised vectors measures something nobody
/// asked about.
pub fn synthetic_embedding(seed: u64) -> Vec<f32> {
    let mut values: Vec<f32> = (0..EMBEDDING_DIMENSIONS)
        .map(|i| {
            let bits = split_mix(
                seed.wrapping_mul(0x0000_0100_0000_01B3)
                    .wrapping_add(i as u64),
            );
            // Top 24 bits into [-1, 1): enough entropy for a float, and no denormals.
            ((bits >> 40) as f32 / (1u32 << 23) as f32) - 1.0
        })
        .collect();
    let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in &mut values {
            *value /= norm;
        }
    }
    values
}

/// Cosine similarity, for the fixture's own tests. Not used against the database — that is
/// MariaDB's job — but needed to prove the fixture generates vectors that are actually
/// distinct from one another.
#[cfg(test)]
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_embeddings_are_the_right_width_and_normalised() {
        let embedding = synthetic_embedding(42);

        assert_eq!(embedding.len(), EMBEDDING_DIMENSIONS);
        let norm = embedding.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "norm was {norm}");
    }

    #[test]
    fn synthetic_embeddings_are_reproducible() {
        // Or a second run of the benchmark measures different data than the first.
        assert_eq!(synthetic_embedding(7), synthetic_embedding(7));
        assert_ne!(synthetic_embedding(7), synthetic_embedding(8));
    }

    #[test]
    fn no_two_seeds_produce_nearly_the_same_vector() {
        // The bug this replaced: a smooth `sin(seed * k + i * k2)` fixture is periodic, so
        // distant seeds collide. The benchmark found a probe at distance 0.000000 from a
        // stored row, which is the easiest possible query for a nearest-neighbour index
        // and would have flattered every latency in the write-up.
        //
        // Includes the exact pair that collided, and the far-apart seeds the probes use.
        let pairs = [(6701u64, 1_000_020u64), (0, 1), (1, 11), (42, 1_000_000)];

        for (a, b) in pairs {
            let similarity = cosine_similarity(&synthetic_embedding(a), &synthetic_embedding(b));
            assert!(
                similarity.abs() < 0.2,
                "seeds {a} and {b} are too close: cosine similarity {similarity}"
            );
        }
    }

    #[test]
    fn a_vector_is_still_identical_to_itself() {
        // The other half of the property: distinct seeds must differ, and the same seed
        // must not. A fixture that failed this would make every distance meaningless.
        let similarity = cosine_similarity(&synthetic_embedding(99), &synthetic_embedding(99));

        assert!((similarity - 1.0).abs() < 1e-5, "{similarity}");
    }

    #[test]
    fn errors_never_carry_the_connection_string() {
        // The one thing this module must not leak. `DbError` is built from sqlx's message
        // and from our own; neither has ever seen the URL.
        let error = DbError::from(VectorError::Dimensions {
            expected: 768,
            found: 3,
        });

        let rendered = error.to_string();
        assert!(!rendered.contains("mysql://"), "{rendered}");
        assert!(rendered.contains("768"), "{rendered}");
    }
}
