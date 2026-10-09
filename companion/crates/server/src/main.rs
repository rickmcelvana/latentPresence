//! The `latentpresence-companion` binary. The HTTP surface itself lives in the library
//! (`lib.rs`), so `tests/memory_api.rs` can build the same router against a real MariaDB.

use latentpresence_companion::{
    bench, bind_address, ingest, mcp, memory_api, relay, router_with_ingest,
};

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
    let memory = memory_api::MemoryState::new(pool.clone());

    // P5-T02 (ADR-43): the MCP servers the person's own `mcp.json` names, started now and
    // never on a page's request. No file is no servers; a broken one is said and skipped.
    let config = match mcp::config::config_path("mcp.json", "COMPANION_MCP_CONFIG") {
        Some(path) => {
            let loaded = mcp::config::McpConfig::load(&path);
            match &loaded {
                Ok(config) => println!(
                    "companion: mcp servers from {} ({} listed, {} files root(s))",
                    path.display(),
                    config.servers.len(),
                    config.roots.len()
                ),
                Err(error) => eprintln!("companion: mcp.json not used: {error}"),
            }
            loaded.unwrap_or_default()
        }
        None => mcp::config::McpConfig::default(),
    };
    let host = mcp::McpHost::start(config);

    // P5-T03 (ADR-44): the folders the person's own `documents.json` lists, indexed now, when
    // something in them changes, and when the page asks. The page never names a path.
    let (documents, documents_error) =
        match mcp::config::config_path("documents.json", "COMPANION_DOCUMENTS_CONFIG") {
            Some(path) => match ingest::config::DocumentsConfig::load(&path) {
                Ok(config) => (config, None),
                Err(error) => {
                    eprintln!("companion: documents.json not used: {error}");
                    (ingest::config::DocumentsConfig::default(), Some(error))
                }
            },
            None => (ingest::config::DocumentsConfig::default(), None),
        };
    let ingester = ingest::Ingester::new(documents, documents_error, pool, memory.registry.clone());
    for note in ingester.notes() {
        eprintln!("companion: documents: {note}");
    }
    println!(
        "companion: documents from {}: {} folder(s), {}",
        mcp::config::config_path("documents.json", "COMPANION_DOCUMENTS_CONFIG").map_or_else(
            || "(no config directory)".to_owned(),
            |path| path.display().to_string()
        ),
        ingester.folder_labels().len(),
        match ingester.embedding() {
            Some(embedding) => format!("embedding {}", embedding.model),
            None => "keyword only".to_owned(),
        }
    );
    ingester.start();

    let address = bind_address();
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("latentpresence-companion listening on http://{address}");
    axum::serve(
        listener,
        router_with_ingest(
            relay::Relay::measured(),
            memory,
            has_database_url,
            host.clone(),
            ingester,
        ),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    // The servers it started go with it.
    host.shutdown().await;
    Ok(())
}
