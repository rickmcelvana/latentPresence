//! Ingested documents and their chunks (P5-T03, ADR-44), over the `documents` and `chunks`
//! tables as 0002 and 0004 left them.
//!
//! A document is keyed by its path (`path_key`, the SHA-256 of the path), so a scan can say
//! for each file on disk "do I have this" without reading it, and for each row "is it still
//! there". A document's vectors live in `chunk_embeddings_<model>` and cascade from its
//! chunks, which cascade from it: deleting a document is one statement, and nothing of it
//! is left behind in any width (ADR-35; checked by `crates/server/tests/ingest_api.rs`).
//!
//! Static-table statements are `query!` macros against the committed `.sqlx` cache. The two
//! bulk inserts (a document's chunks, and their vectors) are built with `QueryBuilder` so a
//! thousand-page PDF is a handful of round trips rather than six thousand - over the
//! development tunnel that is the difference between seconds and minutes.

use chrono::NaiveDateTime;
use sqlx::QueryBuilder;
use sqlx::mysql::MySqlPool;

use crate::memory::{self, Collection};
use crate::store::{self, StoreError};
use crate::{DbError, vector};

/// Rows a single bulk `INSERT` carries. Four bound values a chunk keeps it far below MariaDB's
/// placeholder limit, and a statement of 100 chunks of 1,000 characters is ~100 KB.
const BATCH: usize = 100;

/// A document as the database holds it, as much as a scan needs to compare it with a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedDocument {
    pub id: u64,
    /// The full path it was indexed from.
    pub source: String,
    pub bytes: u64,
    pub modified_at: Option<NaiveDateTime>,
    pub sha256: Vec<u8>,
    pub model_id: Option<u32>,
}

/// One chunk to write, with its vector when the document is embedded.
#[derive(Debug, Clone, PartialEq)]
pub struct NewChunk {
    pub seq: u32,
    pub locator: Option<String>,
    pub text: String,
    pub vector: Option<Vec<f32>>,
}

/// A document to write with its chunks.
#[derive(Debug, Clone, PartialEq)]
pub struct NewDocument {
    pub title: String,
    pub source: String,
    pub folder: String,
    pub mime: String,
    pub sha256: [u8; 32],
    pub path_key: [u8; 32],
    pub bytes: u64,
    pub modified_at: NaiveDateTime,
    /// The registry row the vectors are from; `None`: keyword search only.
    pub model_id: Option<u32>,
    /// The width of that model, which every vector must have.
    pub dimensions: u16,
    pub chunks: Vec<NewChunk>,
}

/// What a folder holds, for `/ingest/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FolderCounts {
    pub documents: u64,
    pub chunks: u64,
}

/// The documents indexed from under `folder`.
pub async fn list_documents(
    pool: &MySqlPool,
    folder: &str,
) -> Result<Vec<IndexedDocument>, StoreError> {
    let rows = sqlx::query!(
        "SELECT id, source, bytes, modified_at, sha256, model_id
         FROM documents WHERE folder = ? ORDER BY id",
        folder,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| IndexedDocument {
            id: row.id,
            source: row.source,
            bytes: row.bytes,
            modified_at: row.modified_at,
            sha256: row.sha256,
            model_id: row.model_id,
        })
        .collect())
}

/// Delete a document. Its chunks and their vectors go with it (cascades), so there is nothing
/// else to delete. `false`: there was no such document.
pub async fn delete_document(pool: &MySqlPool, id: u64) -> Result<bool, StoreError> {
    let result = sqlx::query!("DELETE FROM documents WHERE id = ?", id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Delete the document indexed from the file whose path hashes to `path_key`, if any: before a
/// file is indexed again, so its new rows never meet the old ones at the unique key.
pub async fn delete_document_by_path(
    pool: &MySqlPool,
    path_key: &[u8; 32],
) -> Result<bool, StoreError> {
    let result = sqlx::query!("DELETE FROM documents WHERE path_key = ?", &path_key[..])
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// The file's content is what was indexed but its modified time moved (a copy, a `touch`):
/// remember the new time so the next scan does not read it again.
pub async fn touch_document(
    pool: &MySqlPool,
    id: u64,
    modified_at: NaiveDateTime,
) -> Result<(), StoreError> {
    sqlx::query!(
        "UPDATE documents SET modified_at = ? WHERE id = ?",
        modified_at,
        id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Write a document and all its chunks - and their vectors, if it has a model - in one
/// transaction: a document is there whole or not at all. Returns its id.
///
/// The vector table must already exist (`store::prepare_embedding`); every vector must be
/// the model's width, which is checked before anything is written.
pub async fn insert_document(pool: &MySqlPool, document: &NewDocument) -> Result<u64, StoreError> {
    let embedded = document.model_id;
    // Pack every vector first: a wrong-width one is a message, before any round trip.
    let mut packed: Vec<Option<Vec<u8>>> = Vec::with_capacity(document.chunks.len());
    for chunk in &document.chunks {
        packed.push(match (&chunk.vector, embedded) {
            (Some(vector), Some(_)) => {
                Some(vector::encode_width(vector, document.dimensions as usize)?)
            }
            (None, Some(_)) => {
                return Err(StoreError::BadRequest(format!(
                    "chunk {} of {} has no vector, but the document is embedded",
                    chunk.seq, document.source
                )));
            }
            (_, None) => None,
        });
    }

    let mut tx = pool.begin().await?;
    let id = sqlx::query!(
        "INSERT INTO documents
           (character_id, title, source, folder, mime, sha256, path_key, bytes,
            modified_at, model_id, indexed_at, created_at)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))",
        document.title,
        document.source,
        document.folder,
        document.mime,
        &document.sha256[..],
        &document.path_key[..],
        document.bytes,
        document.modified_at,
        embedded,
    )
    .execute(&mut *tx)
    .await?
    .last_insert_id();

    for batch in document.chunks.chunks(BATCH) {
        let mut insert = QueryBuilder::<sqlx::MySql>::new(
            "INSERT INTO chunks (document_id, seq, locator, text, created_at) ",
        );
        insert.push_values(batch, |mut row, chunk| {
            row.push_bind(id)
                .push_bind(chunk.seq)
                .push_bind(&chunk.locator)
                .push_bind(&chunk.text)
                .push("UTC_TIMESTAMP(3)");
        });
        insert.build().execute(&mut *tx).await?;
    }

    if let Some(model_id) = embedded {
        // The chunk ids are the vectors' keys; read them back in one go.
        let ids = sqlx::query!("SELECT id, seq FROM chunks WHERE document_id = ?", id)
            .fetch_all(&mut *tx)
            .await?;
        let by_seq: std::collections::HashMap<u32, u64> =
            ids.into_iter().map(|row| (row.seq, row.id)).collect();
        let table = memory::vector_table_name(Collection::Chunks, model_id);
        let mut pairs = Vec::with_capacity(document.chunks.len());
        for (chunk, bytes) in document.chunks.iter().zip(&packed) {
            let item_id = by_seq
                .get(&chunk.seq)
                .copied()
                .ok_or_else(|| DbError::Backend(format!("chunk {} was not written", chunk.seq)))?;
            pairs.push((item_id, bytes.as_deref().unwrap_or_default()));
        }
        for batch in pairs.chunks(BATCH) {
            let mut insert = QueryBuilder::<sqlx::MySql>::new(format!(
                "INSERT INTO {table} (item_id, embedding) "
            ));
            insert.push_values(batch, |mut row, (item_id, bytes)| {
                row.push_bind(*item_id).push_bind(*bytes);
            });
            insert.build().execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(id)
}

/// Documents and chunks indexed from under `folder`.
pub async fn folder_counts(pool: &MySqlPool, folder: &str) -> Result<FolderCounts, StoreError> {
    let row = sqlx::query!(
        "SELECT COUNT(DISTINCT d.id) AS documents, COUNT(c.id) AS chunks
         FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
         WHERE d.folder = ?",
        folder,
    )
    .fetch_one(pool)
    .await?;
    Ok(FolderCounts {
        documents: row.documents.max(0) as u64,
        chunks: row.chunks.max(0) as u64,
    })
}

/// Register an embedding model for document chunks and make sure its vector table exists:
/// once per scan, not once per chunk. Returns its registry id.
pub async fn prepare_model(
    pool: &MySqlPool,
    registry: &store::Registry,
    model: &memory::EmbeddingModel,
) -> Result<u32, StoreError> {
    store::prepare_embedding(pool, registry, Collection::Chunks, model).await
}

/// After a job that embedded everything with `model_id`: make it the model retrieval reads for
/// chunks, if another one is (ADR-44: a model changed in `documents.json` re-embeds every
/// document into its own table, which retrieval would otherwise never read). True if it changed.
pub async fn activate_model(
    pool: &MySqlPool,
    registry: &store::Registry,
    model_id: u32,
) -> Result<bool, StoreError> {
    let active = memory::active_collection(pool, Collection::Chunks).await?;
    if active.is_some_and(|collection| collection.model_id == model_id) {
        return Ok(false);
    }
    memory::activate_collection(pool, Collection::Chunks, model_id).await?;
    registry.invalidate();
    Ok(true)
}
