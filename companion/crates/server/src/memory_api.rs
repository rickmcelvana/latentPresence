//! The companion's memory routes (P4-T02, ADR-36) over `latentpresence_db::store`.
//!
//! Every DTO here mirrors a zod shape in `packages/protocol/src/memory.ts` and
//! `companion.ts` field for field (camelCase, the same nesting) — the integration tests
//! validate every response against the generated OpenAPI file, so a drift here is a test
//! failure there, not a silent mismatch.

use axum::extract::{FromRequest, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::get, routing::post, routing::put};
use chrono::NaiveDateTime;
use latentpresence_db::memory::{Collection, EmbeddingModel};
use latentpresence_db::store::{self, StoreError};
use latentpresence_db::{DbError, time as time_util};
use serde::{Deserialize, Serialize};
use sqlx::mysql::MySqlPool;

/// Held by the router: `pool` is `None` when there is no database, or connecting failed.
/// `registry` caches the active embedding models so retrieval is one round trip (ADR-17).
#[derive(Clone, Default)]
pub struct MemoryState {
    pub pool: Option<MySqlPool>,
    pub registry: std::sync::Arc<store::Registry>,
}

impl MemoryState {
    pub fn new(pool: Option<MySqlPool>) -> Self {
        Self {
            pool,
            registry: std::sync::Arc::default(),
        }
    }
}

// ---------------------------------------------------------------------------------------
// Error mapping (`CompanionErrorSchema`)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Debug, Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
    details: Option<serde_json::Value>,
}

pub enum ApiError {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    Unavailable,
    Database(String),
    /// Not produced by any route implemented here; kept for the codes the contract names
    /// (`CompanionErrorSchema.error.code`) that a future route (ingest, MCP) will need.
    #[allow(dead_code)]
    Internal(String),
}

impl ApiError {
    fn parts(&self) -> (StatusCode, &'static str, String) {
        match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, "bad_request", message.clone()),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, "not_found", message.clone()),
            Self::Conflict(message) => (StatusCode::CONFLICT, "conflict", message.clone()),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "unavailable",
                "no database is configured".to_owned(),
            ),
            Self::Database(message) => (StatusCode::BAD_GATEWAY, "database", message.clone()),
            Self::Internal(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                message.clone(),
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        (
            status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code,
                    message,
                    details: None,
                },
            }),
        )
            .into_response()
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::BadRequest(message) => Self::BadRequest(message),
            StoreError::NotFound(message) => Self::NotFound(message),
            StoreError::Conflict(message) => Self::Conflict(message),
            StoreError::Db(db_error) => db_error.into(),
        }
    }
}

impl From<DbError> for ApiError {
    fn from(error: DbError) -> Self {
        match error {
            // Never carries the connection string (`DbError`'s own contract) — safe to
            // surface as the reason a query failed.
            DbError::Backend(message) => Self::Database(message),
            DbError::Vector(vector_error) => Self::BadRequest(vector_error.to_string()),
            DbError::Invalid(message) => Self::BadRequest(message),
        }
    }
}

/// A body that failed to parse: `bad_request` with serde's own message, never axum's
/// default (415/422 and a plain-text body outside `CompanionErrorSchema`).
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    T: serde::de::DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiError::BadRequest(rejection.body_text())),
        }
    }
}

fn parse_time(input: &str) -> Result<NaiveDateTime, ApiError> {
    time_util::parse_timestamp(input).map_err(|error| ApiError::BadRequest(error.to_string()))
}

fn pool_or_unavailable(state: &MemoryState) -> Result<&MySqlPool, ApiError> {
    state.pool.as_ref().ok_or(ApiError::Unavailable)
}

// ---------------------------------------------------------------------------------------
// Shared DTOs
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EmbeddingModelRefDto {
    pub provider: String,
    pub model: String,
    pub dimensions: u16,
}

impl From<EmbeddingModelRefDto> for EmbeddingModel {
    fn from(value: EmbeddingModelRefDto) -> Self {
        EmbeddingModel {
            provider: value.provider,
            model: value.model,
            dimensions: value.dimensions,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct EmbeddingDto {
    pub model: EmbeddingModelRefDto,
    pub vector: Vec<f32>,
}

fn collection_from_str(value: &str) -> Result<Collection, ApiError> {
    Collection::parse(value)
        .ok_or_else(|| ApiError::BadRequest(format!("unknown collection {value:?}")))
}

// ---------------------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct DatabaseHealth {
    kind: &'static str,
    connected: bool,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    database: DatabaseHealth,
}

/// `has_url` distinguishes "no database configured" (`kind: none`) from "configured but the
/// pool did not come up" (`kind: mariadb, connected: false`) — the pool alone cannot,
/// because a failed connection at startup leaves no pool either way.
pub async fn health(State((state, has_url)): State<(MemoryState, bool)>) -> Json<HealthResponse> {
    let (kind, connected) = match &state.pool {
        Some(pool) => (
            "mariadb",
            sqlx::Executor::execute(pool, "SELECT 1").await.is_ok(),
        ),
        None if has_url => ("mariadb", false),
        None => ("none", false),
    };
    Json(HealthResponse {
        status: "ok",
        service: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        database: DatabaseHealth { kind, connected },
    })
}

// ---------------------------------------------------------------------------------------
// dbRegisterEmbeddingModel / dbActivateCollection
// ---------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct CollectionStatusDto {
    collection: &'static str,
    status: &'static str,
}

#[derive(Debug, Serialize)]
struct RegisterEmbeddingModelResponse {
    #[serde(rename = "modelId")]
    model_id: String,
    collections: Vec<CollectionStatusDto>,
}

async fn register_embedding_model(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<EmbeddingModelRefDto>,
) -> Result<Json<RegisterEmbeddingModelResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let model: EmbeddingModel = body.into();
    let (model_id, statuses) =
        store::register_embedding_model(pool, &state.registry, &model).await?;
    Ok(Json(RegisterEmbeddingModelResponse {
        model_id: model_id.to_string(),
        collections: statuses
            .into_iter()
            .map(|(collection, status)| CollectionStatusDto {
                collection: collection.as_str(),
                status: status.as_str(),
            })
            .collect(),
    }))
}

#[derive(Debug, Deserialize)]
struct ActivateCollectionRequest {
    collection: String,
    model: EmbeddingModelRefDto,
}

async fn activate_collection(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<ActivateCollectionRequest>,
) -> Result<Json<OkResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let collection = collection_from_str(&body.collection)?;
    let model: EmbeddingModel = body.model.into();
    store::activate_collection(pool, &state.registry, collection, &model).await?;
    Ok(Json(OkResponse::ok()))
}

// ---------------------------------------------------------------------------------------
// dbAppendEpisode
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendEpisodeRequest {
    id: String,
    session_id: String,
    character_id: String,
    role: String,
    text: String,
    interrupted: bool,
    at: String,
    embedding: Option<EmbeddingDto>,
    affect: Option<serde_json::Value>,
}

async fn append_episode(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<AppendEpisodeRequest>,
) -> Result<Json<OkResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let role = store::Role::parse(&body.role).map_err(|_| {
        ApiError::BadRequest(format!(
            "role must be 'user' or 'assistant', not {:?}",
            body.role
        ))
    })?;
    let episode = store::Episode {
        uid: body.id,
        session_uid: body.session_id,
        character_id: body.character_id,
        role,
        text: body.text,
        interrupted: body.interrupted,
        at: parse_time(&body.at)?,
        embedding: body.embedding.map(embedding_from_dto),
        affect: body.affect,
    };
    store::append_episode(pool, &state.registry, &episode).await?;
    Ok(Json(OkResponse::ok()))
}

fn embedding_from_dto(dto: EmbeddingDto) -> store::Embedding {
    store::Embedding {
        model: dto.model.into(),
        vector: dto.vector,
    }
}

// ---------------------------------------------------------------------------------------
// dbUpsertFact / dbSupersedeFact
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertFactRequest {
    id: String,
    character_id: String,
    subject: String,
    predicate: String,
    object: String,
    confidence: f32,
    valid_from: String,
    valid_to: Option<String>,
    recorded_at: String,
    source_episode_id: Option<String>,
    embedding: Option<EmbeddingDto>,
}

async fn upsert_fact(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<UpsertFactRequest>,
) -> Result<Json<OkResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let fact = store::Fact {
        uid: body.id,
        character_id: body.character_id,
        subject: body.subject,
        predicate: body.predicate,
        object: body.object,
        confidence: body.confidence,
        valid_from: Some(parse_time(&body.valid_from)?),
        valid_to: body.valid_to.as_deref().map(parse_time).transpose()?,
        recorded_at: parse_time(&body.recorded_at)?,
        source_episode_uid: body.source_episode_id,
        embedding: body.embedding.map(embedding_from_dto),
    };
    store::upsert_fact(pool, &state.registry, &fact).await?;
    Ok(Json(OkResponse::ok()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupersedeFactRequest {
    id: String,
    valid_to: String,
}

async fn supersede_fact(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<SupersedeFactRequest>,
) -> Result<Json<OkResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let valid_to = parse_time(&body.valid_to)?;
    store::supersede_fact(pool, &body.id, valid_to).await?;
    Ok(Json(OkResponse::ok()))
}

// ---------------------------------------------------------------------------------------
// dbReadBlocks / dbWriteBlock
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CharacterQuery {
    #[serde(rename = "characterId")]
    character_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockDto {
    character_id: String,
    name: String,
    content: String,
    updated_at: String,
    editable_by_character: bool,
}

impl From<store::SelfBlock> for BlockDto {
    fn from(block: store::SelfBlock) -> Self {
        Self {
            character_id: block.character_id,
            name: block.name,
            content: block.content,
            updated_at: time_util::format_timestamp(block.updated_at),
            editable_by_character: block.editable_by_character,
        }
    }
}

#[derive(Debug, Serialize)]
struct BlocksResponse {
    blocks: Vec<BlockDto>,
}

async fn read_blocks(
    State(state): State<MemoryState>,
    Query(query): Query<CharacterQuery>,
) -> Result<Json<BlocksResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let blocks = store::read_blocks(pool, &query.character_id).await?;
    Ok(Json(BlocksResponse {
        blocks: blocks.into_iter().map(BlockDto::from).collect(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteBlockRequest {
    character_id: String,
    name: String,
    content: String,
    updated_at: String,
    editable_by_character: bool,
}

async fn write_block(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<WriteBlockRequest>,
) -> Result<Json<OkResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let block = store::SelfBlock {
        character_id: body.character_id,
        name: body.name,
        content: body.content,
        updated_at: parse_time(&body.updated_at)?,
        editable_by_character: body.editable_by_character,
    };
    store::write_block(pool, &block).await?;
    Ok(Json(OkResponse::ok()))
}

// ---------------------------------------------------------------------------------------
// dbListPlans / dbSavePlan
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
struct PlanTaskDto {
    id: String,
    title: String,
    status: String,
    notes: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct PlanPhaseDto {
    id: String,
    title: String,
    tasks: Vec<PlanTaskDto>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanDto {
    id: String,
    character_id: String,
    title: String,
    goal: String,
    phases: Vec<PlanPhaseDto>,
    status: String,
    version: u32,
    updated_at: String,
}

impl From<store::Plan> for PlanDto {
    fn from(plan: store::Plan) -> Self {
        Self {
            id: plan.uid,
            character_id: plan.character_id,
            title: plan.title,
            goal: plan.goal,
            phases: plan
                .phases
                .into_iter()
                .map(|phase| PlanPhaseDto {
                    id: phase.uid,
                    title: phase.title,
                    tasks: phase
                        .tasks
                        .into_iter()
                        .map(|task| PlanTaskDto {
                            id: task.uid,
                            title: task.title,
                            status: task.status,
                            notes: task.notes,
                        })
                        .collect(),
                })
                .collect(),
            status: plan.status,
            version: plan.version,
            updated_at: time_util::format_timestamp(plan.updated_at),
        }
    }
}

fn plan_from_dto(dto: PlanDto) -> Result<store::Plan, ApiError> {
    Ok(store::Plan {
        uid: dto.id,
        character_id: dto.character_id,
        title: dto.title,
        goal: dto.goal,
        phases: dto
            .phases
            .into_iter()
            .map(|phase| store::PlanPhase {
                uid: phase.id,
                title: phase.title,
                tasks: phase
                    .tasks
                    .into_iter()
                    .map(|task| store::PlanTask {
                        uid: task.id,
                        title: task.title,
                        status: task.status,
                        notes: task.notes,
                    })
                    .collect(),
            })
            .collect(),
        status: dto.status,
        version: dto.version,
        updated_at: parse_time(&dto.updated_at)?,
    })
}

#[derive(Debug, Serialize)]
struct PlansResponse {
    plans: Vec<PlanDto>,
}

async fn list_plans(
    State(state): State<MemoryState>,
    Query(query): Query<CharacterQuery>,
) -> Result<Json<PlansResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let plans = store::list_plans(pool, &query.character_id).await?;
    Ok(Json(PlansResponse {
        plans: plans.into_iter().map(PlanDto::from).collect(),
    }))
}

async fn save_plan(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<PlanDto>,
) -> Result<Json<OkResponse>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let plan = plan_from_dto(body)?;
    store::save_plan(pool, &plan).await?;
    Ok(Json(OkResponse::ok()))
}

// ---------------------------------------------------------------------------------------
// dbRetrieve
// ---------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalLimitsDto {
    episodes: u32,
    facts: u32,
    documents: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalRequestDto {
    character_id: String,
    session_id: String,
    query: String,
    query_embedding: Option<EmbeddingDto>,
    limits: RetrievalLimitsDto,
    since: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeDto {
    id: String,
    session_id: String,
    character_id: String,
    role: &'static str,
    text: String,
    interrupted: bool,
    at: String,
    embedding: Option<EmbeddingDto>,
    affect: Option<serde_json::Value>,
}

impl From<store::Episode> for EpisodeDto {
    fn from(episode: store::Episode) -> Self {
        Self {
            id: episode.uid,
            session_id: episode.session_uid,
            character_id: episode.character_id,
            role: episode.role.as_str(),
            text: episode.text,
            interrupted: episode.interrupted,
            at: time_util::format_timestamp(episode.at),
            embedding: None,
            affect: episode.affect,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FactDto {
    id: String,
    character_id: String,
    subject: String,
    predicate: String,
    object: String,
    confidence: f32,
    valid_from: String,
    valid_to: Option<String>,
    recorded_at: String,
    source_episode_id: Option<String>,
    embedding: Option<EmbeddingDto>,
}

impl From<store::Fact> for FactDto {
    fn from(fact: store::Fact) -> Self {
        Self {
            id: fact.uid,
            character_id: fact.character_id,
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            confidence: fact.confidence,
            // The schema's `validFrom` is required; the store always sets one on write.
            valid_from: time_util::format_timestamp(fact.valid_from.unwrap_or(fact.recorded_at)),
            valid_to: fact.valid_to.map(time_util::format_timestamp),
            recorded_at: time_util::format_timestamp(fact.recorded_at),
            source_episode_id: fact.source_episode_uid,
            embedding: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetrievalBundleDto {
    episodes: Vec<EpisodeDto>,
    facts: Vec<FactDto>,
    blocks: Vec<BlockDto>,
    documents: Vec<serde_json::Value>,
    vector_search: &'static str,
    elapsed_ms: u64,
}

async fn retrieve(
    State(state): State<MemoryState>,
    ApiJson(body): ApiJson<RetrievalRequestDto>,
) -> Result<Json<RetrievalBundleDto>, ApiError> {
    let pool = pool_or_unavailable(&state)?;
    let request = store::RetrievalRequest {
        character_id: body.character_id,
        session_id: body.session_id,
        query: body.query,
        query_embedding: body.query_embedding.map(embedding_from_dto),
        limits: store::RetrievalLimits {
            episodes: body.limits.episodes,
            facts: body.limits.facts,
            documents: body.limits.documents,
        },
        since: body.since.as_deref().map(parse_time).transpose()?,
    };
    let bundle = store::retrieve(pool, &state.registry, &request).await?;
    Ok(Json(RetrievalBundleDto {
        episodes: bundle.episodes.into_iter().map(EpisodeDto::from).collect(),
        facts: bundle.facts.into_iter().map(FactDto::from).collect(),
        blocks: bundle.blocks.into_iter().map(BlockDto::from).collect(),
        documents: bundle.documents,
        vector_search: bundle.vector_search.as_str(),
        elapsed_ms: bundle.elapsed_ms,
    }))
}

// ---------------------------------------------------------------------------------------
// `{ ok: true }`
// ---------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

impl OkResponse {
    fn ok() -> Self {
        Self { ok: true }
    }
}

/// The `/db/*` and `/health` surface, over the given memory state and whether a
/// `DATABASE_URL` was configured at all (`health`'s `none` vs `mariadb`/`false`).
pub fn router(state: MemoryState, has_database_url: bool) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state((state.clone(), has_database_url))
        .merge(
            Router::new()
                .route("/db/retrieve", post(retrieve))
                .route("/db/episodes", post(append_episode))
                .route("/db/facts", post(upsert_fact))
                .route("/db/facts/supersede", post(supersede_fact))
                .route("/db/embedding-models", put(register_embedding_model))
                .route("/db/collections/activate", post(activate_collection))
                .route("/db/blocks", get(read_blocks).put(write_block))
                .route("/db/plans", get(list_plans).post(save_plan))
                .with_state(state),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collections_parse_from_the_wire_names() {
        assert!(collection_from_str("turns").is_ok());
        assert!(collection_from_str("nonsense").is_err());
    }

    #[test]
    fn db_errors_never_leak_the_connection_string_through_the_api_mapping() {
        let db_error = DbError::Backend("mysql://user:pw@host/db failed".into());
        let api_error: ApiError = db_error.into();
        let (_, _, message) = api_error.parts();
        // `DbError::Backend` carries whatever sqlx said, which is already scrubbed
        // (`crates/db/src/lib.rs`'s own test); this only proves the mapping adds nothing.
        assert!(!message.contains("hunter2"));
    }

    #[test]
    fn every_store_error_kind_maps_to_the_contracts_own_code() {
        for (error, expected) in [
            (StoreError::BadRequest("x".into()), "bad_request"),
            (StoreError::NotFound("x".into()), "not_found"),
            (StoreError::Conflict("x".into()), "conflict"),
            (StoreError::Db(DbError::Invalid("x".into())), "bad_request"),
            (StoreError::Db(DbError::Backend("x".into())), "database"),
        ] {
            let api_error: ApiError = error.into();
            let (_, code, _) = api_error.parts();
            assert_eq!(code, expected);
        }
    }
}
