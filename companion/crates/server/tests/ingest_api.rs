//! Integration tests for document ingestion (P5-T03, ADR-44) against a real MariaDB, a fake
//! embeddings server on a local port, and temp folders.
//!
//! Skipped (with an `eprintln!`, not a failure) unless `LP_TEST_DATABASE_URL` is set, like
//! `memory_api.rs`; the tests that need no database run always. Every 200 body is validated
//! against its `components.schemas` entry in the committed OpenAPI file. Each test indexes a
//! folder of its own and deletes the documents it made (by folder), and the embedding model
//! it registered - the provider is a URL ending `/ingest-api-test/v1`, which nothing else uses.

use std::path::Path;
use std::sync::atomic::{AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, Request, StatusCode};
use axum::{Json, Router, routing::post};
use http_body_util::BodyExt;
use latentpresence_companion::ingest::Ingester;
use latentpresence_companion::ingest::config::DocumentsConfig;
use latentpresence_companion::{memory_api, relay, router_with_ingest};
use serde_json::{Value, json};
use sqlx::AssertSqlSafe;
use sqlx::mysql::MySqlPool;
use tower::ServiceExt;

const OPENAPI_JSON: &str =
    include_str!("../../../../packages/protocol/src/generated/companion.openapi.json");
const FIXTURE_PDF: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../ingest/tests/fixtures/herb-notes.pdf"
);
const PROVIDER_SUFFIX: &str = "/ingest-api-test/v1";
const WIDTH: usize = 8;

fn assert_matches_schema(name: &str, instance: &Value) {
    let doc: Value = serde_json::from_str(OPENAPI_JSON).expect("the OpenAPI file is JSON");
    let schema = doc
        .pointer(&format!("/components/schemas/{name}"))
        .unwrap_or_else(|| panic!("no component schema named {name:?}"))
        .clone();
    let validator = jsonschema::validator_for(&schema).expect("schema compiles");
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|error| error.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "{name} did not validate: {errors:?}\ninstance: {instance}"
    );
}

// ---------------------------------------------------------------------------------------
// The fake embeddings server
// ---------------------------------------------------------------------------------------

/// Answers `/embeddings` with deterministic vectors of the width it is told to, and counts
/// what it is asked.
struct Fake {
    requests: AtomicUsize,
    inputs: Mutex<Vec<String>>,
    width: AtomicU16,
    /// 0: answer; anything else: answer with that status and an error body.
    refuse: AtomicU16,
}

impl Fake {
    async fn start() -> (Arc<Self>, String) {
        let fake = Arc::new(Self {
            requests: AtomicUsize::new(0),
            inputs: Mutex::default(),
            width: AtomicU16::new(WIDTH as u16),
            refuse: AtomicU16::new(0),
        });
        let app = Router::new()
            .route(
                &format!("{PROVIDER_SUFFIX}/embeddings"),
                post(
                    |State(fake): State<Arc<Fake>>, Json(body): Json<Value>| async move {
                        fake.requests.fetch_add(1, Ordering::SeqCst);
                        let refuse = fake.refuse.load(Ordering::SeqCst);
                        if refuse != 0 {
                            return (
                                StatusCode::from_u16(refuse).expect("a status"),
                                Json(json!({ "error": "the model is not loaded" })),
                            );
                        }
                        let inputs: Vec<String> = body["input"]
                            .as_array()
                            .expect("input is a list")
                            .iter()
                            .map(|text| text.as_str().expect("a string").to_owned())
                            .collect();
                        assert!(inputs.len() <= 32, "{} inputs in one request", inputs.len());
                        let width = usize::from(fake.width.load(Ordering::SeqCst));
                        // Out of order on purpose: `index` is what says which is which.
                        let data: Vec<Value> = inputs
                            .iter()
                            .enumerate()
                            .rev()
                            .map(|(index, text)| {
                                json!({ "object": "embedding", "index": index, "embedding": vector(text, width) })
                            })
                            .collect();
                        fake.inputs.lock().expect("lock").extend(inputs);
                        (
                            StatusCode::OK,
                            Json(json!({ "object": "list", "data": data, "model": body["model"] })),
                        )
                    },
                ),
            )
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binds");
        let address = listener.local_addr().expect("an address");
        tokio::spawn(async move { axum::serve(listener, app).await });
        (fake, format!("http://{address}{PROVIDER_SUFFIX}"))
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

/// Never all zeros, and different for different texts.
fn vector(text: &str, width: usize) -> Vec<f32> {
    let seed: u32 = text.bytes().fold(7u32, |sum, byte| {
        sum.wrapping_mul(31).wrapping_add(u32::from(byte))
    });
    (0..width)
        .map(|index| ((seed.wrapping_add(index as u32 * 13) % 97) as f32 + 1.0) / 98.0)
        .collect()
}

// ---------------------------------------------------------------------------------------
// The database, and what a test leaves behind
// ---------------------------------------------------------------------------------------

/// The registry and the chunk collection are global, so tests run one at a time.
static SERIAL: std::sync::LazyLock<Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(Arc::default);

async fn database() -> Option<(MySqlPool, tokio::sync::OwnedMutexGuard<()>)> {
    let Ok(url) = std::env::var("LP_TEST_DATABASE_URL") else {
        eprintln!("ingest_api integration tests skipped: LP_TEST_DATABASE_URL is not set");
        return None;
    };
    let serial = SERIAL.clone().lock_owned().await;
    let pool = latentpresence_db::connect(&url)
        .await
        .expect("the test database connects and migrates");
    remove_test_models(&pool).await;
    Some((pool, serial))
}

/// Every model a test registered (provider ends `/ingest-api-test/v1`), its vector tables and
/// its collection rows, and the documents indexed with it. Documents first: their chunks'
/// vectors cascade, and `documents.model_id` would otherwise be set null under us.
async fn remove_test_models(pool: &MySqlPool) {
    let pattern = format!("%{PROVIDER_SUFFIX}");
    sqlx::query(
        "DELETE d FROM documents d JOIN model_registry m ON m.id = d.model_id
         WHERE m.provider LIKE ?",
    )
    .bind(&pattern)
    .execute(pool)
    .await
    .expect("delete test documents");
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT c.table_name FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE m.provider LIKE ?",
    )
    .bind(&pattern)
    .fetch_all(pool)
    .await
    .expect("list test vector tables");
    for table in tables {
        // Names come from `vector_table_name` (integers only), read back from our own rows.
        sqlx::raw_sql(AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
            .execute(pool)
            .await
            .expect("drop a test vector table");
    }
    sqlx::query(
        "DELETE c FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE m.provider LIKE ?",
    )
    .bind(&pattern)
    .execute(pool)
    .await
    .expect("delete test collections");
    sqlx::query("DELETE FROM model_registry WHERE provider LIKE ?")
        .bind(&pattern)
        .execute(pool)
        .await
        .expect("delete test models");
}

async fn cleanup(pool: &MySqlPool, folder: &str) {
    sqlx::query("DELETE FROM documents WHERE folder = ?")
        .bind(folder)
        .execute(pool)
        .await
        .expect("delete the test documents");
    remove_test_models(pool).await;
}

async fn count(pool: &MySqlPool, sql: &'static str, folder: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(folder)
        .fetch_one(pool)
        .await
        .expect("a count")
}

async fn documents_in(pool: &MySqlPool, folder: &str) -> i64 {
    count(
        pool,
        "SELECT COUNT(*) FROM documents WHERE folder = ?",
        folder,
    )
    .await
}

async fn chunks_in(pool: &MySqlPool, folder: &str) -> i64 {
    count(
        pool,
        "SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.folder = ?",
        folder,
    )
    .await
}

/// Vectors in the test model's table for the chunks under `folder`.
async fn vectors_in(pool: &MySqlPool, folder: &str) -> i64 {
    let model_id: Option<u32> = sqlx::query_scalar(
        "SELECT id FROM model_registry WHERE provider LIKE ? AND model = 'test-embed'",
    )
    .bind(format!("%{PROVIDER_SUFFIX}"))
    .fetch_optional(pool)
    .await
    .expect("model lookup");
    let Some(model_id) = model_id else { return 0 };
    let table = latentpresence_db::memory::vector_table_name(
        latentpresence_db::memory::Collection::Chunks,
        model_id,
    );
    let sql = format!(
        "SELECT COUNT(*) FROM {table} v JOIN chunks c ON c.id = v.item_id
         JOIN documents d ON d.id = c.document_id WHERE d.folder = ?"
    );
    sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(folder)
        .fetch_one(pool)
        .await
        .expect("a vector count")
}

async fn document_id(pool: &MySqlPool, folder: &str, name: &str) -> Option<u64> {
    sqlx::query_scalar("SELECT id FROM documents WHERE folder = ? AND source LIKE ?")
        .bind(folder)
        .bind(format!("%{name}"))
        .fetch_optional(pool)
        .await
        .expect("a document id")
}

// ---------------------------------------------------------------------------------------
// The folder, the ingester, the router
// ---------------------------------------------------------------------------------------

fn docx_bytes(text: &str) -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    writer
        .start_file("word/document.xml", options)
        .expect("starts a part");
    let paragraphs: String = text
        .split("\n\n")
        .map(|paragraph| format!("<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>"))
        .collect();
    write!(
        writer,
        r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{paragraphs}</w:body></w:document>"#
    )
    .expect("writes");
    writer.finish().expect("finishes").into_inner()
}

/// A folder with the herb PDF, a DOCX and a Markdown file in it.
fn garden(dir: &Path) {
    std::fs::copy(FIXTURE_PDF, dir.join("herb-notes.pdf")).expect("copies the fixture");
    std::fs::write(
        dir.join("watering.docx"),
        docx_bytes("Rosemary wants little water.\n\nMint wants a lot."),
    )
    .expect("writes the DOCX");
    std::fs::write(
        dir.join("soil.md"),
        "# Soil\n\nLoam holds water; sand does not. Compost feeds the loam.\n",
    )
    .expect("writes the Markdown");
}

fn config_json(dir: &Path, base_url: Option<&str>, dimensions: usize, watch: bool) -> Value {
    let mut config = json!({ "folders": [dir.to_string_lossy()], "watch": watch });
    if let Some(base_url) = base_url {
        config["embedding"] = json!({
            "baseUrl": base_url,
            "model": "test-embed",
            "dimensions": dimensions,
            "documentPrefix": "search_document: ",
            "queryPrefix": "search_query: ",
        });
    }
    config
}

fn build(pool: &MySqlPool, config: &Value, quiet: Option<Duration>) -> (Router, Ingester) {
    let config = DocumentsConfig::parse(&config.to_string()).expect("the test config parses");
    let memory = memory_api::MemoryState::new(Some(pool.clone()));
    let mut ingester = Ingester::new(config, None, Some(pool.clone()), memory.registry.clone());
    if let Some(quiet) = quiet {
        ingester = ingester.with_quiet(quiet);
    }
    let router = router_with_ingest(
        relay::Relay::measured(),
        memory,
        true,
        Default::default(),
        ingester.clone(),
    );
    (router, ingester)
}

async fn call(router: &Router, method: Method, uri: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .expect("a request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router answers");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("body is json: {e}: {bytes:?}"))
    };
    (status, value)
}

/// `POST /documents/search` (P5-T04, ADR-45), the answer validated.
async fn search(router: &Router, query: &str) -> Value {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/documents/search")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "query": query, "limit": 5 }).to_string(),
        ))
        .expect("a request");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("router answers");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value: Value = serde_json::from_slice(&bytes).expect("json");
    assert_matches_schema("DocumentsSearchResponse", &value);
    value
}

/// `POST /ingest/scan`, then poll the job until it is not running; every answer validated.
async fn scan(router: &Router) -> Value {
    let (status, started) = call(router, Method::POST, "/ingest/scan").await;
    assert_eq!(status, StatusCode::OK, "{started}");
    assert_matches_schema("IngestScanResponse", &started);
    wait_for(router, started["id"].as_str().expect("an id")).await
}

async fn wait_for(router: &Router, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let (status, job) = call(router, Method::GET, &format!("/ingest/jobs/{id}")).await;
        assert_eq!(status, StatusCode::OK, "{job}");
        assert_matches_schema("IngestJobResponse", &job);
        if job["status"] != "running" && job["status"] != "queued" {
            return job;
        }
        assert!(Instant::now() < deadline, "the job did not finish: {job}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn status_of(router: &Router) -> Value {
    let (status, body) = call(router, Method::GET, "/ingest/status").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("IngestStatusResponse", &body);
    body
}

fn folder_label(ingester: &Ingester) -> String {
    ingester.folder_labels().remove(0)
}

// ---------------------------------------------------------------------------------------
// Tests that need no database
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn without_a_database_the_status_is_empty_and_a_scan_is_unavailable() {
    let router = router_with_ingest(
        relay::Relay::measured(),
        memory_api::MemoryState::default(),
        false,
        Default::default(),
        Ingester::default(),
    );
    let body = status_of(&router).await;
    assert_eq!(body["folders"], json!([]));
    assert_eq!(body["embedding"], Value::Null);
    assert_eq!(body["job"], Value::Null);
    assert_eq!(body["configError"], Value::Null);
    assert_eq!(body["watching"], false);

    let (status, error) = call(&router, Method::POST, "/ingest/scan").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_matches_schema("CompanionError", &error);
    assert_eq!(error["error"]["code"], "unavailable");

    let (status, error) = call(&router, Method::GET, "/ingest/jobs/nope").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_matches_schema("CompanionError", &error);
    assert_eq!(error["error"]["code"], "not_found");
}

#[tokio::test]
async fn a_documents_file_that_did_not_parse_is_said_in_the_status() {
    let ingester = Ingester::new(
        DocumentsConfig::default(),
        Some("documents.json: expected value at line 1".to_owned()),
        None,
        Arc::default(),
    );
    let router = router_with_ingest(
        relay::Relay::measured(),
        memory_api::MemoryState::default(),
        false,
        Default::default(),
        ingester,
    );
    let body = status_of(&router).await;
    assert_eq!(body["folders"], json!([]));
    assert_eq!(
        body["configError"],
        "documents.json: expected value at line 1"
    );
}

#[tokio::test]
async fn a_folder_that_is_not_there_is_reported_as_missing() {
    let dir = tempfile::tempdir().expect("temp dir");
    let missing = dir.path().join("not-there");
    let config =
        DocumentsConfig::parse(&json!({ "folders": [missing.to_string_lossy()] }).to_string())
            .expect("parses");
    let router = router_with_ingest(
        relay::Relay::measured(),
        memory_api::MemoryState::default(),
        false,
        Default::default(),
        Ingester::new(config, None, None, Arc::default()),
    );
    let body = status_of(&router).await;
    assert_eq!(body["folders"][0]["exists"], false);
    assert_eq!(body["folders"][0]["documents"], 0);
    assert_eq!(body["folders"][0]["chunks"], 0);
}

// ---------------------------------------------------------------------------------------
// Tests against MariaDB
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_folder_is_indexed_with_pages_and_vectors_and_a_second_scan_does_nothing() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    // Before: nothing run yet, no job.
    let before = status_of(&router).await;
    assert_eq!(before["job"], Value::Null);
    assert_eq!(before["embedding"]["model"], "test-embed");
    assert_eq!(before["embedding"]["dimensions"], WIDTH);
    assert_eq!(before["embedding"]["provider"], base_url);
    assert_eq!(before["folders"][0]["exists"], true);

    let job = scan(&router).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["trigger"], "request");
    assert_eq!(job["documentsSeen"], 3);
    assert_eq!(job["documentsIndexed"], 3);
    assert_eq!(job["documentsRemoved"], 0);
    assert_eq!(job["failures"], json!([]));
    assert_eq!(job["error"], Value::Null);
    assert_ne!(job["finishedAt"], Value::Null);

    // Documents and chunks are counted, every chunk has its vector, and `p. 2` is there.
    let chunks = chunks_in(&pool, &folder).await;
    assert_eq!(documents_in(&pool, &folder).await, 3);
    assert!(chunks >= 4, "{chunks}");
    assert_eq!(job["chunksWritten"], chunks);
    assert_eq!(vectors_in(&pool, &folder).await, chunks);
    let locators: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT c.locator FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.folder = ? AND d.source LIKE '%herb-notes.pdf' ORDER BY c.seq",
    )
    .bind(&folder)
    .fetch_all(&pool)
    .await
    .expect("locators");
    assert_eq!(locators, [Some("p. 1".to_owned()), Some("p. 2".to_owned())]);
    let no_locator: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.folder = ? AND d.source NOT LIKE '%.pdf' AND c.locator IS NOT NULL",
    )
    .bind(&folder)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(no_locator, 0);
    // Titles: the PDF's first line, the DOCX's name, the Markdown's heading.
    let titles: Vec<String> =
        sqlx::query_scalar("SELECT title FROM documents WHERE folder = ? ORDER BY source")
            .bind(&folder)
            .fetch_all(&pool)
            .await
            .expect("titles");
    assert_eq!(titles.len(), 3);
    assert!(titles.contains(&"Soil".to_owned()), "{titles:?}");
    assert!(titles.contains(&"watering".to_owned()), "{titles:?}");
    // Every text sent to the model carried the document prefix.
    let sent = fake.inputs.lock().expect("lock").clone();
    assert_eq!(sent.len() as i64, chunks);
    assert!(
        sent.iter()
            .all(|text| text.starts_with("search_document: "))
    );
    // Keyword search finds a chunk: FULLTEXT is there whatever the vectors do.
    let found: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.folder = ? AND MATCH(c.text) AGAINST ('Thyme' IN NATURAL LANGUAGE MODE)",
    )
    .bind(&folder)
    .fetch_one(&pool)
    .await
    .expect("fulltext");
    assert!(found >= 1, "{found}");

    // The status now counts them.
    let after = status_of(&router).await;
    assert_eq!(after["folders"][0]["path"], folder);
    assert_eq!(after["folders"][0]["documents"], 3);
    assert_eq!(after["folders"][0]["chunks"], chunks);
    assert_eq!(after["job"]["id"], job["id"]);

    // Run again: nothing is indexed, nothing is asked of the embedding endpoint, and the
    // rows are the very rows (same ids, same `indexed_at`).
    let requests = fake.requests();
    let ids: Vec<u64> = sqlx::query_scalar("SELECT id FROM documents WHERE folder = ? ORDER BY id")
        .bind(&folder)
        .fetch_all(&pool)
        .await
        .expect("ids");
    let indexed_at: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(indexed_at AS CHAR) FROM documents WHERE folder = ? ORDER BY id",
    )
    .bind(&folder)
    .fetch_all(&pool)
    .await
    .expect("times");
    let again = scan(&router).await;
    assert_eq!(again["status"], "done", "{again}");
    assert_ne!(again["id"], job["id"]);
    assert_eq!(again["documentsSeen"], 3);
    assert_eq!(again["documentsIndexed"], 0);
    assert_eq!(again["documentsRemoved"], 0);
    assert_eq!(again["chunksWritten"], 0);
    assert_eq!(
        fake.requests(),
        requests,
        "a re-run asked the endpoint again"
    );
    let ids_after: Vec<u64> =
        sqlx::query_scalar("SELECT id FROM documents WHERE folder = ? ORDER BY id")
            .bind(&folder)
            .fetch_all(&pool)
            .await
            .expect("ids");
    let indexed_at_after: Vec<String> = sqlx::query_scalar(
        "SELECT CAST(indexed_at AS CHAR) FROM documents WHERE folder = ? ORDER BY id",
    )
    .bind(&folder)
    .fetch_all(&pool)
    .await
    .expect("times");
    assert_eq!(ids, ids_after);
    assert_eq!(indexed_at, indexed_at_after);

    // An old job id is no longer the job; the current one is.
    let (status, error) = call(
        &router,
        Method::GET,
        &format!("/ingest/jobs/{}", job["id"].as_str().unwrap()),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_matches_schema("CompanionError", &error);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_changed_file_is_indexed_again_alone_a_touched_one_is_not_read_and_a_deleted_one_is_removed()
 {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;
    assert_eq!(scan(&router).await["documentsIndexed"], 3);

    let pdf_id = document_id(&pool, &folder, "herb-notes.pdf")
        .await
        .expect("pdf");
    let docx_id = document_id(&pool, &folder, "watering.docx")
        .await
        .expect("docx");
    let md_id = document_id(&pool, &folder, "soil.md").await.expect("md");

    // The Markdown's content changes (a different size, so it differs whatever the clock).
    std::fs::write(
        dir.path().join("soil.md"),
        "# Soil\n\nLoam holds water; sand does not. Compost feeds the loam. Peat is acid.\n",
    )
    .expect("rewrites");
    let requests = fake.requests();
    let job = scan(&router).await;
    assert_eq!(job["documentsSeen"], 3);
    assert_eq!(job["documentsIndexed"], 1, "{job}");
    assert!(fake.requests() > requests);
    assert_eq!(
        document_id(&pool, &folder, "herb-notes.pdf").await,
        Some(pdf_id)
    );
    assert_eq!(
        document_id(&pool, &folder, "watering.docx").await,
        Some(docx_id)
    );
    let md_after = document_id(&pool, &folder, "soil.md").await.expect("md");
    assert_ne!(md_after, md_id, "the old rows are replaced");
    let peat: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chunks WHERE document_id = ? AND text LIKE '%Peat%'",
    )
    .bind(md_after)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(peat, 1);
    // The old document's chunks and vectors went with it.
    let chunks = chunks_in(&pool, &folder).await;
    assert_eq!(vectors_in(&pool, &folder).await, chunks);
    let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chunks WHERE document_id = ?")
        .bind(md_id)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(orphans, 0);

    // Only the modified time moves (a copy, a `touch`): the bytes are read and hashed, but
    // nothing is indexed and the endpoint is not asked.
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("watering.docx"))
        .expect("opens");
    file.set_modified(std::time::SystemTime::now() + Duration::from_secs(3600))
        .expect("touches");
    drop(file);
    let requests = fake.requests();
    let job = scan(&router).await;
    assert_eq!(job["documentsIndexed"], 0, "{job}");
    assert_eq!(fake.requests(), requests);
    assert_eq!(
        document_id(&pool, &folder, "watering.docx").await,
        Some(docx_id)
    );
    // ... and remembered: the next scan does not read it again (the stored time matches).
    let stored: Option<chrono::NaiveDateTime> =
        sqlx::query_scalar("SELECT modified_at FROM documents WHERE id = ?")
            .bind(docx_id)
            .fetch_one(&pool)
            .await
            .expect("modified_at");
    let on_disk = std::fs::metadata(dir.path().join("watering.docx"))
        .and_then(|metadata| metadata.modified())
        .expect("mtime");
    let on_disk = chrono::DateTime::<chrono::Utc>::from(on_disk).naive_utc();
    assert_eq!(
        stored.expect("a time").and_utc().timestamp_millis(),
        on_disk.and_utc().timestamp_millis()
    );

    // A file deleted from disk is removed, and its chunks and vectors with it.
    std::fs::remove_file(dir.path().join("herb-notes.pdf")).expect("deletes");
    let job = scan(&router).await;
    assert_eq!(job["documentsSeen"], 2);
    assert_eq!(job["documentsIndexed"], 0);
    assert_eq!(job["documentsRemoved"], 1, "{job}");
    assert_eq!(documents_in(&pool, &folder).await, 2);
    assert_eq!(document_id(&pool, &folder, "herb-notes.pdf").await, None);
    let chunks = chunks_in(&pool, &folder).await;
    assert_eq!(vectors_in(&pool, &folder).await, chunks);
    let status = status_of(&router).await;
    assert_eq!(status["folders"][0]["documents"], 2);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_corrupt_pdf_is_one_failure_and_the_rest_are_indexed() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (_fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let noise: Vec<u8> = (0..4096u32)
        .map(|n| (n.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    std::fs::write(dir.path().join("broken.pdf"), noise).expect("writes noise");
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    let job = scan(&router).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["documentsSeen"], 4);
    assert_eq!(job["documentsIndexed"], 3);
    let failures = job["failures"].as_array().expect("failures");
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0]["source"]
            .as_str()
            .expect("a source")
            .ends_with("broken.pdf")
    );
    assert!(!failures[0]["error"].as_str().expect("an error").is_empty());
    assert_eq!(documents_in(&pool, &folder).await, 3);
    // It is tried again next time (and fails again), not remembered as indexed.
    let again = scan(&router).await;
    assert_eq!(again["documentsIndexed"], 0);
    assert_eq!(again["failures"].as_array().expect("failures").len(), 1);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn without_an_embedding_model_chunks_are_kept_for_keyword_search_and_a_model_added_later_embeds_them()
 {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let (router, ingester) = build(&pool, &config_json(dir.path(), None, WIDTH, false), None);
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    let status = status_of(&router).await;
    assert_eq!(status["embedding"], Value::Null);
    let job = scan(&router).await;
    assert_eq!(job["documentsIndexed"], 3, "{job}");
    assert_eq!(fake.requests(), 0);
    let chunks = chunks_in(&pool, &folder).await;
    assert!(chunks >= 4);
    let embedded: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM documents WHERE folder = ? AND model_id IS NOT NULL",
    )
    .bind(&folder)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(embedded, 0);
    assert_eq!(scan(&router).await["documentsIndexed"], 0);

    // The person adds an `embedding` to documents.json and restarts: every document was
    // indexed with another model (none), so it is embedded again - once.
    let (router, _ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let job = scan(&router).await;
    assert_eq!(job["documentsIndexed"], 3, "{job}");
    assert_eq!(chunks_in(&pool, &folder).await, chunks);
    assert_eq!(vectors_in(&pool, &folder).await, chunks);
    let requests = fake.requests();
    assert!(requests > 0);
    assert_eq!(scan(&router).await["documentsIndexed"], 0);
    assert_eq!(fake.requests(), requests);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_model_changed_in_the_file_embeds_everything_again_and_becomes_the_one_searched() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (_fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let first = config_json(dir.path(), Some(&base_url), WIDTH, false);
    let (router, ingester) = build(&pool, &first, None);
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;
    assert_eq!(scan(&router).await["documentsIndexed"], 3);

    let mut second = first.clone();
    second["embedding"]["model"] = json!("test-embed-2");
    let (router, _ingester) = build(&pool, &second, None);
    let job = scan(&router).await;
    assert_eq!(job["documentsIndexed"], 3, "{job}");
    let active: String = sqlx::query_scalar(
        "SELECT m.model FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE c.collection = 'chunks' AND c.status = 'active'",
    )
    .fetch_one(&pool)
    .await
    .expect("one active chunks model");
    assert_eq!(active, "test-embed-2");
    let on_new_model: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM documents d JOIN model_registry m ON m.id = d.model_id
         WHERE d.folder = ? AND m.model = 'test-embed-2'",
    )
    .bind(&folder)
    .fetch_one(&pool)
    .await
    .expect("count");
    assert_eq!(on_new_model, 3);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_search_finds_the_page_a_fact_is_on_with_vectors_or_by_keyword_alone() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;
    assert_eq!(scan(&router).await["documentsIndexed"], 3);

    let before = fake.requests();
    let found = search(&router, "terracotta pot").await;
    assert_eq!(found["vectorSearch"], "used");
    assert_eq!(fake.requests(), before + 1, "the query was embedded once");
    let top = &found["hits"][0];
    assert_eq!(top["title"], "Herb notes");
    assert_eq!(top["locator"], "p. 2");
    assert!(
        top["text"]
            .as_str()
            .is_some_and(|text| text.contains("terracotta"))
    );
    assert!(
        top["source"]
            .as_str()
            .is_some_and(|source| source.ends_with("herb-notes.pdf"))
    );
    let docx = search(&router, "rosemary").await;
    assert_eq!(docx["hits"][0]["locator"], Value::Null);
    assert_eq!(docx["hits"][0]["title"], "watering");

    // No model in the file: the same words still find it.
    let (router, _ingester) = build(&pool, &config_json(dir.path(), None, WIDTH, false), None);
    let keyword = search(&router, "terracotta pot").await;
    assert_eq!(keyword["vectorSearch"], "no-model");
    assert_eq!(keyword["hits"][0]["locator"], "p. 2");

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn an_embedding_endpoint_that_refuses_or_answers_the_wrong_width_fails_the_job() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    fake.refuse.store(500, Ordering::SeqCst);
    let job = scan(&router).await;
    assert_eq!(job["status"], "failed", "{job}");
    let error = job["error"].as_str().expect("an error");
    assert!(error.contains("500"), "{error}");
    assert_eq!(documents_in(&pool, &folder).await, 0);

    fake.refuse.store(0, Ordering::SeqCst);
    fake.width.store(WIDTH as u16 + 3, Ordering::SeqCst);
    let job = scan(&router).await;
    assert_eq!(job["status"], "failed", "{job}");
    let error = job["error"].as_str().expect("an error");
    assert!(
        error.contains(&format!("{} dimensions", WIDTH + 3)) && error.contains(&WIDTH.to_string()),
        "{error}"
    );
    assert_eq!(documents_in(&pool, &folder).await, 0);

    // Fixed, it goes through.
    fake.width.store(WIDTH as u16, Ordering::SeqCst);
    let job = scan(&router).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["documentsIndexed"], 3);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_folder_that_has_gone_is_a_failure_and_its_documents_are_kept() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let dir = tempfile::tempdir().expect("temp dir");
    let inside = dir.path().join("manuals");
    std::fs::create_dir(&inside).expect("dir");
    garden(&inside);
    let (router, ingester) = build(&pool, &config_json(&inside, None, WIDTH, false), None);
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;
    assert_eq!(scan(&router).await["documentsIndexed"], 3);

    // An unplugged drive must not empty the index.
    std::fs::remove_dir_all(&inside).expect("removes the folder");
    let job = scan(&router).await;
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["documentsRemoved"], 0);
    assert_eq!(job["documentsSeen"], 0);
    assert_eq!(job["failures"].as_array().expect("failures").len(), 1);
    assert_eq!(documents_in(&pool, &folder).await, 3);
    let status = status_of(&router).await;
    assert_eq!(status["folders"][0]["exists"], false);
    assert_eq!(status["folders"][0]["documents"], 3);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_scan_asked_for_while_one_runs_gets_that_one() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    // Enough chunks that the first job is still running when the second request arrives.
    let paragraph = "Basil likes sun and water, but thyme prefers it dry. ".repeat(20);
    for index in 0..8 {
        std::fs::write(
            dir.path().join(format!("notes-{index}.txt")),
            format!("{paragraph}\n\n{paragraph}\n\n{paragraph}\n\n{paragraph}"),
        )
        .expect("writes");
    }
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    let (status, first) = call(&router, Method::POST, "/ingest/scan").await;
    assert_eq!(status, StatusCode::OK);
    let (status, second) = call(&router, Method::POST, "/ingest/scan").await;
    assert_eq!(status, StatusCode::OK);
    assert_matches_schema("IngestScanResponse", &second);
    // The second answer is the first job if it was still running, and a later one if the first
    // had already finished (a fast machine): never two jobs at once.
    if first["id"] == second["id"] {
        let job = wait_for(&router, first["id"].as_str().unwrap()).await;
        assert_eq!(job["documentsIndexed"], 8, "{job}");
        assert_eq!(documents_in(&pool, &folder).await, 8);
        assert!(fake.requests() >= 8);
    } else {
        let first_done = wait_for(&router, first["id"].as_str().unwrap()).await;
        let _ = first_done;
        wait_for(&router, second["id"].as_str().unwrap()).await;
        assert_eq!(documents_in(&pool, &folder).await, 8);
    }

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn the_companion_starting_and_a_change_in_a_watched_folder_each_start_a_scan() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (_fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    garden(dir.path());
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, true),
        Some(Duration::from_millis(200)),
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    // At start: a job with the trigger `start`, and the folder is being watched.
    let started = ingester.start().expect("a job starts");
    assert_eq!(
        started.trigger,
        latentpresence_companion::ingest::Trigger::Start
    );
    let job = wait_for(&router, &started.id).await;
    assert_eq!(job["trigger"], "start");
    assert_eq!(job["documentsIndexed"], 3, "{job}");
    assert_eq!(status_of(&router).await["watching"], true);

    // A file appears: after the quiet period a `watch` job indexes it, and only it.
    std::fs::write(
        dir.path().join("new-herbs.md"),
        "# Sage\n\nSage likes well drained soil.\n",
    )
    .expect("writes");
    let deadline = Instant::now() + Duration::from_secs(30);
    let watched = loop {
        let status = status_of(&router).await;
        if let Some(job) = status["job"].as_object()
            && job["trigger"] == "watch"
            && job["status"] == "done"
        {
            break Value::Object(job.clone());
        }
        assert!(Instant::now() < deadline, "no watch job ran: {status}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(watched["documentsIndexed"], 1, "{watched}");
    assert_eq!(documents_in(&pool, &folder).await, 4);

    cleanup(&pool, &folder).await;
}

#[tokio::test]
async fn a_shelf_of_pdfs_indexes_without_errors_and_running_again_is_a_no_op() {
    let Some((pool, _serial)) = database().await else {
        return;
    };
    let (fake, base_url) = Fake::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    // The two-page fixture sixty times over, spread across subfolders: 120 pages. (The
    // 1,000-page run is main's, live, in the Browser pane; this is its shape in seconds.)
    for index in 0..60 {
        let sub = dir.path().join(format!("shelf-{}", index % 10));
        std::fs::create_dir_all(&sub).expect("dir");
        std::fs::copy(FIXTURE_PDF, sub.join(format!("herbs-{index}.pdf"))).expect("copies");
    }
    let (router, ingester) = build(
        &pool,
        &config_json(dir.path(), Some(&base_url), WIDTH, false),
        None,
    );
    let folder = folder_label(&ingester);
    cleanup(&pool, &folder).await;

    let started = Instant::now();
    let job = scan(&router).await;
    eprintln!("120 pages indexed in {:?}", started.elapsed());
    assert_eq!(job["status"], "done", "{job}");
    assert_eq!(job["documentsSeen"], 60);
    assert_eq!(job["documentsIndexed"], 60);
    assert_eq!(job["failures"], json!([]));
    let chunks = chunks_in(&pool, &folder).await;
    assert_eq!(job["chunksWritten"], chunks);
    assert_eq!(vectors_in(&pool, &folder).await, chunks);

    let requests = fake.requests();
    let started = Instant::now();
    let again = scan(&router).await;
    eprintln!("the re-run took {:?}", started.elapsed());
    assert_eq!(again["documentsIndexed"], 0);
    assert_eq!(again["documentsRemoved"], 0);
    assert_eq!(again["failures"], json!([]));
    assert_eq!(fake.requests(), requests);

    cleanup(&pool, &folder).await;
}
