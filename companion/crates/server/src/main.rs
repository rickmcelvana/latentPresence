//! The `latentpresence-companion` binary. The HTTP surface itself lives in the library
//! (`lib.rs`), so `tests/memory_api.rs` can build the same router against a real MariaDB, and
//! its startup in `serve.rs`, so the desktop app (P8-T01) runs the same companion in-process.

use latentpresence_companion::{bench, bind_address, relay, serve};

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

    let listener = tokio::net::TcpListener::bind(bind_address()).await?;
    serve::serve(
        serve::ServeOptions {
            listener,
            token: None,
            relay: relay::Relay::measured(),
            database_url: None,
        },
        async {
            let _ = tokio::signal::ctrl_c().await;
        },
    )
    .await
}
