//! The memory kernel's store (P4-T02, ADR-36): sessions, episodes, facts, self-model
//! blocks, plans, and the one-statement retrieval ADR-17 asks for.
//!
//! Static-table SQL uses `sqlx::query!`/`query_scalar!` (ADR-35), checked at build time
//! against the committed `.sqlx` cache. The vector tables and the retrieval `UNION ALL` are
//! built as strings — never from a request value, only from `memory::vector_table_name`,
//! which takes only integers — and run through `AssertSqlSafe`, as `memory::self_check` does.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::NaiveDateTime;
use sqlx::mysql::MySqlPool;
use sqlx::{AssertSqlSafe, Row};

use crate::memory::{self, Collection, CollectionStatus, EmbeddingModel};
use crate::vector;
use crate::{DbError, time as time_util};

/// Every error a route needs to tell apart. `Db` covers everything the underlying store
/// itself flags as backend, vector-shape or invalid-model trouble; the other three are the
/// contract's own vocabulary (`CompanionErrorSchema.error.code`).
#[derive(Debug)]
pub enum StoreError {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    Db(DbError),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(message) => write!(f, "{message}"),
            Self::NotFound(message) => write!(f, "{message}"),
            Self::Conflict(message) => write!(f, "{message}"),
            Self::Db(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<DbError> for StoreError {
    fn from(error: DbError) -> Self {
        Self::Db(error)
    }
}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(DbError::from(error))
    }
}

impl From<vector::VectorError> for StoreError {
    fn from(error: vector::VectorError) -> Self {
        Self::Db(DbError::from(error))
    }
}

/// A vector and the model that made it (ADR-36's `EmbeddingSchema`).
#[derive(Debug, Clone)]
pub struct Embedding {
    pub model: EmbeddingModel,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }

    pub fn parse(value: &str) -> Result<Self, DbError> {
        match value {
            "user" => Ok(Self::User),
            "assistant" => Ok(Self::Assistant),
            other => Err(DbError::Backend(format!("unknown turn role {other:?}"))),
        }
    }
}

/// One turn (`MemoryEpisodeSchema`). `uid`/`session_uid` are the caller's ids (ADR-36 §1).
#[derive(Debug, Clone)]
pub struct Episode {
    pub uid: String,
    pub session_uid: String,
    pub character_id: String,
    pub role: Role,
    pub text: String,
    pub interrupted: bool,
    pub at: NaiveDateTime,
    pub embedding: Option<Embedding>,
    pub affect: Option<serde_json::Value>,
}

/// A bi-temporal fact (`SemanticFactSchema`).
#[derive(Debug, Clone)]
pub struct Fact {
    pub uid: String,
    pub character_id: String,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub confidence: f32,
    pub valid_from: Option<NaiveDateTime>,
    pub valid_to: Option<NaiveDateTime>,
    pub recorded_at: NaiveDateTime,
    pub source_episode_uid: Option<String>,
    pub embedding: Option<Embedding>,
}

/// A self-model block (`SelfModelBlockSchema`). `name`/`content` are the protocol's words
/// for the table's `label`/`value`.
#[derive(Debug, Clone)]
pub struct SelfBlock {
    pub character_id: String,
    pub name: String,
    pub content: String,
    pub updated_at: NaiveDateTime,
    pub editable_by_character: bool,
}

#[derive(Debug, Clone)]
pub struct PlanTask {
    pub uid: String,
    pub title: String,
    pub status: String,
    pub notes: String,
}

#[derive(Debug, Clone)]
pub struct PlanPhase {
    pub uid: String,
    pub title: String,
    pub tasks: Vec<PlanTask>,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub uid: String,
    pub character_id: String,
    pub title: String,
    pub goal: String,
    pub phases: Vec<PlanPhase>,
    pub status: String,
    pub version: u32,
    pub updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, Copy)]
pub struct RetrievalLimits {
    pub episodes: u32,
    pub facts: u32,
    pub documents: u32,
}

#[derive(Debug, Clone)]
pub struct RetrievalRequest {
    pub character_id: String,
    pub session_id: String,
    pub query: String,
    pub query_embedding: Option<Embedding>,
    pub limits: RetrievalLimits,
    pub since: Option<NaiveDateTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VectorSearch {
    Used,
    NoQueryEmbedding,
    NoActiveModel,
    OtherModel,
}

impl VectorSearch {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Used => "used",
            Self::NoQueryEmbedding => "no-query-embedding",
            Self::NoActiveModel => "no-active-model",
            Self::OtherModel => "other-model",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RetrievalBundle {
    pub episodes: Vec<Episode>,
    pub facts: Vec<Fact>,
    pub blocks: Vec<SelfBlock>,
    /// `[]` until P5.
    pub documents: Vec<serde_json::Value>,
    pub vector_search: VectorSearch,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------------------
// Embedding models and collections
// ---------------------------------------------------------------------------------------

/// Clears the registry cache when dropped — after the change, however the function exits,
/// so a failure halfway through a registration cannot leave a stale answer behind.
struct Invalidate<'a>(&'a Registry);

impl Drop for Invalidate<'_> {
    fn drop(&mut self) {
        self.0.invalidate();
    }
}

/// `dbRegisterEmbeddingModel`: register, then ensure all three collections for it, then
/// activate any collection that had no active model at all.
pub async fn register_embedding_model(
    pool: &MySqlPool,
    registry: &Registry,
    model: &EmbeddingModel,
) -> Result<(u32, Vec<(Collection, CollectionStatus)>), StoreError> {
    let model_id = memory::register_model(pool, model).await?;
    let _clear = Invalidate(registry);
    let mut statuses = Vec::with_capacity(Collection::ALL.len());
    for collection in Collection::ALL {
        memory::ensure_collection(pool, collection, model_id).await?;
        if memory::active_collection(pool, collection).await?.is_none() {
            memory::activate_collection(pool, collection, model_id).await?;
        }
        let current = memory::collection_for(pool, collection, model_id)
            .await?
            .ok_or_else(|| DbError::Backend(format!("{collection:?} lost its collection")))?;
        statuses.push((collection, current.status));
    }
    Ok((model_id, statuses))
}

/// `dbActivateCollection`: register (idempotent), then switch. `NotFound` if the
/// collection has no table for this model — `memory::activate_collection` already
/// distinguishes that case in its message.
pub async fn activate_collection(
    pool: &MySqlPool,
    registry: &Registry,
    collection: Collection,
    model: &EmbeddingModel,
) -> Result<(), StoreError> {
    let model_id = memory::register_model(pool, model).await?;
    let _clear = Invalidate(registry);
    memory::activate_collection(pool, collection, model_id)
        .await
        .map_err(|error| match &error {
            DbError::Invalid(message) if message.contains("no vector table") => {
                StoreError::NotFound(message.clone())
            }
            _ => StoreError::Db(error),
        })
}

/// A collection's active model, as retrieval needs it.
#[derive(Debug, Clone)]
struct ActiveModel {
    model: EmbeddingModel,
    table_name: String,
}

/// How long the active models are trusted without asking the database again.
pub const REGISTRY_TTL: Duration = Duration::from_secs(5);

/// **Which model is active for each collection, held in the companion** so retrieval stays
/// one round trip (ADR-17): without it every `retrieve` asked the registry first, three
/// statements before the one that mattered — 120 ms over the 40 ms tunnel. The companion is
/// the registry's only writer, and every write here (`register_embedding_model`,
/// `activate_collection`, a first embedding) clears it; the TTL covers anything else that
/// touches the tables (a second companion, a hand edit), at one extra query per `REGISTRY_TTL`.
#[derive(Debug, Default)]
pub struct Registry {
    cached: Mutex<Option<(Instant, HashMap<&'static str, ActiveModel>)>>,
}

impl Registry {
    pub fn invalidate(&self) {
        *self
            .cached
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    async fn active(
        &self,
        pool: &MySqlPool,
    ) -> Result<HashMap<&'static str, ActiveModel>, DbError> {
        if let Some((at, active)) = self
            .cached
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            && at.elapsed() < REGISTRY_TTL
        {
            return Ok(active.clone());
        }
        let rows = sqlx::query!(
            "SELECT c.collection, c.table_name, m.provider, m.model, m.dimensions
             FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
             WHERE c.status = 'active'"
        )
        .fetch_all(pool)
        .await?;
        let mut active = HashMap::new();
        for row in rows {
            let Some(collection) = Collection::parse(&row.collection) else {
                continue;
            };
            active.insert(
                collection.as_str(),
                ActiveModel {
                    model: EmbeddingModel {
                        provider: row.provider,
                        model: row.model,
                        dimensions: row.dimensions,
                    },
                    table_name: row.table_name,
                },
            );
        }
        *self
            .cached
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((Instant::now(), active.clone()));
        Ok(active)
    }
}

/// Register the model if needed, ensure the collection exists, activate it if the
/// collection has no active model yet, then upsert the vector.
async fn embed_item(
    pool: &MySqlPool,
    registry: &Registry,
    collection: Collection,
    item_id: u64,
    embedding: &Embedding,
) -> Result<(), StoreError> {
    let model_id = memory::register_model(pool, &embedding.model).await?;
    memory::ensure_collection(pool, collection, model_id).await?;
    if memory::active_collection(pool, collection).await?.is_none() {
        memory::activate_collection(pool, collection, model_id).await?;
        registry.invalidate();
    }
    let bytes = vector::encode_width(&embedding.vector, embedding.model.dimensions as usize)?;
    let table = memory::vector_table_name(collection, model_id);
    sqlx::query(AssertSqlSafe(format!(
        "INSERT INTO {table} (item_id, embedding) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE embedding = VALUES(embedding)"
    )))
    .bind(item_id)
    .bind(&bytes[..])
    .execute(pool)
    .await
    .map_err(DbError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------------------

/// `dbAppendEpisode`: upsert the session, insert the turn if its uid is new (idempotent
/// otherwise), then the embedding if one was sent.
pub async fn append_episode(
    pool: &MySqlPool,
    registry: &Registry,
    episode: &Episode,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(DbError::from)?;

    sqlx::query!(
        "INSERT INTO sessions (uid, character_id, started_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id",
        episode.session_uid,
        episode.character_id,
        episode.at,
    )
    .execute(&mut *tx)
    .await
    .map_err(DbError::from)?;
    // The kernel fires writes without waiting (ADR-17), so a user turn and the answer to it
    // can arrive together; appends to one session must be serialised so two cannot read the
    // same `MAX(seq)` or both insert one uid. The upsert above already does it — InnoDB takes
    // an exclusive lock on the duplicate row, new or existing — and a test of twelve at once
    // passes without this `FOR UPDATE` (checked 2026-09-28). It is here to say so in the SQL.
    let session_id: u64 = sqlx::query_scalar!(
        "SELECT id FROM sessions WHERE uid = ? FOR UPDATE",
        episode.session_uid
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(DbError::from)?;

    let existing: Option<u64> =
        sqlx::query_scalar!("SELECT id FROM turns WHERE uid = ?", episode.uid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(DbError::from)?;

    let turn_id = if let Some(id) = existing {
        id
    } else {
        let max_seq: Option<u32> = sqlx::query_scalar!(
            "SELECT MAX(seq) FROM turns WHERE session_id = ?",
            session_id
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(DbError::from)?;
        let next_seq = max_seq.map(|seq| seq + 1).unwrap_or(0);
        let role = episode.role.as_str();
        let affect_json = episode
            .affect
            .as_ref()
            .map(std::string::ToString::to_string);

        sqlx::query!(
            "INSERT INTO turns (uid, session_id, character_id, seq, role, text, interrupted, user_affect, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            episode.uid,
            session_id,
            episode.character_id,
            next_seq,
            role,
            episode.text,
            episode.interrupted,
            affect_json,
            episode.at,
        )
        .execute(&mut *tx)
        .await
        .map_err(DbError::from)?;

        sqlx::query_scalar!("SELECT id FROM turns WHERE uid = ?", episode.uid)
            .fetch_one(&mut *tx)
            .await
            .map_err(DbError::from)?
    };

    tx.commit().await.map_err(DbError::from)?;

    if let Some(embedding) = &episode.embedding {
        embed_item(pool, registry, Collection::Turns, turn_id, embedding).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------

/// `dbUpsertFact`: insert or update by uid; `sourceEpisodeId` resolves to `source_turn`,
/// `bad_request` if the episode is unknown.
pub async fn upsert_fact(
    pool: &MySqlPool,
    registry: &Registry,
    fact: &Fact,
) -> Result<(), StoreError> {
    let source_turn: Option<u64> = match &fact.source_episode_uid {
        Some(uid) => {
            let id: Option<u64> = sqlx::query_scalar!("SELECT id FROM turns WHERE uid = ?", uid)
                .fetch_optional(pool)
                .await
                .map_err(DbError::from)?;
            Some(id.ok_or_else(|| StoreError::BadRequest(format!("no episode with id {uid:?}")))?)
        }
        None => None,
    };

    let existing: Option<u64> = sqlx::query_scalar!("SELECT id FROM facts WHERE uid = ?", fact.uid)
        .fetch_optional(pool)
        .await
        .map_err(DbError::from)?;

    let fact_id = if let Some(id) = existing {
        sqlx::query!(
            "UPDATE facts SET character_id = ?, subject = ?, predicate = ?, object = ?,
               confidence = ?, valid_from = ?, valid_to = ?, recorded_at = ?, source_turn = ?
             WHERE id = ?",
            fact.character_id,
            fact.subject,
            fact.predicate,
            fact.object,
            fact.confidence,
            fact.valid_from,
            fact.valid_to,
            fact.recorded_at,
            source_turn,
            id,
        )
        .execute(pool)
        .await
        .map_err(DbError::from)?;
        id
    } else {
        sqlx::query!(
            "INSERT INTO facts (uid, character_id, subject, predicate, object, confidence,
               valid_from, valid_to, recorded_at, source_turn)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            fact.uid,
            fact.character_id,
            fact.subject,
            fact.predicate,
            fact.object,
            fact.confidence,
            fact.valid_from,
            fact.valid_to,
            fact.recorded_at,
            source_turn,
        )
        .execute(pool)
        .await
        .map_err(DbError::from)?;
        sqlx::query_scalar!("SELECT id FROM facts WHERE uid = ?", fact.uid)
            .fetch_one(pool)
            .await
            .map_err(DbError::from)?
    };

    if let Some(embedding) = &fact.embedding {
        embed_item(pool, registry, Collection::Facts, fact_id, embedding).await?;
    }
    Ok(())
}

/// `dbSupersedeFact`: close a fact's validity. Nothing is deleted; `not_found` if the uid
/// is unknown.
pub async fn supersede_fact(
    pool: &MySqlPool,
    uid: &str,
    valid_to: NaiveDateTime,
) -> Result<(), StoreError> {
    let result = sqlx::query!("UPDATE facts SET valid_to = ? WHERE uid = ?", valid_to, uid)
        .execute(pool)
        .await
        .map_err(DbError::from)?;
    if result.rows_affected() == 0 {
        return Err(StoreError::NotFound(format!("no fact with id {uid:?}")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Self-model blocks
// ---------------------------------------------------------------------------------------

/// `dbReadBlocks`: every block for a character, by label.
pub async fn read_blocks(
    pool: &MySqlPool,
    character_id: &str,
) -> Result<Vec<SelfBlock>, StoreError> {
    let rows = sqlx::query!(
        "SELECT character_id, label, value, updated_at, editable_by_character
         FROM self_blocks WHERE character_id = ? ORDER BY label",
        character_id,
    )
    .fetch_all(pool)
    .await
    .map_err(DbError::from)?;

    Ok(rows
        .into_iter()
        .map(|row| SelfBlock {
            character_id: row.character_id,
            name: row.label,
            content: row.value,
            updated_at: row.updated_at,
            editable_by_character: row.editable_by_character != 0,
        })
        .collect())
}

const DEFAULT_BLOCK_CHAR_LIMIT: u32 = 2000;

/// `dbWriteBlock`: upsert by (character_id, label). The table's own `CHECK` would refuse a
/// value over `char_limit`; this says so first, in words, as `bad_request`.
pub async fn write_block(pool: &MySqlPool, block: &SelfBlock) -> Result<(), StoreError> {
    let existing = sqlx::query!(
        "SELECT char_limit FROM self_blocks WHERE character_id = ? AND label = ?",
        block.character_id,
        block.name,
    )
    .fetch_optional(pool)
    .await
    .map_err(DbError::from)?;
    let limit = existing
        .map(|row| row.char_limit)
        .unwrap_or(DEFAULT_BLOCK_CHAR_LIMIT);

    let length = block.content.chars().count() as u32;
    if length > limit {
        return Err(StoreError::BadRequest(format!(
            "{:?} is {length} characters, over its {limit}-character limit",
            block.name
        )));
    }

    sqlx::query!(
        "INSERT INTO self_blocks (character_id, label, value, editable_by_character, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           value = VALUES(value),
           version = version + 1,
           editable_by_character = VALUES(editable_by_character),
           updated_at = VALUES(updated_at)",
        block.character_id,
        block.name,
        block.content,
        block.editable_by_character,
        block.updated_at,
    )
    .execute(pool)
    .await
    .map_err(DbError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------

/// `dbListPlans`: every plan for a character, newest first, with its phase/task tree.
pub async fn list_plans(pool: &MySqlPool, character_id: &str) -> Result<Vec<Plan>, StoreError> {
    let plans = sqlx::query!(
        "SELECT id, uid, character_id, title, goal, status, version, updated_at
         FROM plans WHERE character_id = ? ORDER BY updated_at DESC",
        character_id,
    )
    .fetch_all(pool)
    .await
    .map_err(DbError::from)?;

    let mut result = Vec::with_capacity(plans.len());
    for plan in plans {
        let phase_rows = sqlx::query!(
            "SELECT id, uid, title FROM plan_items
             WHERE plan_id = ? AND kind = 'phase' AND parent_id IS NULL ORDER BY position",
            plan.id,
        )
        .fetch_all(pool)
        .await
        .map_err(DbError::from)?;

        let mut phases = Vec::with_capacity(phase_rows.len());
        for phase in phase_rows {
            let task_rows = sqlx::query!(
                "SELECT uid, title, status, body FROM plan_items
                 WHERE plan_id = ? AND kind = 'task' AND parent_id = ? ORDER BY position",
                plan.id,
                phase.id,
            )
            .fetch_all(pool)
            .await
            .map_err(DbError::from)?;

            phases.push(PlanPhase {
                uid: phase.uid,
                title: phase.title,
                tasks: task_rows
                    .into_iter()
                    .map(|task| PlanTask {
                        uid: task.uid,
                        title: task.title,
                        status: task.status,
                        notes: task.body.unwrap_or_default(),
                    })
                    .collect(),
            });
        }

        result.push(Plan {
            uid: plan.uid,
            character_id: plan.character_id,
            title: plan.title,
            goal: plan.goal.unwrap_or_default(),
            phases,
            status: plan.status,
            version: plan.version,
            updated_at: plan.updated_at,
        });
    }
    Ok(result)
}

/// `dbSavePlan`: a new uid inserts at version 1; an existing one must arrive at
/// `stored + 1` or fails `conflict`. Items are replaced wholesale in one transaction.
pub async fn save_plan(pool: &MySqlPool, plan: &Plan) -> Result<(), StoreError> {
    let mut tx = pool.begin().await.map_err(DbError::from)?;

    struct Existing {
        id: u64,
        version: u32,
    }
    let existing = sqlx::query!("SELECT id, version FROM plans WHERE uid = ?", plan.uid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(DbError::from)?
        .map(|row| Existing {
            id: row.id,
            version: row.version,
        });

    let plan_id = match existing {
        None => {
            if plan.version != 1 {
                return Err(StoreError::Conflict(format!(
                    "a new plan must be saved at version 1, not {}",
                    plan.version
                )));
            }
            sqlx::query!(
                "INSERT INTO plans (uid, character_id, title, goal, status, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                plan.uid,
                plan.character_id,
                plan.title,
                plan.goal,
                plan.status,
                plan.version,
                plan.updated_at,
                plan.updated_at,
            )
            .execute(&mut *tx)
            .await
            .map_err(DbError::from)?;
            sqlx::query_scalar!("SELECT id FROM plans WHERE uid = ?", plan.uid)
                .fetch_one(&mut *tx)
                .await
                .map_err(DbError::from)?
        }
        Some(row) => {
            if plan.version != row.version + 1 {
                return Err(StoreError::Conflict(format!(
                    "saved at version {}; the request must be version {} to win, not {}",
                    row.version,
                    row.version + 1,
                    plan.version
                )));
            }
            sqlx::query!(
                "UPDATE plans SET title = ?, goal = ?, status = ?, version = ?, updated_at = ?
                 WHERE id = ?",
                plan.title,
                plan.goal,
                plan.status,
                plan.version,
                plan.updated_at,
                row.id,
            )
            .execute(&mut *tx)
            .await
            .map_err(DbError::from)?;
            sqlx::query!("DELETE FROM plan_items WHERE plan_id = ?", row.id)
                .execute(&mut *tx)
                .await
                .map_err(DbError::from)?;
            row.id
        }
    };

    for (position, phase) in plan.phases.iter().enumerate() {
        let position = position as u32;
        sqlx::query!(
            "INSERT INTO plan_items (uid, plan_id, parent_id, position, kind, title, status, updated_at)
             VALUES (?, ?, NULL, ?, 'phase', ?, 'todo', ?)",
            phase.uid,
            plan_id,
            position,
            phase.title,
            plan.updated_at,
        )
        .execute(&mut *tx)
        .await
        .map_err(DbError::from)?;
        let phase_id: u64 = sqlx::query_scalar!(
            "SELECT id FROM plan_items WHERE plan_id = ? AND uid = ?",
            plan_id,
            phase.uid,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(DbError::from)?;

        for (task_position, task) in phase.tasks.iter().enumerate() {
            let task_position = task_position as u32;
            sqlx::query!(
                "INSERT INTO plan_items (uid, plan_id, parent_id, position, kind, title, body, status, updated_at)
                 VALUES (?, ?, ?, ?, 'task', ?, ?, ?, ?)",
                task.uid,
                plan_id,
                phase_id,
                task_position,
                task.title,
                task.notes,
                task.status,
                plan.updated_at,
            )
            .execute(&mut *tx)
            .await
            .map_err(DbError::from)?;
        }
    }

    tx.commit().await.map_err(DbError::from)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Retrieval — one statement (ADR-17)
// ---------------------------------------------------------------------------------------

/// A bind value for the dynamic retrieval statement. Every request value travels this way
/// — never formatted into the SQL text, which carries only literals and vector table names
/// (`memory::vector_table_name`, built from integers).
#[derive(Debug, Clone, PartialEq)]
pub enum Bind {
    Str(String),
    U32(u32),
    Bytes(Vec<u8>),
    DateTime(NaiveDateTime),
}

/// What `build_retrieval_sql` needs to know: which branches apply, already resolved by the
/// caller (which model is active, whether it matches the query's).
#[derive(Debug, Clone)]
pub struct RetrievalPlan {
    pub character_id: String,
    pub session_id: String,
    pub query: String,
    pub since: Option<NaiveDateTime>,
    pub episodes_limit: u32,
    pub facts_limit: u32,
    /// `(vector table name, encoded probe)` when the episode branch may search vectors.
    pub episodes_vector: Option<(String, Vec<u8>)>,
    pub facts_vector: Option<(String, Vec<u8>)>,
}

fn json_object_episode() -> &'static str {
    "JSON_OBJECT('id', t.uid, 'sessionId', s.uid, 'characterId', t.character_id, \
     'role', t.role, 'text', t.text, 'interrupted', t.interrupted, 'at', t.created_at, \
     'affect', t.user_affect)"
}

fn json_object_fact() -> &'static str {
    "JSON_OBJECT('id', f.uid, 'characterId', f.character_id, 'subject', f.subject, \
     'predicate', f.predicate, 'object', f.object, 'confidence', f.confidence, \
     'validFrom', f.valid_from, 'validTo', f.valid_to, 'recordedAt', f.recorded_at, \
     'sourceEpisodeId', st.uid)"
}

/// Build the one `UNION ALL` statement, in branch priority order (`seq`), so the outer
/// `ORDER BY seq, rank` gives vector hits before keyword hits per kind, and nearest-first
/// within a vector branch, without depending on `UNION ALL`'s own (unspecified) ordering.
///
/// Pure and DB-free, so it is unit-tested directly: which branches appear for which
/// request, and that every request value is a bind rather than text in the SQL.
pub fn build_retrieval_sql(plan: &RetrievalPlan) -> (String, Vec<Bind>) {
    let mut branches: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    let has_query = !plan.query.trim().is_empty();

    if let Some((table, probe)) = &plan.episodes_vector {
        let overfetch = (4 * plan.episodes_limit).max(32);
        let mut branch = format!(
            "(SELECT 'episode' AS kind, k.d AS rank, {seq} AS seq, {body} AS body \
             FROM (SELECT item_id, VEC_DISTANCE_COSINE(embedding, ?) AS d FROM {table} \
                   ORDER BY d LIMIT ?) k \
             JOIN turns t ON t.id = k.item_id \
             JOIN sessions s ON s.id = t.session_id \
             WHERE t.character_id = ? AND s.uid <> ?",
            seq = branches.len(),
            body = json_object_episode(),
        );
        binds.push(Bind::Bytes(probe.clone()));
        binds.push(Bind::U32(overfetch));
        binds.push(Bind::Str(plan.character_id.clone()));
        binds.push(Bind::Str(plan.session_id.clone()));
        if let Some(since) = plan.since {
            branch.push_str(" AND t.created_at >= ?");
            binds.push(Bind::DateTime(since));
        }
        branch.push_str(" ORDER BY k.d LIMIT ?)");
        binds.push(Bind::U32(plan.episodes_limit));
        branches.push(branch);
    }

    if has_query {
        let mut branch = format!(
            "(SELECT 'episode' AS kind, -MATCH(t.text) AGAINST (? IN NATURAL LANGUAGE MODE) AS rank, \
               {seq} AS seq, {body} AS body \
             FROM turns t JOIN sessions s ON s.id = t.session_id \
             WHERE MATCH(t.text) AGAINST (? IN NATURAL LANGUAGE MODE) \
               AND t.character_id = ? AND s.uid <> ?",
            seq = branches.len(),
            body = json_object_episode(),
        );
        binds.push(Bind::Str(plan.query.clone()));
        binds.push(Bind::Str(plan.query.clone()));
        binds.push(Bind::Str(plan.character_id.clone()));
        binds.push(Bind::Str(plan.session_id.clone()));
        if let Some(since) = plan.since {
            branch.push_str(" AND t.created_at >= ?");
            binds.push(Bind::DateTime(since));
        }
        branch.push_str(" ORDER BY rank LIMIT ?)");
        binds.push(Bind::U32(plan.episodes_limit));
        branches.push(branch);
    }

    if let Some((table, probe)) = &plan.facts_vector {
        let overfetch = (4 * plan.facts_limit).max(32);
        let branch = format!(
            "(SELECT 'fact' AS kind, k.d AS rank, {seq} AS seq, {body} AS body \
             FROM (SELECT item_id, VEC_DISTANCE_COSINE(embedding, ?) AS d FROM {table} \
                   ORDER BY d LIMIT ?) k \
             JOIN facts f ON f.id = k.item_id \
             LEFT JOIN turns st ON st.id = f.source_turn \
             WHERE f.character_id = ? AND f.expired_at IS NULL \
               AND (f.valid_to IS NULL OR f.valid_to > UTC_TIMESTAMP(3)) \
             ORDER BY k.d LIMIT ?)",
            seq = branches.len(),
            body = json_object_fact(),
        );
        binds.push(Bind::Bytes(probe.clone()));
        binds.push(Bind::U32(overfetch));
        binds.push(Bind::Str(plan.character_id.clone()));
        binds.push(Bind::U32(plan.facts_limit));
        branches.push(branch);
    }

    if has_query {
        let branch = format!(
            "(SELECT 'fact' AS kind, \
               -MATCH(f.subject, f.predicate, f.object) AGAINST (? IN NATURAL LANGUAGE MODE) AS rank, \
               {seq} AS seq, {body} AS body \
             FROM facts f LEFT JOIN turns st ON st.id = f.source_turn \
             WHERE MATCH(f.subject, f.predicate, f.object) AGAINST (? IN NATURAL LANGUAGE MODE) \
               AND f.character_id = ? AND f.expired_at IS NULL \
               AND (f.valid_to IS NULL OR f.valid_to > UTC_TIMESTAMP(3)) \
             ORDER BY rank LIMIT ?)",
            seq = branches.len(),
            body = json_object_fact(),
        );
        binds.push(Bind::Str(plan.query.clone()));
        binds.push(Bind::Str(plan.query.clone()));
        binds.push(Bind::Str(plan.character_id.clone()));
        binds.push(Bind::U32(plan.facts_limit));
        branches.push(branch);
    }

    branches.push(format!(
        "(SELECT 'block' AS kind, 0 AS rank, {seq} AS seq, \
          JSON_OBJECT('characterId', character_id, 'name', label, 'content', value, \
                      'updatedAt', updated_at, 'editableByCharacter', editable_by_character) AS body \
         FROM self_blocks WHERE character_id = ?)",
        seq = branches.len(),
    ));
    binds.push(Bind::Str(plan.character_id.clone()));

    let sql = format!(
        "SELECT kind, rank, body FROM ({}) retrieval_union ORDER BY seq, rank",
        branches.join(" UNION ALL ")
    );
    (sql, binds)
}

fn json_str(value: &serde_json::Value, field: &str) -> Result<String, DbError> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| DbError::Backend(format!("retrieval row missing string {field:?}")))
}

fn json_opt_str(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn json_bool(value: &serde_json::Value, field: &str) -> bool {
    match value.get(field) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => false,
    }
}

fn json_f32(value: &serde_json::Value, field: &str) -> f32 {
    value
        .get(field)
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0) as f32
}

/// A `DATETIME(3)` as MariaDB's JSON functions render it: `"YYYY-MM-DD HH:MM:SS[.fff…]"`,
/// space-separated, no offset. Distinct from the protocol's own ISO-8601 (`time::parse_timestamp`).
fn json_datetime(value: &serde_json::Value, field: &str) -> Result<NaiveDateTime, DbError> {
    let raw = json_str(value, field)?;
    time_util::parse_sql_datetime(&raw)
}

fn json_opt_datetime(
    value: &serde_json::Value,
    field: &str,
) -> Result<Option<NaiveDateTime>, DbError> {
    match value.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(raw)) => Ok(Some(time_util::parse_sql_datetime(raw)?)),
        _ => Err(DbError::Backend(format!(
            "retrieval row's {field:?} is not a datetime"
        ))),
    }
}

fn parse_episode(body: &serde_json::Value) -> Result<Episode, DbError> {
    Ok(Episode {
        uid: json_str(body, "id")?,
        session_uid: json_str(body, "sessionId")?,
        character_id: json_str(body, "characterId")?,
        role: Role::parse(&json_str(body, "role")?)?,
        text: json_str(body, "text")?,
        interrupted: json_bool(body, "interrupted"),
        at: json_datetime(body, "at")?,
        embedding: None,
        affect: body.get("affect").filter(|v| !v.is_null()).cloned(),
    })
}

fn parse_fact(body: &serde_json::Value) -> Result<Fact, DbError> {
    Ok(Fact {
        uid: json_str(body, "id")?,
        character_id: json_str(body, "characterId")?,
        subject: json_str(body, "subject")?,
        predicate: json_str(body, "predicate")?,
        object: json_str(body, "object")?,
        confidence: json_f32(body, "confidence"),
        valid_from: json_opt_datetime(body, "validFrom")?,
        valid_to: json_opt_datetime(body, "validTo")?,
        recorded_at: json_datetime(body, "recordedAt")?,
        source_episode_uid: json_opt_str(body, "sourceEpisodeId"),
        embedding: None,
    })
}

fn parse_block(body: &serde_json::Value) -> Result<SelfBlock, DbError> {
    Ok(SelfBlock {
        character_id: json_str(body, "characterId")?,
        name: json_str(body, "name")?,
        content: json_str(body, "content")?,
        updated_at: json_datetime(body, "updatedAt")?,
        editable_by_character: json_bool(body, "editableByCharacter"),
    })
}

/// `dbRetrieve`: one round trip (ADR-17), the shape ADR-35 requires — nearest-first in a
/// derived table, joined and filtered outside.
pub async fn retrieve(
    pool: &MySqlPool,
    registry: &Registry,
    request: &RetrievalRequest,
) -> Result<RetrievalBundle, StoreError> {
    let started = Instant::now();

    let mut vector_search = VectorSearch::NoQueryEmbedding;
    let mut episodes_vector = None;
    let mut facts_vector = None;

    if let Some(query_embedding) = &request.query_embedding {
        let probe = vector::encode_width(
            &query_embedding.vector,
            query_embedding.model.dimensions as usize,
        )?;
        // From the cache: no statement before the one that retrieves (`Registry`).
        let active = registry.active(pool).await?;
        let turns_active = active.get(Collection::Turns.as_str());
        let facts_active = active.get(Collection::Facts.as_str());

        vector_search = match turns_active {
            None => VectorSearch::NoActiveModel,
            Some(turns) if turns.model == query_embedding.model => VectorSearch::Used,
            Some(_) => VectorSearch::OtherModel,
        };

        if let Some(turns) = turns_active
            && vector_search == VectorSearch::Used
        {
            episodes_vector = Some((turns.table_name.clone(), probe.clone()));
            if let Some(facts) = facts_active
                && facts.model == query_embedding.model
            {
                facts_vector = Some((facts.table_name.clone(), probe));
            }
        }
    }

    let plan = RetrievalPlan {
        character_id: request.character_id.clone(),
        session_id: request.session_id.clone(),
        query: request.query.clone(),
        since: request.since,
        episodes_limit: request.limits.episodes,
        facts_limit: request.limits.facts,
        episodes_vector,
        facts_vector,
    };
    let (sql, binds) = build_retrieval_sql(&plan);

    let mut query = sqlx::query(AssertSqlSafe(sql));
    for bind in binds {
        query = match bind {
            Bind::Str(v) => query.bind(v),
            Bind::U32(v) => query.bind(v),
            Bind::Bytes(v) => query.bind(v),
            Bind::DateTime(v) => query.bind(v),
        };
    }
    let rows = query.fetch_all(pool).await.map_err(DbError::from)?;

    let mut episodes: Vec<Episode> = Vec::new();
    let mut episode_seen: HashSet<String> = HashSet::new();
    let mut facts: Vec<Fact> = Vec::new();
    let mut fact_seen: HashSet<String> = HashSet::new();
    let mut blocks: Vec<SelfBlock> = Vec::new();

    for row in &rows {
        let kind: String = row.try_get("kind").map_err(DbError::from)?;
        let body: serde_json::Value = row.try_get("body").map_err(DbError::from)?;
        match kind.as_str() {
            "episode" => {
                let episode = parse_episode(&body)?;
                if episode_seen.insert(episode.uid.clone()) {
                    episodes.push(episode);
                }
            }
            "fact" => {
                let fact = parse_fact(&body)?;
                if fact_seen.insert(fact.uid.clone()) {
                    facts.push(fact);
                }
            }
            "block" => blocks.push(parse_block(&body)?),
            other => {
                return Err(
                    DbError::Backend(format!("unknown retrieval row kind {other:?}")).into(),
                );
            }
        }
    }
    episodes.truncate(request.limits.episodes as usize);
    facts.truncate(request.limits.facts as usize);

    Ok(RetrievalBundle {
        episodes,
        facts,
        blocks,
        documents: Vec::new(),
        vector_search,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn base_plan() -> RetrievalPlan {
        RetrievalPlan {
            character_id: "alice".into(),
            session_id: "session-1".into(),
            query: String::new(),
            since: None,
            episodes_limit: 5,
            facts_limit: 5,
            episodes_vector: None,
            facts_vector: None,
        }
    }

    #[test]
    fn with_nothing_extra_only_the_block_branch_appears() {
        let (sql, binds) = build_retrieval_sql(&base_plan());
        assert_eq!(sql.matches("UNION ALL").count(), 0);
        assert!(sql.contains("'block' AS kind"));
        assert_eq!(binds, vec![Bind::Str("alice".into())]);
    }

    #[test]
    fn a_blank_query_skips_both_keyword_branches() {
        let mut plan = base_plan();
        plan.query = "   ".into();
        let (sql, _) = build_retrieval_sql(&plan);
        assert!(!sql.contains("AGAINST"));
    }

    #[test]
    fn a_real_query_adds_both_keyword_branches() {
        let mut plan = base_plan();
        plan.query = "hello".into();
        let (sql, binds) = build_retrieval_sql(&plan);
        // Two branches, each matching once to filter and once to rank by relevance.
        assert_eq!(sql.matches("AGAINST").count(), 4);
        assert_eq!(sql.matches("ORDER BY rank LIMIT").count(), 2);
        assert_eq!(
            binds
                .iter()
                .filter(|bind| **bind == Bind::Str("hello".into()))
                .count(),
            4
        );
    }

    #[test]
    fn an_embedding_adds_the_vector_branch_named_from_the_table_only() {
        let mut plan = base_plan();
        plan.episodes_vector = Some(("turn_embeddings_3".into(), vec![1, 2, 3, 4]));
        let (sql, binds) = build_retrieval_sql(&plan);
        assert!(sql.contains("FROM turn_embeddings_3"));
        assert!(sql.contains("VEC_DISTANCE_COSINE"));
        assert!(binds.contains(&Bind::Bytes(vec![1, 2, 3, 4])));
        // The character id and session id travel as binds, never as literal text.
        assert!(!sql.contains("alice"));
        assert!(!sql.contains("session-1"));
    }

    #[test]
    fn a_since_bound_adds_the_filter_only_where_a_time_column_exists() {
        let mut plan = base_plan();
        plan.query = "x".into();
        plan.since = Some(
            NaiveDate::from_ymd_opt(2026, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap(),
        );
        let (sql, binds) = build_retrieval_sql(&plan);
        assert!(sql.contains("t.created_at >= ?"));
        assert!(!sql.contains("f.created_at"));
        assert!(binds.iter().any(|b| matches!(b, Bind::DateTime(_))));
    }

    #[test]
    fn the_current_session_is_excluded_by_bind_not_by_the_session_id_appearing_in_the_sql() {
        let (sql, binds) = build_retrieval_sql(&base_plan());
        assert!(!sql.contains("session-1"));
        // With no query and no embedding only the block branch runs, so no session filter
        // appears at all — add one to prove the exclusion clause when it does.
        let mut plan = base_plan();
        plan.query = "x".into();
        let (sql, binds2) = build_retrieval_sql(&plan);
        assert!(sql.contains("s.uid <> ?"));
        assert!(binds2.contains(&Bind::Str("session-1".into())));
        let _ = binds;
    }

    #[test]
    fn branches_are_ordered_so_vector_hits_outrank_keyword_hits() {
        let mut plan = base_plan();
        plan.query = "x".into();
        plan.episodes_vector = Some(("turn_embeddings_1".into(), vec![0, 0, 0, 0]));
        let (sql, _) = build_retrieval_sql(&plan);
        let vector_pos = sql.find("turn_embeddings_1").unwrap();
        let keyword_pos = sql.find("AGAINST").unwrap();
        assert!(vector_pos < keyword_pos);
        assert!(sql.contains("ORDER BY seq, rank"));
    }
}
