//! The companion's MariaDB store (ADR-05, ADR-17, ADR-35): the schema, its migrations,
//! and the model registry that gives each collection its own vector table (`memory`).
//! `bench` is P0-T06's measurement table, kept as the instrument it was.
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

pub mod bench;
pub mod documents;
pub mod memory;
pub mod store;
pub mod time;
pub mod vector;

pub use bench::{
    Hit, NewChunk, any_id, count, explain_nearest, fetch_embedding, insert_chunks, nearest,
    synthetic_embedding,
};

use vector::VectorError;

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
    /// A request the schema cannot hold (an unknown model, a width MariaDB refuses).
    Invalid(String),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Backend(message) => write!(f, "database error: {message}"),
            Self::Vector(error) => write!(f, "{error}"),
            Self::Invalid(message) => write!(f, "{message}"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_never_carry_the_connection_string() {
        // The one thing this crate must not leak. `DbError` is built from sqlx's message
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
