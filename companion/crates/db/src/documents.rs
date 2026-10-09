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

/// A chunk a search found (P5-T04, ADR-45), with where it is from.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub chunk_id: u64,
    pub document_id: u64,
    pub folder: String,
    pub title: String,
    pub source: String,
    pub locator: Option<String>,
    pub text: String,
    /// Reciprocal-rank fusion, scaled so a chunk first in both lists is 1.
    pub score: f64,
}

/// `id, document_id, locator, text, folder, title, source`.
type HitRow = (u64, u64, Option<String>, String, String, String, String);

/// The reciprocal-rank constant: the usual 60, so a list's top few dominate without the rest
/// counting for nothing.
const RRF_K: f64 = 60.0;

/// Fuse ranked id lists by reciprocal rank: best first, `limit` of them, with scores in 0..=1.
pub fn fuse(lists: &[Vec<u64>], limit: usize) -> Vec<(u64, f64)> {
    let mut scores: Vec<(u64, f64)> = Vec::new();
    for list in lists {
        for (rank, id) in list.iter().enumerate() {
            let add = 1.0 / (RRF_K + rank as f64 + 1.0);
            match scores.iter_mut().find(|(seen, _)| seen == id) {
                Some((_, score)) => *score += add,
                None => scores.push((*id, add)),
            }
        }
    }
    let best = lists.len().max(1) as f64 / (RRF_K + 1.0);
    scores.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    scores.truncate(limit);
    scores
        .into_iter()
        .map(|(id, score)| (id, (score / best).clamp(0.0, 1.0)))
        .collect()
}

/// The chunks that best answer `query`: the nearest by vector when `probe` (the active chunks
/// table and the query's encoded vector) is given, the best `FULLTEXT` matches, fused.
pub async fn search(
    pool: &MySqlPool,
    query: &str,
    probe: Option<(&str, &[u8])>,
    limit: usize,
) -> Result<Vec<SearchHit>, StoreError> {
    let overfetch = (4 * limit).max(20) as u32;
    let mut lists = Vec::new();
    if let Some((table, bytes)) = probe {
        // `table` comes from `vector_collections`, written from `vector_table_name` (integers
        // only) — never from the request.
        let nearest: Vec<u64> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT item_id FROM {table} ORDER BY VEC_DISTANCE_COSINE(embedding, ?) LIMIT ?"
        )))
        .bind(bytes)
        .bind(overfetch)
        .fetch_all(pool)
        .await
        .map_err(DbError::from)?;
        lists.push(nearest);
    }
    let matched: Vec<u64> = sqlx::query_scalar(
        "SELECT id FROM chunks WHERE MATCH(text) AGAINST (? IN NATURAL LANGUAGE MODE)
         ORDER BY MATCH(text) AGAINST (? IN NATURAL LANGUAGE MODE) DESC, id LIMIT ?",
    )
    .bind(query)
    .bind(query)
    .bind(overfetch)
    .fetch_all(pool)
    .await
    .map_err(DbError::from)?;
    lists.push(matched);

    let ranked = fuse(&lists, limit);
    if ranked.is_empty() {
        return Ok(Vec::new());
    }
    let mut builder = QueryBuilder::new(
        "SELECT c.id, c.document_id, c.locator, c.text, d.folder, d.title, d.source
         FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id IN (",
    );
    let mut ids = builder.separated(", ");
    for (id, _) in &ranked {
        ids.push_bind(*id);
    }
    builder.push(")");
    let rows: Vec<HitRow> = builder
        .build_query_as()
        .fetch_all(pool)
        .await
        .map_err(DbError::from)?;
    Ok(ranked
        .into_iter()
        .filter_map(|(id, score)| {
            let (chunk_id, document_id, locator, text, folder, title, source) =
                rows.iter().find(|row| row.0 == id)?.clone();
            Some(SearchHit {
                chunk_id,
                document_id,
                folder,
                title,
                source,
                locator,
                text,
                score,
            })
        })
        .collect())
}

/// The vector table to search and the model id it holds, when the active chunks collection is
/// `model`'s; None when no model is active or another one is.
pub async fn active_table_for(
    pool: &MySqlPool,
    model: &memory::EmbeddingModel,
) -> Result<Option<String>, StoreError> {
    let model_id = memory::register_model(pool, model).await?;
    Ok(memory::active_collection(pool, Collection::Chunks)
        .await?
        .filter(|collection| collection.model_id == model_id)
        .map(|collection| collection.table_name))
}

#[cfg(test)]
mod tests {
    use super::fuse;

    #[test]
    fn fusion_puts_what_both_lists_rank_high_first_and_scales_to_one() {
        let fused = fuse(&[vec![7, 8, 9], vec![8, 1, 7]], 3);
        assert_eq!(
            fused.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            [8, 7, 1]
        );
        assert!(fused.iter().all(|(_, score)| (0.0..=1.0).contains(score)));
        assert_eq!(fuse(&[vec![5], vec![5]], 1), [(5, 1.0)]);
        assert!(fuse(&[vec![], vec![]], 5).is_empty());
    }
}
