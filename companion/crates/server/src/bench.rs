//! The P0-T06 benchmark: `latentpresence-companion bench [rows]`.
//!
//! Produces the numbers in `docs/spikes/C-mariadb-vector.md`. It is not part of the
//! serving path and nothing in the product calls it; it exists so the retrieval budget in
//! ADR-17 is measured rather than assumed, and so the same code can be pointed at either
//! host by `DATABASE_URL` alone.
//!
//! Three numbers, never one: the round trip on its own, the query, and what a turn would
//! actually wait for. A single end-to-end figure cannot say how much of a retrieval is the
//! wire, and over the tunnel the wire is most of it.

use std::time::{Duration, Instant};

use crate::db::{self, NewChunk};

/// Rows per `INSERT`. Large enough that the round trip is amortised, small enough that the
/// packet stays under MariaDB's default `max_allowed_packet` — 500 rows of 3 KB vectors is
/// about 1.5 MB, and the default is 16 MB.
const INSERT_BATCH: usize = 500;

/// Queries per measurement. A median over ten is an anecdote; the p95 is the point, and a
/// p95 needs enough samples to have a twentieth.
const QUERY_SAMPLES: usize = 200;

/// Discarded before measuring: the first queries warm the pool, the index cache and the
/// server's own buffers.
const QUERY_WARM_UP: usize = 20;

fn percentile(sorted: &[Duration], fraction: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let rank = (fraction * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// Median, p95 and worst, in milliseconds, from a set of timings.
fn summarise(mut times: Vec<Duration>) -> (f64, f64, f64) {
    times.sort_unstable();
    (
        ms(percentile(&times, 0.5)),
        ms(percentile(&times, 0.95)),
        ms(*times.last().unwrap_or(&Duration::ZERO)),
    )
}

/// `DATABASE_URL` from the environment, or from a `.env` beside the repository root.
///
/// The value is returned and never printed. Errors from here name the file, never the
/// contents: a benchmark that echoes a password into a terminal has leaked it into scroll
/// buffers, screenshots and whatever recorded the session.
fn database_url() -> Result<String, String> {
    if let Ok(url) = std::env::var("DATABASE_URL")
        && !url.is_empty()
    {
        return Ok(url);
    }

    let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
    loop {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            let text = std::fs::read_to_string(&candidate).map_err(|e| e.to_string())?;
            for line in text.lines() {
                if let Some(value) = line.trim().strip_prefix("DATABASE_URL=") {
                    return Ok(value.trim().to_string());
                }
            }
            return Err(format!("{} has no DATABASE_URL", candidate.display()));
        }
        if !dir.pop() {
            return Err("no DATABASE_URL in the environment and no .env found".into());
        }
    }
}

/// Fill the table to `rows`, reporting insert throughput.
async fn fill(pool: &sqlx::MySqlPool, rows: usize) -> Result<f64, db::DbError> {
    let started = Instant::now();
    let mut written = 0usize;

    while written < rows {
        let take = INSERT_BATCH.min(rows - written);
        let batch: Vec<NewChunk> = (0..take)
            .map(|i| {
                let seed = (written + i) as u64;
                NewChunk {
                    doc_id: seed / 100,
                    text: format!("chunk {seed} for the P0-T06 benchmark"),
                    embedding: db::synthetic_embedding(seed),
                }
            })
            .collect();
        db::insert_chunks(pool, &batch).await?;
        written += take;

        if written.is_multiple_of(10_000) {
            println!("  inserted {written} / {rows}");
        }
    }

    let elapsed = started.elapsed().as_secs_f64();
    Ok(rows as f64 / elapsed)
}

/// One row count's worth of measurements, printed as the write-up wants them.
async fn measure(pool: &sqlx::MySqlPool, label: &str) -> Result<(), db::DbError> {
    let rows = db::count(pool).await?;

    // The network on its own, taken in the same run as everything else so the three
    // numbers are comparable rather than quoted from different days.
    let (rtt_median, rtt_p95, rtt_worst) = summarise(db::round_trip(pool, 30).await?);

    let mut query_times = Vec::with_capacity(QUERY_SAMPLES);
    for i in 0..(QUERY_SAMPLES + QUERY_WARM_UP) {
        // A different probe vector each time: querying the same one repeatedly measures a
        // cache, not a search.
        let probe = db::synthetic_embedding(1_000_000 + i as u64);
        let started = Instant::now();
        let hits = db::nearest(pool, &probe, 8).await?;
        let elapsed = started.elapsed();
        if i >= QUERY_WARM_UP {
            query_times.push(elapsed);
        }
        if i == QUERY_WARM_UP {
            // Proof the search returns something ordered, once, rather than a silent
            // empty result that would time beautifully.
            println!(
                "  sample hit: id={} doc_id={} distance={:.6} text={:?}",
                hits.first().map(|h| h.id).unwrap_or(0),
                hits.first().map(|h| h.doc_id).unwrap_or(0),
                hits.first().map(|h| h.distance).unwrap_or(f64::NAN),
                hits.first().map(|h| h.text.as_str()).unwrap_or("<none>"),
            );
            assert!(!hits.is_empty(), "top-k returned nothing at {rows} rows");
        }
    }
    let (q_median, q_p95, q_worst) = summarise(query_times);

    // Reported, not inferred. A fast query on a scanned table looks exactly like a fast
    // query on an indexed one until the table gets big.
    let plan = db::explain_nearest(pool, &db::synthetic_embedding(7), 8).await?;

    println!("\n### {label} — {rows} rows");
    println!("- round trip: median {rtt_median:.2} ms, p95 {rtt_p95:.2}, worst {rtt_worst:.2}");
    println!("- top-8 query: median {q_median:.2} ms, p95 {q_p95:.2}, worst {q_worst:.2}");
    println!(
        "- query less round trip: {:.2} ms median",
        q_median - rtt_median
    );
    println!("- EXPLAIN: {plan}");
    println!(
        "- against the 100 ms per-turn budget: {}",
        if q_p95 <= 100.0 {
            "holds at p95"
        } else {
            "MISSED at p95"
        }
    );
    Ok(())
}

/// Write one embedding, read it back, and check every float survived.
///
/// The encoding is asserted against recorded wire bytes in `vector.rs`, but that test
/// never touches a server. This is the only place that proves MariaDB stores and returns
/// the same 3072 bytes — and a storage-side surprise would corrupt every embedding while
/// leaving all the timings looking excellent.
async fn verify_storage_round_trip(
    pool: &sqlx::MySqlPool,
) -> Result<(), Box<dyn std::error::Error>> {
    sqlx::query("TRUNCATE TABLE chunks").execute(pool).await?;

    let written = db::synthetic_embedding(4_242);
    db::insert_chunks(
        pool,
        &[NewChunk {
            doc_id: 0,
            text: "storage round-trip check".into(),
            embedding: written.clone(),
        }],
    )
    .await?;

    let id = db::any_id(pool)
        .await?
        .ok_or("the row just inserted is not there")?;
    let read_back = db::fetch_embedding(pool, id).await?;

    if read_back.len() != written.len() {
        return Err(format!(
            "read back {} dimensions, wrote {}",
            read_back.len(),
            written.len()
        )
        .into());
    }
    // Bit-exact, not approximate. f32 goes in and f32 comes out; anything that rounds it
    // is a conversion nobody asked for.
    for (index, (before, after)) in written.iter().zip(read_back.iter()).enumerate() {
        if before.to_bits() != after.to_bits() {
            return Err(format!("dimension {index}: wrote {before}, read {after}").into());
        }
    }
    println!(
        "storage round trip: {} dimensions, bit-exact",
        written.len()
    );
    Ok(())
}

pub async fn run(target_rows: usize) -> Result<(), Box<dyn std::error::Error>> {
    let url = database_url()?;
    println!("connecting and migrating…");
    let pool = db::connect(&url).await?;

    let version: String = sqlx::query_scalar("SELECT VERSION()")
        .fetch_one(&pool)
        .await?;
    let ef_search: String = sqlx::query_scalar("SELECT @@mhnsw_ef_search")
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|_| "unknown".into());
    println!("server {version}, mhnsw_ef_search {ef_search}");

    verify_storage_round_trip(&pool).await?;

    // Start from empty so a re-run measures the same thing twice. The benchmark owns this
    // table while it runs and empties it afterwards; it is the product's real schema
    // rather than a copy, so P4 inherits something that has been exercised.
    sqlx::query("TRUNCATE TABLE chunks").execute(&pool).await?;

    for milestone in [10_000usize, 100_000] {
        if milestone > target_rows {
            break;
        }
        let existing = db::count(&pool).await? as usize;
        let throughput = fill(&pool, milestone - existing).await?;
        println!("\n  fill to {milestone}: {throughput:.0} rows/s");
        measure(&pool, &url_host(&url)).await?;
    }

    println!("\ncleaning up…");
    sqlx::query("TRUNCATE TABLE chunks").execute(&pool).await?;
    pool.close().await;
    Ok(())
}

/// Just the host, for labelling output. Never the whole URL.
fn url_host(url: &str) -> String {
    url.rsplit('@')
        .next()
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("database")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_come_from_the_sample_rather_than_between_it() {
        let times: Vec<Duration> = [10u64, 20, 30, 40]
            .iter()
            .map(|n| Duration::from_millis(*n))
            .collect();

        assert_eq!(percentile(&times, 0.5), Duration::from_millis(20));
        assert_eq!(percentile(&times, 0.95), Duration::from_millis(40));
        assert_eq!(percentile(&[], 0.5), Duration::ZERO);
    }

    #[test]
    fn summarise_orders_before_it_picks() {
        let unsorted = vec![
            Duration::from_millis(40),
            Duration::from_millis(10),
            Duration::from_millis(20),
        ];
        let (median, p95, worst) = summarise(unsorted);

        assert!((median - 20.0).abs() < 1e-9, "{median}");
        assert!((p95 - 40.0).abs() < 1e-9, "{p95}");
        assert!((worst - 40.0).abs() < 1e-9, "{worst}");
    }

    #[test]
    fn the_label_never_carries_the_credentials() {
        // This string is printed. If it ever contains the password, the benchmark has
        // leaked it into a terminal, a scroll buffer and whatever recorded the session.
        let host = url_host("mysql://someone:hunter2@192.168.40.101:3306/latentpresence");

        assert_eq!(host, "192.168.40.101:3306");
        assert!(!host.contains("hunter2"));
    }
}
