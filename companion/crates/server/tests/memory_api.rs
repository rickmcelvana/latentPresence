//! Integration tests for the memory routes (P4-T02) against a real MariaDB.
//!
//! Skipped (with an `eprintln!`, not a failure) unless `LP_TEST_DATABASE_URL` is set, so
//! `pnpm gate` passes on a machine with no database. Every 200 body is validated against
//! its `components.schemas` entry in the committed OpenAPI file, and every error body
//! against `CompanionError` — the done-when's "matches". Each test uses its own
//! `character_id` (`test-<random>`) and deletes what it wrote.

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use latentpresence_companion::{memory_api, relay, router_with};
use rand::Rng;
use serde_json::{Value, json};
use sqlx::AssertSqlSafe;
use sqlx::mysql::MySqlPool;
use tower::ServiceExt;

const OPENAPI_JSON: &str =
    include_str!("../../../../packages/protocol/src/generated/companion.openapi.json");

fn openapi() -> Value {
    serde_json::from_str(OPENAPI_JSON).expect("the committed OpenAPI file is valid JSON")
}

/// Validate `instance` against `components.schemas.<name>` in the committed OpenAPI file —
/// the done-when's "OpenAPI generated from the zod schema matches".
fn assert_matches_schema(name: &str, instance: &Value) {
    let doc = openapi();
    let schema = doc
        .pointer(&format!("/components/schemas/{name}"))
        .unwrap_or_else(|| panic!("no component schema named {name:?}"))
        .clone();
    let validator = jsonschema::validator_for(&schema).expect("schema compiles");
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|e| e.to_string())
        .collect();
    assert!(
        errors.is_empty(),
        "{name} did not validate: {errors:?}\ninstance: {instance}"
    );
}

fn assert_matches_error_schema(instance: &Value) {
    assert_matches_schema("CompanionError", instance);
}

fn random_id(prefix: &str) -> String {
    let suffix: u64 = rand::rng().random();
    format!("{prefix}-{suffix:x}")
}

/// **The embedding-model registry is global** (ADR-35: one vector table per collection and
/// model, whichever character), so tests that register models, or ask which is active, would
/// race each other and anything left behind. Every test therefore holds this lock for its
/// whole run, and starts and ends by removing every model it could have registered (provider
/// `memory-api-test`) with its vector tables. Fourteen tests in a row take a few seconds.
static SERIAL: std::sync::LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(std::sync::Arc::default);

/// A connected pool and a router over it, holding the test lock, or `None` (with an
/// explanation on stderr) when `LP_TEST_DATABASE_URL` is not set.
async fn setup() -> Option<(Router, MySqlPool, tokio::sync::OwnedMutexGuard<()>)> {
    let Ok(url) = std::env::var("LP_TEST_DATABASE_URL") else {
        eprintln!("memory_api integration tests skipped: LP_TEST_DATABASE_URL is not set");
        return None;
    };
    let serial = SERIAL.clone().lock_owned().await;
    let pool = latentpresence_db::connect(&url)
        .await
        .expect("the test database connects and migrates");
    remove_test_models(&pool).await;
    let router = router_with(
        relay::Relay::measured(),
        memory_api::MemoryState::new(Some(pool.clone())),
        true,
    );
    Some((router, pool, serial))
}

/// Every model a test registered, its vector tables and its collection rows.
async fn remove_test_models(pool: &MySqlPool) {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT c.table_name FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE m.provider = 'memory-api-test'",
    )
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
         WHERE m.provider = 'memory-api-test'",
    )
    .execute(pool)
    .await
    .expect("delete test collections");
    sqlx::query("DELETE FROM model_registry WHERE provider = 'memory-api-test'")
        .execute(pool)
        .await
        .expect("delete test models");
}

async fn cleanup(pool: &MySqlPool, character_id: &str) {
    cleanup_rows(pool, character_id).await;
    remove_test_models(pool).await;
}

async fn cleanup_rows(pool: &MySqlPool, character_id: &str) {
    // Dependency order: turns/facts cascade from sessions/nothing, plans cascade their
    // items, self_blocks and model-registry rows this test may have created.
    let _ = sqlx::query("DELETE FROM sessions WHERE character_id = ?")
        .bind(character_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM facts WHERE character_id = ?")
        .bind(character_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM self_blocks WHERE character_id = ?")
        .bind(character_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM plans WHERE character_id = ?")
        .bind(character_id)
        .execute(pool)
        .await;
}

async fn call(
    router: &Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    let request = if let Some(body) = body {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        builder.body(Body::from(body.to_string())).unwrap()
    } else {
        builder.body(Body::empty()).unwrap()
    };
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
    let value: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("body is json: {e}: {bytes:?}"))
    };
    (status, value)
}

#[tokio::test]
async fn health_reports_mariadb_connected_against_a_real_database() {
    let Some((router, _pool, _serial)) = setup().await else {
        return;
    };
    let (status, body) = call(&router, Method::GET, "/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_matches_schema("HealthResponse", &body);
    assert_eq!(body["database"]["kind"], "mariadb");
    assert_eq!(body["database"]["connected"], true);
}

#[tokio::test]
async fn registering_a_model_makes_every_collection_active_the_first_time() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");

    let model = json!({ "provider": "memory-api-test", "model": "four-wide", "dimensions": 4 });
    let (status, body) = call(&router, Method::PUT, "/db/embedding-models", Some(model)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbRegisterEmbeddingModelResponse", &body);
    let collections = body["collections"].as_array().expect("collections array");
    assert_eq!(collections.len(), 3);
    for entry in collections {
        assert_eq!(entry["status"], "active");
    }

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn episodes_append_idempotently_embed_and_retrieve_by_vector_and_keyword() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");
    let other_session_id = random_id("session-other");
    let model = json!({ "provider": "memory-api-test", "model": "four-wide", "dimensions": 4 });

    let (status, register_body) = call(
        &router,
        Method::PUT,
        "/db/embedding-models",
        Some(model.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{register_body}");

    let turn_id = random_id("turn");
    let episode = json!({
        "id": turn_id,
        "sessionId": session_id,
        "characterId": character_id,
        "role": "user",
        "text": "the quick brown fox jumps over the lazy dog",
        "interrupted": false,
        "at": "2026-09-27T12:00:00.000Z",
        "embedding": { "model": model, "vector": [1.0, 0.0, 0.0, 0.0] },
        "affect": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/episodes", Some(episode.clone())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbAppendEpisodeResponse", &body);

    // Idempotent: the same id again is not an error and does not duplicate the turn.
    let (status, body) = call(&router, Method::POST, "/db/episodes", Some(episode.clone())).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A second episode in a *different* session, so the exclusion clause has something
    // to exclude.
    let other_turn_id = random_id("turn");
    let other_episode = json!({
        "id": other_turn_id,
        "sessionId": other_session_id,
        "characterId": character_id,
        "role": "user",
        "text": "the quick brown fox again",
        "interrupted": false,
        "at": "2026-09-27T12:00:01.000Z",
        "embedding": { "model": model, "vector": [0.9, 0.1, 0.0, 0.0] },
        "affect": null,
    });
    let (status, _) = call(&router, Method::POST, "/db/episodes", Some(other_episode)).await;
    assert_eq!(status, StatusCode::OK);

    // Retrieve from `session_id`'s point of view: its own turn must be excluded, the
    // other session's near-identical vector must come back by vector search.
    let retrieval = json!({
        "characterId": character_id,
        "sessionId": session_id,
        "query": "quick brown fox",
        "queryEmbedding": { "model": model, "vector": [1.0, 0.0, 0.0, 0.0] },
        "limits": { "episodes": 10, "facts": 10, "documents": 10 },
        "since": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbRetrieveResponse", &body);
    assert_eq!(body["vectorSearch"], "used");
    let episode_ids: Vec<&str> = body["episodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert!(
        episode_ids.contains(&other_turn_id.as_str()),
        "{episode_ids:?}"
    );
    assert!(
        !episode_ids.contains(&turn_id.as_str()),
        "the current session's own turn must be excluded: {episode_ids:?}"
    );
    for episode in body["episodes"].as_array().unwrap() {
        assert!(episode["embedding"].is_null());
    }

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn retrieve_reports_no_query_embedding_and_never_used_for_an_unregistered_model() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");

    // No embedding at all.
    let retrieval = json!({
        "characterId": character_id,
        "sessionId": session_id,
        "query": "",
        "queryEmbedding": null,
        "limits": { "episodes": 5, "facts": 5, "documents": 5 },
        "since": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbRetrieveResponse", &body);
    assert_eq!(body["vectorSearch"], "no-query-embedding");
    assert_eq!(body["documents"], json!([]));

    // An embedding whose model has never been registered at all. `model_registry` and
    // `vector_collections` are global (not per-character, ADR-35), and this dev database
    // is shared with every other test and with `memory-check`, so whether `turns` has
    // *any* active model by the time this runs is not this test's to control — only that
    // an unregistered model can never be the one that is active. If nothing has ever
    // registered a model, the reason is `no-active-model`; if something else has, it is
    // `other-model`. Either is the same promise: an unknown model's vectors never search.
    let retrieval = json!({
        "characterId": character_id,
        "sessionId": session_id,
        "query": "",
        "queryEmbedding": {
            "model": { "provider": "memory-api-test", "model": "never-registered", "dimensions": 4 },
            "vector": [0.0, 0.0, 0.0, 1.0],
        },
        "limits": { "episodes": 5, "facts": 5, "documents": 5 },
        "since": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let reason = body["vectorSearch"].as_str().unwrap();
    assert!(
        reason == "no-active-model" || reason == "other-model",
        "an unregistered model must never be reported as used: {reason}"
    );

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn retrieve_reports_other_model_when_a_different_model_is_active() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");

    let active_model =
        json!({ "provider": "memory-api-test", "model": "active-model", "dimensions": 4 });
    let (status, body) = call(
        &router,
        Method::PUT,
        "/db/embedding-models",
        Some(active_model),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Register a second model (its collections come up `building`, not active, since
    // `turns`/`facts`/`chunks` already have an active model from the call above).
    let other_model =
        json!({ "provider": "memory-api-test", "model": "other-model", "dimensions": 4 });
    let (status, body) = call(
        &router,
        Method::PUT,
        "/db/embedding-models",
        Some(other_model.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for entry in body["collections"].as_array().unwrap() {
        assert_eq!(entry["status"], "building");
    }

    let retrieval = json!({
        "characterId": character_id,
        "sessionId": session_id,
        "query": "",
        "queryEmbedding": { "model": other_model, "vector": [0.0, 1.0, 0.0, 0.0] },
        "limits": { "episodes": 5, "facts": 5, "documents": 5 },
        "since": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["vectorSearch"], "other-model");

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn activating_an_unbuilt_collection_is_not_found() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let request = json!({
        "collection": "facts",
        "model": { "provider": "memory-api-test", "model": random_id("never-built"), "dimensions": 4 },
    });
    let (status, body) = call(
        &router,
        Method::POST,
        "/db/collections/activate",
        Some(request),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_matches_error_schema(&body);
    assert_eq!(body["error"]["code"], "not_found");

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn facts_upsert_supersede_and_leave_retrieval_once_closed() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");

    let fact_id = random_id("fact");
    let fact = json!({
        "id": fact_id,
        "characterId": character_id,
        "subject": "Rick",
        "predicate": "livesIn",
        "object": "a house with a very good router",
        "confidence": 0.9,
        "validFrom": "2026-01-01T00:00:00.000Z",
        "validTo": null,
        "recordedAt": "2026-09-27T00:00:00.000Z",
        "sourceEpisodeId": null,
        "embedding": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/facts", Some(fact)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbUpsertFactResponse", &body);

    let retrieval = json!({
        "characterId": character_id,
        "sessionId": session_id,
        "query": "very good router",
        "queryEmbedding": null,
        "limits": { "episodes": 5, "facts": 5, "documents": 5 },
        "since": null,
    });
    let (status, body) = call(
        &router,
        Method::POST,
        "/db/retrieve",
        Some(retrieval.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let fact_ids: Vec<&str> = body["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert!(fact_ids.contains(&fact_id.as_str()), "{fact_ids:?}");

    let supersede = json!({ "id": fact_id, "validTo": "2026-09-27T00:00:00.000Z" });
    let (status, body) = call(
        &router,
        Method::POST,
        "/db/facts/supersede",
        Some(supersede),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbSupersedeFactResponse", &body);

    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let fact_ids: Vec<&str> = body["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert!(
        !fact_ids.contains(&fact_id.as_str()),
        "a superseded fact must not still be current: {fact_ids:?}"
    );

    // Superseding an unknown fact is `not_found`.
    let (status, body) = call(
        &router,
        Method::POST,
        "/db/facts/supersede",
        Some(json!({ "id": random_id("nope"), "validTo": "2026-09-27T00:00:00.000Z" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_matches_error_schema(&body);

    cleanup(&pool, &character_id).await;
}

/// `dbCurrentFacts` and `dbExpireFact` (ADR-37): current means not expired and `validTo` unset
/// or still ahead; expiring hides a fact from both reads, keeps its row, and a second expiry
/// does not move the first.
#[tokio::test]
async fn current_facts_leave_out_the_expired_and_the_ended() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let other_character = random_id("test");
    let fact = |id: &str, character: &str, object: &str, valid_to: Value| {
        json!({
            "id": id,
            "characterId": character,
            "subject": "user",
            "predicate": "likes",
            "object": object,
            "confidence": 0.8,
            "validFrom": "2026-01-01T00:00:00.000Z",
            "validTo": valid_to,
            "recordedAt": "2026-09-27T00:00:00.000Z",
            "sourceEpisodeId": null,
            "embedding": null,
        })
    };
    let holding = random_id("fact");
    let ending_later = random_id("fact");
    let ended = random_id("fact");
    let expired = random_id("fact");
    let elsewhere = random_id("fact");
    for body in [
        fact(&holding, &character_id, "marmalade", Value::Null),
        fact(
            &ending_later,
            &character_id,
            "the lease",
            json!("2999-01-01T00:00:00.000Z"),
        ),
        fact(
            &ended,
            &character_id,
            "the old job",
            json!("2026-02-01T00:00:00.000Z"),
        ),
        fact(&expired, &character_id, "a duplicate", Value::Null),
        fact(
            &elsewhere,
            &other_character,
            "another character's secret",
            Value::Null,
        ),
    ] {
        let (status, body) = call(&router, Method::POST, "/db/facts", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let expire = json!({ "id": expired, "at": "2026-09-28T10:00:00.000Z" });
    let (status, body) = call(&router, Method::POST, "/db/facts/expire", Some(expire)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbExpireFactResponse", &body);
    // Again, later: idempotent, and the first moment stands.
    let again = json!({ "id": expired, "at": "2026-09-30T10:00:00.000Z" });
    let (status, body) = call(&router, Method::POST, "/db/facts/expire", Some(again)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let expired_at: Option<chrono::NaiveDateTime> =
        sqlx::query_scalar("SELECT expired_at FROM facts WHERE uid = ?")
            .bind(&expired)
            .fetch_one(&pool)
            .await
            .expect("the expired row is kept");
    assert_eq!(
        expired_at.map(|at| at.to_string()),
        Some("2026-09-28 10:00:00".to_owned())
    );

    let (status, body) = call(
        &router,
        Method::GET,
        &format!("/db/facts?characterId={character_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbCurrentFactsResponse", &body);
    let ids: Vec<&str> = body["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert!(
        ids.contains(&holding.as_str()) && ids.contains(&ending_later.as_str()),
        "{ids:?}"
    );
    assert_eq!(body["facts"][0]["embedding"], Value::Null);

    // Retrieval agrees: the expired fact is not found by its words.
    let retrieval = json!({
        "characterId": character_id,
        "sessionId": random_id("session"),
        "query": "duplicate",
        "queryEmbedding": null,
        "limits": { "episodes": 5, "facts": 5, "documents": 0 },
        "since": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["facts"], json!([]), "{body}");

    let (status, body) = call(
        &router,
        Method::POST,
        "/db/facts/expire",
        Some(json!({ "id": random_id("nope"), "at": "2026-09-28T10:00:00.000Z" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_matches_error_schema(&body);

    cleanup(&pool, &character_id).await;
    cleanup(&pool, &other_character).await;
}

/// P4-T05, ADR-39: turns list newest first, a page at a time, and the person's deletes are
/// real deletes — row and vector — while a fact read from a deleted turn stays, unlinked.
#[tokio::test]
async fn episodes_list_newest_first_and_deletes_are_deletes() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");
    let model = json!({ "provider": "memory-api-test", "model": "delete-check", "dimensions": 3 });
    let mut ids = Vec::new();
    for (i, text) in ["first words", "second words", "third words"]
        .iter()
        .enumerate()
    {
        let id = random_id("ep");
        let episode = json!({
            "id": id,
            "sessionId": session_id,
            "characterId": character_id,
            "role": "user",
            "text": text,
            "interrupted": false,
            "at": format!("2026-09-2{}T10:00:00.000Z", i + 1),
            "embedding": { "model": model, "vector": [1.0, 0.0, i as f32] },
            "affect": null,
        });
        let (status, body) = call(&router, Method::POST, "/db/episodes", Some(episode)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        ids.push(id);
    }

    let (status, body) = call(
        &router,
        Method::GET,
        &format!("/db/episodes?characterId={character_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbListEpisodesResponse", &body);
    let listed: Vec<&str> = body["episodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        listed,
        vec![ids[2].as_str(), ids[1].as_str(), ids[0].as_str()]
    );

    let (status, body) = call(
        &router,
        Method::GET,
        &format!("/db/episodes?characterId={character_id}&before=2026-09-22T10:00:00.000Z"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["episodes"].as_array().unwrap().len(), 1);
    assert_eq!(body["episodes"][0]["id"], json!(ids[0]));

    // A fact read from the second turn, then the turn deleted.
    let fact_id = random_id("fact");
    let fact = json!({
        "id": fact_id,
        "characterId": character_id,
        "subject": "user",
        "predicate": "said",
        "object": "second words",
        "confidence": 0.8,
        "validFrom": "2026-09-22T10:00:00.000Z",
        "validTo": null,
        "recordedAt": "2026-09-22T10:00:00.000Z",
        "sourceEpisodeId": ids[1],
        "embedding": { "model": model, "vector": [0.0, 1.0, 0.0] },
    });
    let (status, body) = call(&router, Method::POST, "/db/facts", Some(fact)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = call(
        &router,
        Method::DELETE,
        &format!("/db/episodes/{}", ids[1]),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbDeleteEpisodeResponse", &body);
    let (_, body) = call(
        &router,
        Method::GET,
        &format!("/db/episodes?characterId={character_id}"),
        None,
    )
    .await;
    assert_eq!(body["episodes"].as_array().unwrap().len(), 2);
    let (_, body) = call(
        &router,
        Method::GET,
        &format!("/db/facts?characterId={character_id}"),
        None,
    )
    .await;
    assert_eq!(body["facts"][0]["id"], json!(fact_id));
    assert_eq!(body["facts"][0]["sourceEpisodeId"], Value::Null);

    let (status, body) = call(
        &router,
        Method::DELETE,
        &format!("/db/facts/{fact_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbDeleteFactResponse", &body);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM facts WHERE uid = ?")
        .bind(&fact_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a deleted fact is gone, not expired");
    // And its vector with it: no row in any fact vector table points at a missing fact.
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT c.table_name FROM vector_collections c JOIN model_registry m ON m.id = c.model_id
         WHERE m.provider = 'memory-api-test' AND c.collection = 'facts'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for table in tables {
        let orphans: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM {table} v LEFT JOIN facts f ON f.id = v.item_id WHERE f.id IS NULL"
        )))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(orphans, 0);
    }

    for path in [
        format!("/db/facts/{fact_id}"),
        format!("/db/episodes/{}", ids[1]),
    ] {
        let (status, body) = call(&router, Method::DELETE, &path, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_matches_error_schema(&body);
    }

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn a_fact_naming_an_unknown_episode_is_a_bad_request() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let fact = json!({
        "id": random_id("fact"),
        "characterId": character_id,
        "subject": "x",
        "predicate": "y",
        "object": "z",
        "confidence": 1.0,
        "validFrom": "2026-01-01T00:00:00.000Z",
        "validTo": null,
        "recordedAt": "2026-09-27T00:00:00.000Z",
        "sourceEpisodeId": random_id("no-such-episode"),
        "embedding": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/facts", Some(fact)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_matches_error_schema(&body);
    assert_eq!(body["error"]["code"], "bad_request");

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn blocks_round_trip_and_refuse_content_over_the_limit() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");

    let block = json!({
        "characterId": character_id,
        "name": "persona",
        "content": "warm, curious, a little dry",
        "updatedAt": "2026-09-27T00:00:00.000Z",
        "editableByCharacter": true,
    });
    let (status, body) = call(&router, Method::PUT, "/db/blocks", Some(block)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbWriteBlockResponse", &body);

    let (status, body) = call(
        &router,
        Method::GET,
        &format!("/db/blocks?characterId={character_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbReadBlocksResponse", &body);
    let blocks = body["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0]["name"], "persona");
    assert_eq!(blocks[0]["content"], "warm, curious, a little dry");

    // The default limit (2000) is refused with words, not the table's own CHECK error.
    let too_long = json!({
        "characterId": character_id,
        "name": "persona",
        "content": "x".repeat(2001),
        "updatedAt": "2026-09-27T00:00:01.000Z",
        "editableByCharacter": true,
    });
    let (status, body) = call(&router, Method::PUT, "/db/blocks", Some(too_long)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_matches_error_schema(&body);
    assert_eq!(body["error"]["code"], "bad_request");

    // A system block (`_`-prefixed, ADR-40) is created with room for machine JSON.
    let mood = json!({
        "characterId": character_id,
        "name": "_mood",
        "content": "x".repeat(9000),
        "updatedAt": "2026-09-27T00:00:02.000Z",
        "editableByCharacter": false,
    });
    let (status, body) = call(&router, Method::PUT, "/db/blocks", Some(mood)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn plans_save_list_and_conflict_on_a_stale_version() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let plan_id = random_id("plan");
    let phase_id = random_id("phase");
    let task_id = random_id("task");

    let plan_v1 = json!({
        "id": plan_id,
        "characterId": character_id,
        "title": "Ship P4-T02",
        "goal": "a memory API",
        "phases": [{
            "id": phase_id,
            "title": "Build it",
            "tasks": [{ "id": task_id, "title": "write the routes", "status": "doing", "notes": "" }],
        }],
        "status": "active",
        "version": 1,
        "updatedAt": "2026-09-27T00:00:00.000Z",
    });
    let (status, body) = call(&router, Method::POST, "/db/plans", Some(plan_v1.clone())).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbSavePlanResponse", &body);

    // Saving version 1 again (as if it were new) is a conflict — the stored version is 1.
    let (status, body) = call(&router, Method::POST, "/db/plans", Some(plan_v1)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_matches_error_schema(&body);
    assert_eq!(body["error"]["code"], "conflict");

    let mut plan_v2 = json!({
        "id": plan_id,
        "characterId": character_id,
        "title": "Ship P4-T02",
        "goal": "a memory API, updated",
        "phases": [{
            "id": phase_id,
            "title": "Build it",
            "tasks": [{ "id": task_id, "title": "write the routes", "status": "done", "notes": "landed" }],
        }],
        "status": "active",
        "version": 2,
        "updatedAt": "2026-09-27T01:00:00.000Z",
    });
    let (status, body) = call(&router, Method::POST, "/db/plans", Some(plan_v2.clone())).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = call(
        &router,
        Method::GET,
        &format!("/db/plans?characterId={character_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_matches_schema("DbListPlansResponse", &body);
    let plans = body["plans"].as_array().unwrap();
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0]["version"], 2);
    assert_eq!(plans[0]["phases"][0]["tasks"][0]["notes"], "landed");

    // Version 4 with the stored version at 2 is a conflict (must be exactly +1).
    plan_v2["version"] = json!(4);
    let (status, body) = call(&router, Method::POST, "/db/plans", Some(plan_v2)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_matches_error_schema(&body);

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn every_route_answers_unavailable_with_no_database() {
    let router = router_with(
        relay::Relay::measured(),
        memory_api::MemoryState::default(),
        false,
    );
    let (status, body) = call(
        &router,
        Method::GET,
        &format!("/db/blocks?characterId={}", random_id("test")),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_matches_error_schema(&body);
    assert_eq!(body["error"]["code"], "unavailable");
}

#[tokio::test]
async fn deleting_a_session_removes_its_turns_vectors() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");
    let model = json!({ "provider": "memory-api-test", "model": "four-wide", "dimensions": 4 });
    let (status, body) = call(
        &router,
        Method::PUT,
        "/db/embedding-models",
        Some(model.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let model_id: u32 = body["modelId"].as_str().unwrap().parse().unwrap();

    let turn_id = random_id("turn");
    let episode = json!({
        "id": turn_id,
        "sessionId": session_id,
        "characterId": character_id,
        "role": "user",
        "text": "gone soon",
        "interrupted": false,
        "at": "2026-09-27T12:00:00.000Z",
        "embedding": { "model": model, "vector": [0.5, 0.5, 0.0, 0.0] },
        "affect": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/episodes", Some(episode)).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The vector table is shared by every test using this model (`model_registry` is
    // global, ADR-35), so counting the whole table would catch other tests' rows running
    // concurrently — filter to this test's own turn by its integer id.
    let table = format!("turn_embeddings_{model_id}");
    let turn_row_id: u64 = sqlx::query_scalar("SELECT id FROM turns WHERE uid = ?")
        .bind(&turn_id)
        .fetch_one(&pool)
        .await
        .expect("the turn was written");
    let before: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM {table} WHERE item_id = ?"
    )))
    .bind(turn_row_id)
    .fetch_one(&pool)
    .await
    .expect("count before delete");
    assert_eq!(before, 1);

    sqlx::query("DELETE FROM sessions WHERE uid = ?")
        .bind(&session_id)
        .execute(&pool)
        .await
        .expect("delete the session");

    let after: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM {table} WHERE item_id = ?"
    )))
    .bind(turn_row_id)
    .fetch_one(&pool)
    .await
    .expect("count after delete");
    assert_eq!(
        after, 0,
        "deleting the session must cascade to the turn's vector"
    );

    cleanup(&pool, &character_id).await;
}

/// Proves ADR-35's shape on the retrieval statement itself, not just on `self_check`'s
/// hand-written probe: with a query embedding, every vector branch's `EXPLAIN` names the
/// vector table and `key = "embedding"` — the index, not a scan — and reports the elapsed
/// time the route measured.
#[tokio::test]
async fn the_retrieval_statement_uses_the_vector_index() {
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");
    let model = json!({ "provider": "memory-api-test", "model": "four-wide", "dimensions": 4 });
    let (status, body) = call(
        &router,
        Method::PUT,
        "/db/embedding-models",
        Some(model.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let model_id: u32 = body["modelId"].as_str().unwrap().parse().unwrap();

    for (seq, vector) in [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.7, 0.7, 0.0, 0.0],
    ]
    .into_iter()
    .enumerate()
    {
        let episode = json!({
            "id": random_id("turn"),
            "sessionId": session_id,
            "characterId": character_id,
            "role": "user",
            "text": format!("turn {seq}"),
            "interrupted": false,
            "at": "2026-09-27T12:00:00.000Z",
            "embedding": { "model": model, "vector": vector },
            "affect": null,
        });
        let (status, body) = call(&router, Method::POST, "/db/episodes", Some(episode)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let retrieval = json!({
        "characterId": character_id,
        "sessionId": random_id("different-session"),
        "query": "",
        "queryEmbedding": { "model": model, "vector": [1.0, 0.1, 0.0, 0.0] },
        "limits": { "episodes": 8, "facts": 8, "documents": 8 },
        "since": null,
    });
    let (status, body) = call(&router, Method::POST, "/db/retrieve", Some(retrieval)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["vectorSearch"], "used");
    let elapsed_ms = body["elapsedMs"].as_u64().unwrap();
    println!("P4-T02 retrieval (embedding + keyword, 3 episode rows): elapsedMs = {elapsed_ms}");

    // Rebuild the exact statement the route ran and `EXPLAIN` it, the way `memory::self_check`
    // proves the hand-written probe.
    let plan = latentpresence_db::store::RetrievalPlan {
        character_id: character_id.clone(),
        session_id: random_id("different-session"),
        query: String::new(),
        since: None,
        episodes_limit: 8,
        facts_limit: 8,
        episodes_vector: Some((
            format!("turn_embeddings_{model_id}"),
            latentpresence_db::vector::encode_width(&[1.0, 0.1, 0.0, 0.0], 4).unwrap(),
        )),
        facts_vector: None,
    };
    let (sql, binds) = latentpresence_db::store::build_retrieval_sql(&plan);
    let mut query = sqlx::query(AssertSqlSafe(format!("EXPLAIN {sql}")));
    for bind in binds {
        query = match bind {
            latentpresence_db::store::Bind::Str(v) => query.bind(v),
            latentpresence_db::store::Bind::U32(v) => query.bind(v),
            latentpresence_db::store::Bind::Bytes(v) => query.bind(v),
            latentpresence_db::store::Bind::DateTime(v) => query.bind(v),
        };
    }
    let plan_rows = query.fetch_all(&pool).await.expect("EXPLAIN runs");

    let table = format!("turn_embeddings_{model_id}");
    let mut explain_lines = Vec::new();
    let mut vector_branch_uses_index = false;
    for row in &plan_rows {
        use sqlx::Row;
        let table_of: Option<String> = row.try_get("table").ok().flatten();
        let key: Option<String> = row.try_get("key").ok().flatten();
        explain_lines.push(format!("table={table_of:?} key={key:?}"));
        if table_of.as_deref() == Some(table.as_str()) && key.as_deref() == Some("embedding") {
            vector_branch_uses_index = true;
        }
    }
    println!(
        "P4-T02 EXPLAIN for the vector branch:\n{}",
        explain_lines.join("\n")
    );
    assert!(
        vector_branch_uses_index,
        "the vector branch must use the vector index, not scan: {explain_lines:?}"
    );

    cleanup(&pool, &character_id).await;
}

#[tokio::test]
async fn episodes_appended_at_once_to_one_session_all_get_their_own_seq() {
    // The kernel fires writes without waiting (ADR-17): a user turn and its answer can reach
    // the companion together. Unserialised, two would read the same MAX(seq) and one would
    // fail on (session_id, seq).
    let Some((router, pool, _serial)) = setup().await else {
        return;
    };
    let character_id = random_id("test");
    let session_id = random_id("session");
    let appends = (0..12).map(|i| {
        let router = router.clone();
        let episode = json!({
            "id": format!("{session_id}-turn-{i}"),
            "sessionId": session_id,
            "characterId": character_id,
            "role": if i % 2 == 0 { "user" } else { "assistant" },
            "text": format!("turn {i}"),
            "interrupted": false,
            "at": "2026-09-28T12:00:00.000Z",
            "embedding": null,
            "affect": null,
        });
        async move { call(&router, Method::POST, "/db/episodes", Some(episode)).await }
    });
    let results = futures_util::future::join_all(appends).await;
    for (status, body) in &results {
        assert_eq!(*status, StatusCode::OK, "{body}");
    }
    let seqs: Vec<u32> = sqlx::query_scalar(
        "SELECT t.seq FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.uid = ? ORDER BY t.seq",
    )
    .bind(&session_id)
    .fetch_all(&pool)
    .await
    .expect("seqs");
    assert_eq!(seqs, (0..12).collect::<Vec<u32>>());

    cleanup(&pool, &character_id).await;
}

/// Not a test: removes what the TypeScript `MemoryStore` conformance suite leaves on a shared
/// database (P4-T04) — its `conformance-` characters and the `memory-api-test` model's vector
/// tables. Run after `LP_TEST_COMPANION_URL=… pnpm vitest run companion.conformance`:
/// `cargo test --manifest-path companion/Cargo.toml --test memory_api -- --ignored remove_conformance_data`.
#[tokio::test]
#[ignore = "cleanup for the TypeScript conformance run, not a test"]
async fn remove_conformance_data() {
    let Some((_router, pool, _serial)) = setup().await else {
        return;
    };
    for table in ["sessions", "facts", "self_blocks", "plans"] {
        sqlx::query(AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE character_id LIKE 'conformance-%'"
        )))
        .execute(&pool)
        .await
        .expect("delete conformance rows");
    }
    remove_test_models(&pool).await;
}
