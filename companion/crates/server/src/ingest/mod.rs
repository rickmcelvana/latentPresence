//! Document ingestion (P5-T03, ADR-44): the folders the person's own `documents.json` lists,
//! indexed into `documents` and `chunks` - at start, when something in them changes, and when
//! the page asks - and the three routes that report it.
//!
//! **The page never names a path.** `POST /ingest/scan` takes no body; there is nothing to
//! smuggle a path through. A scan is incremental: a file with the size and modified time the
//! database has is not even read; one that changed is hashed, and indexed again only if its
//! content differs; one that is gone is removed. Re-running over unchanged folders writes
//! nothing and asks the embedding endpoint nothing. One job runs at a time, and a scan asked
//! for while one runs gets that one.

pub mod config;
mod embed;
mod walk;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use axum::extract::{Path as UrlPath, State};
use axum::{Json, Router, routing::get, routing::post};
use latentpresence_db::documents::{self, IndexedDocument, NewChunk, NewDocument};
use latentpresence_db::store::Registry;
use latentpresence_db::time as time_util;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sqlx::mysql::MySqlPool;

use crate::memory_api::ApiError;
use config::{DocumentsConfig, EmbeddingConfig, Folder};
use embed::Embedder;
use walk::{FoundFile, walk};

/// How long a watched folder must be quiet before a change starts a scan: saving a book
/// writes it in pieces, and copying a folder is hundreds of events.
pub const QUIET: Duration = Duration::from_secs(3);
/// `IngestJobSchema.failures` holds at most this many.
const MAX_FAILURES: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Trigger {
    /// The companion starting.
    Start,
    /// A change under a watched folder.
    Watch,
    /// The page asked (`POST /ingest/scan`).
    Request,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub source: String,
    pub error: String,
}

/// `IngestJobSchema`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub status: JobStatus,
    pub trigger: Trigger,
    pub documents_seen: u64,
    pub documents_indexed: u64,
    pub documents_removed: u64,
    pub chunks_written: u64,
    pub failures: Vec<Failure>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Slot {
    /// The running job, or the last one.
    job: Option<Job>,
    running: bool,
    /// A watched change arrived while a job ran: scan again when it ends.
    rerun: bool,
    counter: u64,
}

struct Inner {
    folders: Vec<Folder>,
    notes: Vec<String>,
    embedder: Option<Embedder>,
    watch: bool,
    config_error: Option<String>,
    pool: Option<MySqlPool>,
    registry: Arc<Registry>,
    quiet: Duration,
    /// Makes job ids differ between runs of the companion.
    epoch: String,
    slot: Mutex<Slot>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

/// The ingester, cheap to clone: it is held by the router and by the tasks it starts.
#[derive(Clone)]
pub struct Ingester {
    inner: Arc<Inner>,
}

impl Default for Ingester {
    /// No folders, no database: every scan answers `unavailable`.
    fn default() -> Self {
        Self::new(DocumentsConfig::default(), None, None, Arc::default())
    }
}

impl Ingester {
    /// `config_error`: why `documents.json` was not used, said in the status; `config` is then
    /// the default. The folders are canonicalised here, once.
    pub fn new(
        config: DocumentsConfig,
        config_error: Option<String>,
        pool: Option<MySqlPool>,
        registry: Arc<Registry>,
    ) -> Self {
        let (folders, notes) = config::resolve(&config.folders);
        let mut config_error = config_error;
        let embedder = match config.embedding {
            Some(embedding) => match Embedder::new(embedding) {
                Ok(embedder) => Some(embedder),
                Err(error) => {
                    config_error.get_or_insert(error);
                    None
                }
            },
            None => None,
        };
        let epoch = format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or_default()
        );
        Self {
            inner: Arc::new(Inner {
                folders,
                notes,
                embedder,
                watch: config.watch,
                config_error,
                pool,
                registry,
                quiet: QUIET,
                epoch,
                slot: Mutex::default(),
                watcher: Mutex::default(),
            }),
        }
    }

    /// The same with a chosen quiet period before a watched change starts a scan: what tests use
    /// in place of three seconds. Call it before anything else holds a clone.
    pub fn with_quiet(mut self, quiet: Duration) -> Self {
        if let Some(inner) = Arc::get_mut(&mut self.inner) {
            inner.quiet = quiet;
        }
        self
    }

    /// Folders that were left out and why (listed twice, inside another folder).
    pub fn notes(&self) -> &[String] {
        &self.inner.notes
    }

    pub fn folder_labels(&self) -> Vec<String> {
        self.inner
            .folders
            .iter()
            .map(|folder| folder.label.clone())
            .collect()
    }

    pub fn embedding(&self) -> Option<&EmbeddingConfig> {
        self.inner.embedder.as_ref().map(Embedder::config)
    }

    pub fn config_error(&self) -> Option<&str> {
        self.inner.config_error.as_deref()
    }

    /// At start: watch the folders, and scan them now. Nothing to do without folders and a
    /// database. Returns the job it started, if any.
    pub fn start(&self) -> Option<Job> {
        if self.inner.folders.is_empty() || self.inner.pool.is_none() {
            return None;
        }
        if self.inner.watch {
            self.start_watching();
        }
        self.scan(Trigger::Start).ok()
    }

    /// Start a scan, or answer the one that is running (a watched change asks for one more
    /// when it ends). `unavailable` without a database.
    pub fn scan(&self, trigger: Trigger) -> Result<Job, ApiError> {
        if self.inner.pool.is_none() {
            return Err(ApiError::Unavailable);
        }
        let job = {
            let mut slot = lock(&self.inner.slot);
            if slot.running {
                if trigger == Trigger::Watch {
                    slot.rerun = true;
                }
                return Ok(slot.job.clone().expect("a running job is recorded"));
            }
            slot.counter += 1;
            let job = Job {
                id: format!("ingest-{}-{}", self.inner.epoch, slot.counter),
                status: JobStatus::Running,
                trigger,
                documents_seen: 0,
                documents_indexed: 0,
                documents_removed: 0,
                chunks_written: 0,
                failures: Vec::new(),
                started_at: time_util::format_timestamp(chrono::Utc::now().naive_utc()),
                finished_at: None,
                error: None,
            };
            slot.job = Some(job.clone());
            slot.running = true;
            slot.rerun = false;
            job
        };
        let ingester = self.clone();
        tokio::spawn(async move {
            // The work runs in a task of its own so that a panic in it ends the job with a
            // reason instead of leaving "running" in the slot for good.
            let worker = tokio::spawn(work(ingester.inner.clone()));
            let outcome = match worker.await {
                Ok(outcome) => outcome,
                Err(_) => Err("the scan stopped unexpectedly".to_owned()),
            };
            let rerun = {
                let mut slot = lock(&ingester.inner.slot);
                if let Some(job) = slot.job.as_mut() {
                    job.finished_at =
                        Some(time_util::format_timestamp(chrono::Utc::now().naive_utc()));
                    match outcome {
                        Ok(()) => job.status = JobStatus::Done,
                        Err(error) => {
                            job.status = JobStatus::Failed;
                            job.error = Some(error);
                        }
                    }
                }
                slot.running = false;
                std::mem::take(&mut slot.rerun)
            };
            if rerun {
                let _ = ingester.scan(Trigger::Watch);
            }
        });
        Ok(job)
    }

    /// The running job, or the last.
    pub fn job(&self) -> Option<Job> {
        lock(&self.inner.slot).job.clone()
    }

    fn update(inner: &Inner, change: impl FnOnce(&mut Job)) {
        if let Some(job) = lock(&inner.slot).job.as_mut() {
            change(job);
        }
    }

    fn fail(inner: &Inner, source: impl Into<String>, error: impl Into<String>) {
        let (source, error) = (source.into(), error.into());
        Self::update(inner, |job| {
            if job.failures.len() < MAX_FAILURES {
                job.failures.push(Failure {
                    source: if source.is_empty() {
                        "?".into()
                    } else {
                        source
                    },
                    error: if error.is_empty() {
                        "failed".into()
                    } else {
                        error
                    },
                });
            }
        });
    }

    fn watching(&self) -> bool {
        lock(&self.inner.watcher).is_some()
    }

    fn start_watching(&self) {
        if self.watching() {
            return;
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let roots: Vec<PathBuf> = self
            .inner
            .folders
            .iter()
            .map(|folder| folder.path.clone())
            .collect();
        let filter_roots = roots.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else { return };
            // Reading a file is not changing it; a change inside `.git` is not a document.
            if event.kind.is_access()
                || event
                    .paths
                    .iter()
                    .all(|path| is_hidden_below(&filter_roots, path))
            {
                return;
            }
            let _ = tx.send(());
        });
        let mut watcher = match watcher {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("companion: documents are not being watched: {error}");
                return;
            }
        };
        let mut any = false;
        for root in &roots {
            match watcher.watch(root, RecursiveMode::Recursive) {
                Ok(()) => any = true,
                Err(error) => {
                    eprintln!("companion: not watching {}: {error}", root.display());
                }
            }
        }
        if !any {
            return;
        }
        *lock(&self.inner.watcher) = Some(watcher);
        // Held weakly: the watcher lives in `Inner`, and a task that owned `Inner` would keep
        // the watcher - and itself - alive for ever.
        let inner: Weak<Inner> = Arc::downgrade(&self.inner);
        let quiet = self.inner.quiet;
        tokio::spawn(async move {
            while rx.recv().await.is_some() {
                // Wait for the folder to go quiet, then scan once.
                loop {
                    match tokio::time::timeout(quiet, rx.recv()).await {
                        Ok(Some(())) => continue,
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                let Some(inner) = inner.upgrade() else {
                    return;
                };
                let _ = Ingester { inner }.scan(Trigger::Watch);
            }
        });
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether `path` is inside a hidden file or folder below the watched root it is under.
fn is_hidden_below(roots: &[PathBuf], path: &Path) -> bool {
    roots
        .iter()
        .find_map(|root| path.strip_prefix(root).ok())
        .is_some_and(|relative| {
            relative
                .components()
                .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
        })
}

// ---------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------

/// Why a file did not go in.
enum FileError {
    /// This file only: reported, and the job goes on.
    Failed(String),
    /// The job cannot go on: the database, or the embedding endpoint, refused.
    Fatal(String),
}

async fn work(inner: Arc<Inner>) -> Result<(), String> {
    let pool = inner
        .pool
        .as_ref()
        .ok_or_else(|| "no database is configured".to_owned())?;
    // Once per job, not once per chunk: register the model and make sure its vector table
    // exists (activating it if no model is active for chunks yet).
    let model_id = match &inner.embedder {
        Some(embedder) => Some(
            documents::prepare_model(pool, &inner.registry, &embedder.config().model())
                .await
                .map_err(|error| format!("could not register the embedding model: {error}"))?,
        ),
        None => None,
    };
    for folder in &inner.folders {
        scan_folder(&inner, pool, folder, model_id).await?;
    }
    // Every document is now embedded with the configured model (a file that failed keeps its
    // old rows), so it is the one retrieval reads — also after the model in `documents.json`
    // changed, when the new vectors went to a table of their own.
    if let Some(model_id) = model_id
        && documents::activate_model(pool, &inner.registry, model_id)
            .await
            .map_err(|error| format!("could not make the embedding model active: {error}"))?
    {
        eprintln!("companion: documents are now searched with model {model_id}");
    }
    Ok(())
}

async fn scan_folder(
    inner: &Arc<Inner>,
    pool: &MySqlPool,
    folder: &Folder,
    model_id: Option<u32>,
) -> Result<(), String> {
    let root = folder.path.clone();
    let walked = tokio::task::spawn_blocking(move || walk(&root))
        .await
        .map_err(|_| "the folder walk stopped unexpectedly".to_owned())?;
    // A folder that cannot be read at all (an unplugged drive, a deleted folder) is a failure
    // to report, not a reason to forget everything indexed from it.
    if let Some((_, why)) = walked.problems.iter().find(|(dir, _)| *dir == folder.path) {
        Ingester::fail(
            inner,
            folder.label.clone(),
            format!("could not be read: {why}"),
        );
        return Ok(());
    }
    for (dir, why) in &walked.problems {
        Ingester::fail(
            inner,
            dir.to_string_lossy(),
            format!("could not be read: {why}"),
        );
    }
    let found = walked.files.len() as u64;
    Ingester::update(inner, |job| job.documents_seen += found);

    let mut known: HashMap<String, IndexedDocument> =
        documents::list_documents(pool, &folder.label)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|document| (document.source.clone(), document))
            .collect();

    for file in walked.files {
        let source = file.path.to_string_lossy().into_owned();
        let before = known.remove(&source);
        match index_file(inner, pool, folder, &file, &source, before, model_id).await {
            Ok(()) => {}
            Err(FileError::Failed(error)) => Ingester::fail(inner, source, error),
            Err(FileError::Fatal(error)) => return Err(error),
        }
    }

    // What the database has and the walk did not find is gone from disk (or no longer a
    // supported, visible, small-enough file) - unless it is in a folder that could not be read.
    for document in known.into_values() {
        let unreadable = walked
            .problems
            .iter()
            .any(|(dir, _)| Path::new(&document.source).starts_with(dir));
        if unreadable {
            continue;
        }
        documents::delete_document(pool, document.id)
            .await
            .map_err(|error| error.to_string())?;
        Ingester::update(inner, |job| job.documents_removed += 1);
    }
    Ok(())
}

/// What the blocking half of indexing a file found.
enum Prepared {
    /// Same bytes, same model: only the modified time moved.
    Unchanged,
    Ready {
        hash: [u8; 32],
        bytes: u64,
        title: String,
        mime: &'static str,
        chunks: Vec<latentpresence_ingest::Chunk>,
    },
}

async fn index_file(
    inner: &Arc<Inner>,
    pool: &MySqlPool,
    folder: &Folder,
    file: &FoundFile,
    source: &str,
    before: Option<IndexedDocument>,
    model_id: Option<u32>,
) -> Result<(), FileError> {
    // Same size, same modified time, same model: not even read.
    if let Some(document) = &before
        && document.bytes == file.bytes
        && document.modified_at == Some(file.modified_at)
        && document.model_id == model_id
    {
        return Ok(());
    }
    if source.chars().count() > 2_000 {
        return Err(FileError::Failed(
            "its path is too long to record".to_owned(),
        ));
    }

    // The same bytes under the same model need nothing but their new modified time.
    let same_content = before
        .as_ref()
        .filter(|document| document.model_id == model_id)
        .map(|document| document.sha256.clone());
    let path = file.path.clone();
    let prepared = tokio::task::spawn_blocking(move || -> Result<Prepared, String> {
        let bytes = std::fs::read(&path).map_err(|error| format!("could not be read: {error}"))?;
        let hash = latentpresence_ingest::sha256(&bytes);
        if same_content.as_deref() == Some(&hash[..]) {
            return Ok(Prepared::Unchanged);
        }
        let extracted = latentpresence_ingest::extract_bytes(&path, &bytes)?;
        let chunks = latentpresence_ingest::chunk(&extracted.pages);
        Ok(Prepared::Ready {
            hash,
            bytes: bytes.len() as u64,
            title: extracted.title,
            mime: extracted.mime,
            chunks,
        })
    })
    .await
    .map_err(|_| FileError::Failed("could not be processed".to_owned()))?
    .map_err(FileError::Failed)?;

    let (hash, bytes, title, mime, chunks) = match prepared {
        Prepared::Unchanged => {
            if let Some(document) = &before {
                documents::touch_document(pool, document.id, file.modified_at)
                    .await
                    .map_err(|error| FileError::Fatal(error.to_string()))?;
            }
            return Ok(());
        }
        Prepared::Ready {
            hash,
            bytes,
            title,
            mime,
            chunks,
        } => (hash, bytes, title, mime, chunks),
    };

    // Embedded before the old rows go: a file that is half-written, or an endpoint that is
    // down, leaves what was there.
    let vectors = match (&inner.embedder, model_id) {
        (Some(embedder), Some(_)) if !chunks.is_empty() => {
            let texts: Vec<String> = chunks.iter().map(|chunk| chunk.text.clone()).collect();
            Some(
                embedder
                    .embed_documents(&texts)
                    .await
                    .map_err(FileError::Fatal)?,
            )
        }
        _ => None,
    };
    let written = chunks.len() as u64;
    let mut rows = Vec::with_capacity(chunks.len());
    for (index, chunk) in chunks.into_iter().enumerate() {
        rows.push(NewChunk {
            seq: chunk.seq,
            locator: chunk.locator,
            text: chunk.text,
            vector: vectors.as_ref().map(|all| all[index].clone()),
        });
    }
    let path_key = latentpresence_ingest::sha256(source.as_bytes());
    let document = NewDocument {
        title,
        source: source.to_owned(),
        folder: folder.label.clone(),
        mime: mime.to_owned(),
        sha256: hash,
        path_key,
        bytes,
        modified_at: file.modified_at,
        model_id,
        dimensions: inner
            .embedder
            .as_ref()
            .map_or(0, |embedder| embedder.config().dimensions),
        chunks: rows,
    };
    let fatal = |error: latentpresence_db::store::StoreError| FileError::Fatal(error.to_string());
    documents::delete_document_by_path(pool, &path_key)
        .await
        .map_err(fatal)?;
    documents::insert_document(pool, &document)
        .await
        .map_err(fatal)?;
    Ingester::update(inner, |job| {
        job.documents_indexed += 1;
        job.chunks_written += written;
    });
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Routes (`IngestStatusSchema`, `IngestJobSchema`)
// ---------------------------------------------------------------------------------------

#[derive(Serialize)]
struct FolderStatus {
    path: String,
    exists: bool,
    documents: u64,
    chunks: u64,
}

#[derive(Serialize)]
struct EmbeddingStatus {
    provider: String,
    model: String,
    dimensions: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    folders: Vec<FolderStatus>,
    embedding: Option<EmbeddingStatus>,
    watching: bool,
    job: Option<Job>,
    config_error: Option<String>,
}

async fn status(State(ingester): State<Ingester>) -> Result<Json<StatusResponse>, ApiError> {
    let inner = &ingester.inner;
    let mut folders = Vec::with_capacity(inner.folders.len());
    for folder in &inner.folders {
        let counts = match &inner.pool {
            Some(pool) => documents::folder_counts(pool, &folder.label).await?,
            None => documents::FolderCounts {
                documents: 0,
                chunks: 0,
            },
        };
        folders.push(FolderStatus {
            path: folder.label.clone(),
            exists: std::fs::metadata(&folder.path).is_ok_and(|metadata| metadata.is_dir()),
            documents: counts.documents,
            chunks: counts.chunks,
        });
    }
    Ok(Json(StatusResponse {
        folders,
        embedding: ingester.embedding().map(|embedding| EmbeddingStatus {
            provider: embedding.base_url.clone(),
            model: embedding.model.clone(),
            dimensions: embedding.dimensions,
        }),
        watching: ingester.watching(),
        job: ingester.job(),
        config_error: inner.config_error.clone(),
    }))
}

async fn scan(State(ingester): State<Ingester>) -> Result<Json<Job>, ApiError> {
    ingester.scan(Trigger::Request).map(Json)
}

async fn job(
    State(ingester): State<Ingester>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<Job>, ApiError> {
    match ingester.job() {
        Some(job) if job.id == id => Ok(Json(job)),
        _ => Err(ApiError::NotFound(format!("no scan with the id {id}"))),
    }
}

// ---------------------------------------------------------------------------------------
// Search (`DocumentSearchRequestSchema`, `DocumentSearchResponseSchema`; P5-T04, ADR-45)
// ---------------------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct SearchRequest {
    query: String,
    limit: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HitOut {
    chunk_id: String,
    document_id: String,
    collection: String,
    title: String,
    text: String,
    score: f64,
    source: String,
    locator: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    hits: Vec<HitOut>,
    vector_search: &'static str,
}

/// The query embedded with the configured model and its query prefix, compared with the active
/// chunks table when that is the model's; keyword matches either way; fused by reciprocal rank.
async fn search(
    State(ingester): State<Ingester>,
    body: Result<Json<SearchRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<SearchResponse>, ApiError> {
    let Json(request) = body.map_err(|rejection| ApiError::BadRequest(rejection.body_text()))?;
    let query = request.query.trim();
    if query.is_empty() || query.chars().count() > 1000 || !(1..=10).contains(&request.limit) {
        return Err(ApiError::BadRequest(
            "a search needs a query of 1 to 1000 characters and a limit of 1 to 10".into(),
        ));
    }
    let inner = &ingester.inner;
    let pool = inner.pool.as_ref().ok_or(ApiError::Unavailable)?;
    let mut vector_search = "no-model";
    let mut probe: Option<(String, Vec<u8>)> = None;
    if let Some(embedder) = &inner.embedder {
        let config = embedder.config();
        let table = documents::active_table_for(pool, &config.model()).await?;
        if let Some(table) = table {
            match embedder.embed_query(query).await {
                Ok(vector) => {
                    let bytes = latentpresence_db::vector::encode_width(
                        &vector,
                        config.dimensions as usize,
                    )
                    .map_err(|error| ApiError::Internal(error.to_string()))?;
                    probe = Some((table, bytes));
                    vector_search = "used";
                }
                // The endpoint is down: the words still find what they can.
                Err(_) => vector_search = "unavailable",
            }
        }
    }
    let hits = documents::search(
        pool,
        query,
        probe
            .as_ref()
            .map(|(table, bytes)| (table.as_str(), bytes.as_slice())),
        request.limit,
    )
    .await?;
    Ok(Json(SearchResponse {
        hits: hits
            .into_iter()
            .map(|hit| HitOut {
                chunk_id: hit.chunk_id.to_string(),
                document_id: hit.document_id.to_string(),
                collection: hit.folder,
                title: hit.title,
                text: hit.text,
                score: hit.score,
                source: hit.source,
                locator: hit.locator,
            })
            .collect(),
        vector_search,
    }))
}

pub fn router(ingester: Ingester) -> Router {
    Router::new()
        .route("/ingest/status", get(status))
        .route("/ingest/scan", post(scan))
        .route("/ingest/jobs/{id}", get(job))
        .route("/documents/search", post(search))
        .with_state(ingester)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_in_a_hidden_folder_below_a_root_is_not_a_document_change() {
        let roots = vec![PathBuf::from("/home/me/notes")];
        assert!(is_hidden_below(
            &roots,
            Path::new("/home/me/notes/.git/index")
        ));
        assert!(is_hidden_below(
            &roots,
            Path::new("/home/me/notes/a/.b.txt")
        ));
        assert!(!is_hidden_below(
            &roots,
            Path::new("/home/me/notes/a/b.txt")
        ));
        // A dot above the root does not count.
        let roots = vec![PathBuf::from("/home/me/.docs")];
        assert!(!is_hidden_below(&roots, Path::new("/home/me/.docs/a.txt")));
    }

    #[tokio::test]
    async fn without_a_database_a_scan_is_unavailable_and_nothing_starts() {
        let ingester = Ingester::default();
        assert!(matches!(
            ingester.scan(Trigger::Request),
            Err(ApiError::Unavailable)
        ));
        assert!(ingester.start().is_none());
        assert!(ingester.job().is_none());
    }
}
