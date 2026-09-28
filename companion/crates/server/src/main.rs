//! The `latentpresence-companion` binary. The HTTP surface itself lives in the library
//! (`lib.rs`), so `tests/memory_api.rs` can build the same router against a real MariaDB.

use latentpresence_companion::{bench, bind_address, memory_api, relay, router_with};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `bench` is P0-T06's measurement run, not part of serving. It is a subcommand rather
    // than a second binary so it shares the pool, the migrations and the encoding the
    // product actually uses - a benchmark against a copy of the code measures the copy.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("bench") {
        let rows = args
            .get(2)
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(100_000);
        return bench::run(rows).await;
    }
    // P4-T01: proves the memory schema on the server DATABASE_URL names - migrations, a
    // model's vector table, the retrieval shape on its index, the cascades - and leaves
    // nothing behind. CI runs it against a fresh MariaDB.
    if args.get(1).map(String::as_str) == Some("memory-check") {
        let pool = latentpresence_db::connect(&bench::database_url()?).await?;
        for line in latentpresence_db::memory::self_check(&pool).await? {
            println!("{line}");
        }
        return Ok(());
    }

    // The pool comes from `DATABASE_URL` in the environment or the repo's `.env`, shared
    // with `bench` and `memory-check` rather than read again here. `has_database_url`
    // distinguishes "not configured" from "configured but did not come up" for `/health`
    // (`HealthResponseSchema.database.kind`); connecting also runs the migrations.
    let database_url = bench::database_url();
    let has_database_url = database_url.is_ok();
    let pool = match database_url {
        Ok(url) => match latentpresence_db::connect(&url).await {
            Ok(pool) => Some(pool),
            Err(error) => {
                eprintln!("companion: database connection failed: {error}");
                None
            }
        },
        Err(_) => None,
    };
    let memory = memory_api::MemoryState::new(pool);

    let address = bind_address();
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("latentpresence-companion listening on http://{address}");
    axum::serve(
        listener,
        router_with(relay::Relay::measured(), memory, has_database_url),
    )
    .await?;
    Ok(())
}
