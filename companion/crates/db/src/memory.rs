//! The model registry and the vector tables it creates (P4-T01, ADR-35).
//!
//! An embedding model's width is the user's choice, and a MariaDB `VECTOR(N)` column's
//! width is fixed when its table is created — with one vector index per table. So vectors
//! do not live on `turns`, `facts` or `chunks`; each collection gets a table per registered
//! model, `<prefix>_<model id>`, holding `item_id` and `embedding` and nothing else, its
//! foreign key cascading from the row it indexes. `vector_collections` says which one
//! retrieval reads.
//!
//! **Retrieval must put the nearest-neighbour search in a subquery** and join and filter
//! outside it (`self_check` proves the shape). Verified against 11.8.8 on 2026-09-27: a
//! join filtered by `character_id` with the `ORDER BY` distance outside drives from the
//! filter's index and computes every distance — right answers, no vector index, the
//! failure that looks like success (`docs/SURFACE.md`).
//!
//! Static-table statements are `query!` macros checked against the schema at build time
//! from the committed `.sqlx` cache (ADR-35); the vector tables' names are only known at
//! run time, so their statements are built here from integers and never from user text.

use sqlx::mysql::MySqlPool;
use sqlx::{AssertSqlSafe, Row};

use crate::DbError;
use crate::vector;

/// MariaDB's limit for `VECTOR(N)`.
pub const MAX_DIMENSIONS: u16 = 16_383;

/// The things that carry embeddings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Collection {
    Turns,
    Facts,
    Chunks,
}

impl Collection {
    pub const ALL: [Collection; 3] = [Collection::Turns, Collection::Facts, Collection::Chunks];

    /// The `vector_collections.collection` value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turns => "turns",
            Self::Facts => "facts",
            Self::Chunks => "chunks",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|collection| collection.as_str() == value)
    }

    /// The table whose rows the vectors belong to.
    pub fn item_table(self) -> &'static str {
        self.as_str()
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Turns => "turn_embeddings",
            Self::Facts => "fact_embeddings",
            Self::Chunks => "chunk_embeddings",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollectionStatus {
    /// Being filled: a new model's re-index. Retrieval does not read it.
    Building,
    /// The one retrieval reads for its collection.
    Active,
    /// Replaced; kept until someone drops it.
    Retired,
}

impl CollectionStatus {
    fn parse(value: &str) -> Result<Self, DbError> {
        match value {
            "building" => Ok(Self::Building),
            "active" => Ok(Self::Active),
            "retired" => Ok(Self::Retired),
            other => Err(DbError::Backend(format!(
                "unknown vector collection status {other:?}"
            ))),
        }
    }
}

/// An embedding model, as the user configured it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbeddingModel {
    /// Where it runs: an endpoint preset (`ollama`, `openai`, …) or `browser`.
    pub provider: String,
    pub model: String,
    pub dimensions: u16,
}

impl EmbeddingModel {
    /// Checked before any statement, so a bad model is a message about the model.
    pub fn validate(&self) -> Result<(), DbError> {
        if self.provider.trim().is_empty() || self.provider.len() > 128 {
            return Err(DbError::Invalid(
                "an embedding model's provider must be 1-128 characters".into(),
            ));
        }
        if self.model.trim().is_empty() || self.model.len() > 255 {
            return Err(DbError::Invalid(
                "an embedding model's name must be 1-255 characters".into(),
            ));
        }
        if self.dimensions == 0 || self.dimensions > MAX_DIMENSIONS {
            return Err(DbError::Invalid(format!(
                "an embedding model has 1-{MAX_DIMENSIONS} dimensions, not {}",
                self.dimensions
            )));
        }
        Ok(())
    }
}

/// A collection's vectors from one model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VectorCollection {
    pub id: u32,
    pub collection: Collection,
    pub model_id: u32,
    pub dimensions: u16,
    pub table_name: String,
    pub status: CollectionStatus,
}

/// `<prefix>_<model id>`: from integers only, so it is safe to put in a statement.
pub fn vector_table_name(collection: Collection, model_id: u32) -> String {
    format!("{}_{model_id}", collection.prefix())
}

/// The vector table for a collection and a model. `IF NOT EXISTS`, so registering twice is
/// harmless. `M=8` and `DISTANCE=cosine` as P0-T06 measured them; every query against it
/// must use `VEC_DISTANCE_COSINE` or it scans (`bench.rs`).
pub fn vector_table_ddl(collection: Collection, model_id: u32, dimensions: u16) -> String {
    let name = vector_table_name(collection, model_id);
    format!(
        "CREATE TABLE IF NOT EXISTS {name} (\n  \
           item_id   BIGINT UNSIGNED NOT NULL PRIMARY KEY,\n  \
           embedding VECTOR({dimensions}) NOT NULL,\n  \
           VECTOR INDEX (embedding) M=8 DISTANCE=cosine,\n  \
           CONSTRAINT {name}_item FOREIGN KEY (item_id) REFERENCES {item} (id) ON DELETE CASCADE\n\
         ) ENGINE=InnoDB",
        item = collection.item_table(),
    )
}

fn narrow_id(id: u64) -> Result<u32, DbError> {
    u32::try_from(id).map_err(|_| DbError::Backend(format!("id {id} is out of range")))
}

/// Register an embedding model, or find it if it is already registered. Returns its id.
pub async fn register_model(pool: &MySqlPool, model: &EmbeddingModel) -> Result<u32, DbError> {
    model.validate()?;
    // `LAST_INSERT_ID(id)` on the duplicate path makes the existing row's id the result, so
    // one statement answers both cases.
    let result = sqlx::query!(
        "INSERT INTO model_registry (purpose, provider, model, dimensions, created_at)
         VALUES ('embedding', ?, ?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
        model.provider,
        model.model,
        model.dimensions,
    )
    .execute(pool)
    .await?;
    narrow_id(result.last_insert_id())
}

/// Create a collection's vector table for a registered model, if it does not exist, and
/// record it as `building` if it is new. Returns it as it now stands.
pub async fn ensure_collection(
    pool: &MySqlPool,
    collection: Collection,
    model_id: u32,
) -> Result<VectorCollection, DbError> {
    let model = sqlx::query!(
        "SELECT dimensions FROM model_registry WHERE id = ?",
        model_id
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| DbError::Invalid(format!("no embedding model with id {model_id}")))?;

    let ddl = vector_table_ddl(collection, model_id, model.dimensions);
    sqlx::raw_sql(AssertSqlSafe(ddl)).execute(pool).await?;

    let table_name = vector_table_name(collection, model_id);
    sqlx::query!(
        "INSERT INTO vector_collections (collection, model_id, table_name, created_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE id = id",
        collection.as_str(),
        model_id,
        table_name,
    )
    .execute(pool)
    .await?;

    collection_for(pool, collection, model_id)
        .await?
        .ok_or_else(|| DbError::Backend(format!("{table_name} was not recorded")))
}

/// A collection's vectors from one model, if recorded.
pub async fn collection_for(
    pool: &MySqlPool,
    collection: Collection,
    model_id: u32,
) -> Result<Option<VectorCollection>, DbError> {
    let row = sqlx::query!(
        "SELECT c.id, c.table_name, c.status, m.dimensions
         FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE c.collection = ? AND c.model_id = ?",
        collection.as_str(),
        model_id,
    )
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok(VectorCollection {
            id: row.id,
            collection,
            model_id,
            dimensions: row.dimensions,
            table_name: row.table_name,
            status: CollectionStatus::parse(&row.status)?,
        })
    })
    .transpose()
}

/// The collection retrieval reads, if one is active.
pub async fn active_collection(
    pool: &MySqlPool,
    collection: Collection,
) -> Result<Option<VectorCollection>, DbError> {
    let row = sqlx::query!(
        "SELECT c.id, c.model_id, c.table_name, c.status, m.dimensions
         FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE c.collection = ? AND c.status = 'active'",
        collection.as_str(),
    )
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok(VectorCollection {
            id: row.id,
            collection,
            model_id: row.model_id,
            dimensions: row.dimensions,
            table_name: row.table_name,
            status: CollectionStatus::parse(&row.status)?,
        })
    })
    .transpose()
}

/// Make a model's table the one retrieval reads for its collection, retiring whichever was.
/// One transaction, so there is never a moment with two active or none.
pub async fn activate_collection(
    pool: &MySqlPool,
    collection: Collection,
    model_id: u32,
) -> Result<(), DbError> {
    if collection_for(pool, collection, model_id).await?.is_none() {
        return Err(DbError::Invalid(format!(
            "{} has no vector table for model {model_id}",
            collection.as_str()
        )));
    }
    let mut tx = pool.begin().await?;
    sqlx::query!(
        "UPDATE vector_collections SET status = 'retired'
         WHERE collection = ? AND status = 'active' AND model_id <> ?",
        collection.as_str(),
        model_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        "UPDATE vector_collections SET status = 'active' WHERE collection = ? AND model_id = ?",
        collection.as_str(),
        model_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Proves the schema on a live server, leaving nothing behind: a throwaway model and its
/// `turns` table, a session with a turn and a vector, the retrieval shape using the vector
/// index, and a deleted session taking its turn and vector with it. What `memory-check`
/// runs, locally and in CI. Returns one line per step.
pub async fn self_check(pool: &MySqlPool) -> Result<Vec<String>, DbError> {
    let mut report = Vec::new();
    let model = EmbeddingModel {
        provider: "memory-check".into(),
        model: "four-wide".into(),
        dimensions: 4,
    };
    let model_id = register_model(pool, &model).await?;
    let again = register_model(pool, &model).await?;
    check(
        model_id == again,
        "registering a model twice returns the same id",
    )?;
    report.push(format!("model registered as {model_id}, idempotent"));

    let built = ensure_collection(pool, Collection::Turns, model_id).await?;
    check(
        built.dimensions == 4,
        "the collection carries the model's width",
    )?;
    let table = built.table_name.clone();
    report.push(format!("{table} created ({:?})", built.status));

    let outcome = exercise(pool, &table).await;
    // Cleanup runs whatever the exercise found, and in dependency order.
    let cleanup = async {
        sqlx::query("DELETE FROM sessions WHERE character_id = 'memory-check'")
            .execute(pool)
            .await?;
        sqlx::raw_sql(AssertSqlSafe(format!("DROP TABLE IF EXISTS {table}")))
            .execute(pool)
            .await?;
        sqlx::query!(
            "DELETE FROM vector_collections WHERE model_id = ?",
            model_id
        )
        .execute(pool)
        .await?;
        sqlx::query!("DELETE FROM model_registry WHERE id = ?", model_id)
            .execute(pool)
            .await?;
        Ok::<_, DbError>(())
    };
    let cleaned = cleanup.await;
    report.extend(outcome?);
    cleaned?;
    report.push("cleaned up".into());
    Ok(report)
}

fn check(condition: bool, what: &str) -> Result<(), DbError> {
    if condition {
        Ok(())
    } else {
        Err(DbError::Backend(format!("self-check failed: {what}")))
    }
}

async fn exercise(pool: &MySqlPool, table: &str) -> Result<Vec<String>, DbError> {
    let mut report = Vec::new();
    let session = sqlx::query(
        "INSERT INTO sessions (uid, character_id, started_at) VALUES ('memory-check-session', 'memory-check', UTC_TIMESTAMP(3))",
    )
    .execute(pool)
    .await?
    .last_insert_id();
    let mut turn_ids = Vec::new();
    for (seq, embedding) in [
        [1.0f32, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.7, 0.7, 0.0, 0.0],
    ]
    .iter()
    .enumerate()
    {
        let turn = sqlx::query(
            "INSERT INTO turns (uid, session_id, character_id, seq, role, text, created_at)
             VALUES (?, ?, 'memory-check', ?, 'user', ?, UTC_TIMESTAMP(3))",
        )
        .bind(format!("memory-check-turn-{seq}"))
        .bind(session)
        .bind(seq as u32)
        .bind(format!("turn {seq}"))
        .execute(pool)
        .await?
        .last_insert_id();
        let bytes = vector::encode_width(embedding, 4)?;
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO {table} (item_id, embedding) VALUES (?, ?)"
        )))
        .bind(turn)
        .bind(&bytes[..])
        .execute(pool)
        .await?;
        turn_ids.push(turn);
    }
    report.push(format!(
        "session {session} with {} turns and vectors",
        turn_ids.len()
    ));

    // The retrieval shape ADR-35 requires: nearest first in a subquery, then join and filter.
    let probe = vector::encode_width(&[1.0, 0.1, 0.0, 0.0], 4)?;
    let nearest = format!(
        "SELECT t.id, k.d FROM (
           SELECT item_id, VEC_DISTANCE_COSINE(embedding, ?) AS d FROM {table} ORDER BY d LIMIT 16
         ) k JOIN turns t ON t.id = k.item_id
         WHERE t.character_id = 'memory-check' ORDER BY k.d LIMIT 2"
    );
    let rows = sqlx::query(AssertSqlSafe(nearest.clone()))
        .bind(&probe[..])
        .fetch_all(pool)
        .await?;
    let found: Vec<u64> = rows
        .iter()
        .map(|row| row.try_get("id"))
        .collect::<Result<_, _>>()?;
    check(
        found == [turn_ids[0], turn_ids[2]],
        "the nearest turns come back nearest first",
    )?;
    let plan = sqlx::query(AssertSqlSafe(format!("EXPLAIN {nearest}")))
        .bind(&probe[..])
        .fetch_all(pool)
        .await?;
    let uses_index = plan.iter().any(|row| {
        let table_of: Option<String> = row.try_get("table").ok().flatten();
        let key: Option<String> = row.try_get("key").ok().flatten();
        table_of.as_deref() == Some(table) && key.as_deref() == Some("embedding")
    });
    check(uses_index, "the retrieval shape uses the vector index")?;
    report.push("nearest-first retrieval uses the vector index".into());

    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(session)
        .execute(pool)
        .await?;
    let left: i64 = sqlx::query(AssertSqlSafe(format!("SELECT COUNT(*) AS n FROM {table}")))
        .fetch_one(pool)
        .await?
        .try_get("n")?;
    check(left == 0, "deleting a session removes its turns' vectors")?;
    report.push("deleting the session removed its turns and their vectors".into());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_tables_are_named_from_integers() {
        assert_eq!(vector_table_name(Collection::Turns, 3), "turn_embeddings_3");
        assert_eq!(
            vector_table_name(Collection::Facts, 12),
            "fact_embeddings_12"
        );
        assert_eq!(
            vector_table_name(Collection::Chunks, u32::MAX),
            "chunk_embeddings_4294967295"
        );
        // MariaDB's identifier limit is 64, and the constraint name is the longest one.
        assert!(format!("{}_item", vector_table_name(Collection::Chunks, u32::MAX)).len() <= 64);
    }

    #[test]
    fn the_ddl_carries_the_width_the_index_and_the_cascade() {
        let ddl = vector_table_ddl(Collection::Facts, 7, 1024);
        assert!(
            ddl.starts_with("CREATE TABLE IF NOT EXISTS fact_embeddings_7 ("),
            "{ddl}"
        );
        assert!(ddl.contains("embedding VECTOR(1024) NOT NULL"), "{ddl}");
        assert!(ddl.contains("DISTANCE=cosine"), "{ddl}");
        assert!(
            ddl.contains("REFERENCES facts (id) ON DELETE CASCADE"),
            "{ddl}"
        );
    }

    #[test]
    fn a_model_is_checked_before_it_reaches_the_server() {
        let ok = EmbeddingModel {
            provider: "ollama".into(),
            model: "nomic-embed-text".into(),
            dimensions: 768,
        };
        assert!(ok.validate().is_ok());
        for bad in [
            EmbeddingModel {
                dimensions: 0,
                ..ok.clone()
            },
            EmbeddingModel {
                dimensions: MAX_DIMENSIONS + 1,
                ..ok.clone()
            },
            EmbeddingModel {
                model: " ".into(),
                ..ok.clone()
            },
            EmbeddingModel {
                provider: "x".repeat(129),
                ..ok.clone()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn collections_round_trip_through_their_names() {
        for collection in Collection::ALL {
            assert_eq!(Collection::parse(collection.as_str()), Some(collection));
        }
        assert_eq!(Collection::parse("documents"), None);
    }
}
