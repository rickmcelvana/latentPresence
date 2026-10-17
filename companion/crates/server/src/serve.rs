//! Starting the companion, for the binary and for the desktop app (P8-T01, ADR-60).
//!
//! `main.rs` used to do all of this inline. The desktop shell runs the same companion inside its
//! own process, so the startup — the database, the MCP servers, the schedules, the documents —
//! lives here once, and both call it. What differs is in `ServeOptions`: the desktop app passes a
//! listener it bound itself, a pairing token, and the local model servers its relay may reach.

use std::future::Future;

use crate::{bench, ingest, mcp, memory_api, pairing, relay, routes, schedules, with_cors};

/// What the caller decides about this companion.
pub struct ServeOptions {
    /// Bound by the caller, so it knows the port before anything is served.
    pub listener: tokio::net::TcpListener,
    /// Required on every request when set (`pairing`). The binary runs without one, as before.
    pub token: Option<String>,
    /// Who the relay may reach: `Relay::measured()` for the binary; plus this machine's local
    /// model servers for the desktop app (`Relay::desktop()`).
    pub relay: relay::Relay,
    /// The database address the caller holds (the desktop app keeps one in Credential Manager,
    /// ADR-62). When set it is used instead of `DATABASE_URL` or a `.env`; when not, those are
    /// read as before. Never logged: it carries a password.
    pub database_url: Option<String>,
}

/// Everything `main.rs` used to start, then serves until `shutdown` resolves. The MCP servers it
/// started go with it.
pub async fn serve(
    options: ServeOptions,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error>> {
    // The pool comes from `DATABASE_URL` in the environment or the repo's `.env`, shared
    // with `bench` and `memory-check` rather than read again here. `has_database_url`
    // distinguishes "not configured" from "configured but did not come up" for `/health`
    // (`HealthResponseSchema.database.kind`); connecting also runs the migrations.
    let database_url = match options.database_url.clone() {
        Some(url) if !url.trim().is_empty() => Ok(url),
        _ => bench::database_url(),
    };
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
                    "companion: mcp servers from {} ({} listed, {} files root(s){}{})",
                    path.display(),
                    config.servers.len(),
                    config.roots.len(),
                    if config.web.is_some() { ", web" } else { "" },
                    if config.home.is_some() {
                        ", Home Assistant"
                    } else {
                        ""
                    }
                ),
                Err(error) => eprintln!("companion: mcp.json not used: {error}"),
            }
            loaded.unwrap_or_default()
        }
        None => mcp::config::McpConfig::default(),
    };
    let host = mcp::McpHost::start(config);

    // P6-T07b (ADR-57): the companion's own schedules — tool-only jobs that run with no page open.
    if let Some(pool) = pool.clone() {
        schedules::runner::spawn(pool, memory.registry.clone(), host.clone());
    }

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

    let address = options.listener.local_addr()?;
    println!(
        "latentpresence-companion listening on http://{address}{}",
        if options.token.is_some() {
            " (paired)"
        } else {
            ""
        }
    );
    let app = routes(
        options.relay,
        memory,
        has_database_url,
        host.clone(),
        ingester,
    );
    let app = with_cors(match options.token {
        Some(token) => pairing::require(app, token),
        None => app,
    });
    axum::serve(options.listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    host.shutdown().await;
    Ok(())
}
