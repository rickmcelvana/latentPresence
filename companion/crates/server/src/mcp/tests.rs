//! The host against a fake MCP server spoken over an in-memory pipe: the real `rmcp` client,
//! the real routes, no process. `tests/mcp_api.rs` checks the same answers against the
//! committed OpenAPI file.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tower::ServiceExt as _;

/// One MCP server over newline-delimited JSON-RPC: `echo` answers its text, `fail` is an
/// `isError`, `picture` is an image, `quit` closes the pipe. Returns the client's end.
pub(crate) fn fake_server() -> tokio::io::DuplexStream {
    let (client, server) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let (read, mut write) = tokio::io::split(server);
        let mut lines = BufReader::new(read).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let message: Value = serde_json::from_str(&line).expect("json-rpc");
            let Some(id) = message.get("id").cloned() else {
                continue; // a notification
            };
            let result = match message["method"].as_str().unwrap_or("") {
                "initialize" => json!({
                    "protocolVersion": message["params"]["protocolVersion"],
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "fake", "version": "1" },
                    "instructions": "Echoes."
                }),
                "tools/list" => json!({ "tools": [
                    { "name": "echo", "description": "Say it back.", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } }, "annotations": { "readOnlyHint": true, "colour": "teal" } },
                    { "name": "fail", "inputSchema": { "type": "object" } },
                    { "name": "picture", "inputSchema": { "type": "object" } },
                    { "name": "quit", "inputSchema": { "type": "object" } }
                ] }),
                "tools/call" => match message["params"]["name"].as_str().unwrap_or("") {
                    "echo" => {
                        json!({ "content": [{ "type": "text", "text": message["params"]["arguments"]["text"] }], "isError": false })
                    }
                    "fail" => {
                        json!({ "content": [{ "type": "text", "text": "No such repository." }], "isError": true })
                    }
                    "picture" => {
                        json!({ "content": [{ "type": "image", "data": "AA==", "mimeType": "image/png" }, { "type": "text", "text": "A cat." }], "structuredContent": { "cats": 1 } })
                    }
                    _ => return,
                },
                _ => json!({}),
            };
            let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            write
                .write_all(format!("{reply}\n").as_bytes())
                .await
                .expect("write");
        }
    });
    client
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, Value) {
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn call_request(server: &str, name: &str, arguments: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/mcp/call")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "callId": "c1", "serverId": server, "name": name, "arguments": arguments })
                .to_string(),
        ))
        .expect("request builds")
}

async fn hosted() -> (SharedHost, Router) {
    let host = SharedHost::default();
    host.attach("fake", fake_server()).await;
    let router = router(host.clone());
    (host, router)
}

#[tokio::test]
async fn lists_a_connected_server_and_its_tools_with_only_the_hints_the_contract_names() {
    let (_host, router) = hosted().await;
    let (status, body) = send(
        &router,
        Request::get("/mcp/tools")
            .body(Body::empty())
            .expect("builds"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["servers"],
        json!([{ "id": "fake", "label": "fake", "kind": "stdio", "state": "ready", "detail": null, "instructions": "Echoes." }])
    );
    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(names, ["echo", "fail", "picture", "quit"]);
    assert_eq!(body["tools"][0]["serverId"], "fake");
    assert_eq!(
        body["tools"][0]["annotations"],
        json!({ "readOnlyHint": true })
    );
    assert_eq!(body["tools"][1]["description"], "");
    assert_eq!(body["tools"][1]["annotations"], Value::Null);
}

#[tokio::test]
async fn calls_a_tool_and_flattens_what_it_said() {
    let (_host, router) = hosted().await;
    let (status, body) = send(
        &router,
        call_request("fake", "echo", json!({ "text": "hello" })),
    )
    .await;
    assert_eq!(
        (status, body),
        (
            StatusCode::OK,
            json!({ "isError": false, "text": "hello", "structured": null, "images": 0 })
        )
    );
    let (_, body) = send(&router, call_request("fake", "fail", json!({}))).await;
    assert_eq!(
        body,
        json!({ "isError": true, "text": "No such repository.", "structured": null, "images": 0 })
    );
    let (_, body) = send(&router, call_request("fake", "picture", json!({}))).await;
    assert_eq!(
        body,
        json!({ "isError": false, "text": "A cat.", "structured": { "cats": 1 }, "images": 1 })
    );
}

#[tokio::test]
async fn refuses_what_it_does_not_run_and_reports_a_server_that_stopped() {
    let (host, router) = hosted().await;
    let (status, body) = send(&router, call_request("nobody", "echo", json!({}))).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("not_found"))
    );
    let (status, _) = send(&router, call_request("fake", "rm_rf", json!({}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = send(&router, call_request("fake", "quit", json!({}))).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::BAD_GATEWAY, Some("upstream"))
    );
    let (status, body) = send(
        &router,
        call_request("fake", "echo", json!({ "text": "again" })),
    )
    .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("unavailable"))
    );
    assert_eq!(host.report().servers[0].state, "failed");
    let (status, _) = send(
        &router,
        Request::post("/mcp/call")
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .expect("builds"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_bad_entry_and_a_command_that_is_not_there_are_reported_failed_with_why() {
    let config = McpConfig::parse(
        r#"{ "mcpServers": {
            "broken": {},
            "ghost": { "command": "latentpresence-no-such-command-anywhere" }
        } }"#,
    )
    .expect("parses");
    let host = McpHost::start(config);
    let mut report = host.report();
    for _ in 0..100 {
        if report
            .servers
            .iter()
            .all(|server| server.state != "starting")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        report = host.report();
    }
    let states: Vec<(&str, &str)> = report
        .servers
        .iter()
        .map(|server| (server.id.as_str(), server.state))
        .collect();
    assert_eq!(states, [("broken", "failed"), ("ghost", "failed")]);
    assert!(
        report.servers[0]
            .detail
            .as_deref()
            .is_some_and(|why| why.contains("needs a command or a url"))
    );
    assert!(
        report.servers[1]
            .detail
            .as_deref()
            .is_some_and(|why| why.contains("could not be started")),
        "{:?}",
        report.servers[1].detail
    );
}

#[tokio::test]
async fn files_is_listed_first_and_called_through_the_same_route() {
    let root = std::env::temp_dir().join(format!("lp-mcp-host-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("mkdir");
    std::fs::write(root.join("note.txt"), "Water the basil.").expect("write");
    let host = McpHost::start(McpConfig {
        servers: vec![],
        roots: vec![root.clone()],
        ..McpConfig::default()
    });
    let router = router(host);
    let (_, listed) = send(
        &router,
        Request::get("/mcp/tools")
            .body(Body::empty())
            .expect("builds"),
    )
    .await;
    assert_eq!(listed["servers"][0]["id"], "files");
    assert_eq!(listed["servers"][0]["label"], "Files");
    assert_eq!(listed["servers"][0]["kind"], "files");
    assert_eq!(listed["tools"].as_array().map(Vec::len), Some(5));
    let (status, body) = send(
        &router,
        call_request("files", "read_text_file", json!({ "path": "note.txt" })),
    )
    .await;
    assert_eq!(
        (status, body["text"].as_str()),
        (StatusCode::OK, Some("Water the basil."))
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn flattens_a_result_as_the_page_adapter_does() {
    let outcome = CallOutcome::flatten(&json!({
        "content": [
            { "type": "text", "text": "One." },
            { "type": "resource", "resource": { "uri": "file:///a", "text": "Two." } },
            { "type": "resource_link", "uri": "https://example.com/b", "name": "b" },
            { "type": "audio", "data": "", "mimeType": "audio/wav" }
        ]
    }));
    assert_eq!(
        outcome,
        CallOutcome {
            is_error: false,
            text: "One.\n\nTwo.\n\n(link: https://example.com/b)".into(),
            structured: None,
            images: 1
        }
    );
}

#[test]
fn a_server_gets_a_path_and_a_home_from_the_companion_and_no_secret() {
    let env = inherited_env(|name| match name {
        "PATH" | "HOME" | "USERPROFILE" => Some("x".into()),
        _ => Some("leaked".into()),
    });
    assert!(env.iter().any(|(name, _)| *name == "PATH"));
    assert!(
        env.iter()
            .all(|(name, _)| !name.contains("KEY") && *name != "DATABASE_URL")
    );
    assert!(env.len() < 20);
}

#[cfg(windows)]
#[test]
fn a_bare_command_is_found_through_pathext_on_windows() {
    let found = resolve_command("cmd");
    assert!(
        found.is_absolute()
            && found
                .extension()
                .is_some_and(|extension| extension == "exe"),
        "{}",
        found.display()
    );
    assert_eq!(
        resolve_command("C:\\tools\\x"),
        std::path::PathBuf::from("C:\\tools\\x")
    );
}

/// `instance` in the shape the page parses: the committed OpenAPI file, generated from zod.
fn check(name: &str, instance: &Value) {
    const OPENAPI_JSON: &str =
        include_str!("../../../../../packages/protocol/src/generated/companion.openapi.json");
    let doc: Value = serde_json::from_str(OPENAPI_JSON).expect("valid json");
    let schema = doc
        .pointer(&format!("/components/schemas/{name}"))
        .unwrap_or_else(|| panic!("no schema {name}"))
        .clone();
    let validator = jsonschema::validator_for(&schema).expect("schema compiles");
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|error| error.to_string())
        .collect();
    assert!(errors.is_empty(), "{name}: {errors:?}\n{instance}");
}

/// Every answer in the shape the page parses.
#[tokio::test]
async fn every_answer_matches_the_contract() {
    let root = std::env::temp_dir().join(format!("lp-mcp-contract-{}", std::process::id()));
    std::fs::create_dir_all(&root).expect("mkdir");
    let host = McpHost::start(
        McpConfig::parse(r#"{ "mcpServers": { "broken": {} } }"#)
            .map(|config| McpConfig {
                roots: vec![root.clone()],
                ..config
            })
            .expect("parses"),
    );
    host.attach("fake", fake_server()).await;
    let router = router(host);
    let (_, listed) = send(
        &router,
        Request::get("/mcp/tools")
            .body(Body::empty())
            .expect("builds"),
    )
    .await;
    check("McpToolsResponse", &listed);
    for (server, name) in [
        ("fake", "echo"),
        ("fake", "picture"),
        ("files", "list_directory"),
    ] {
        let (status, body) =
            send(&router, call_request(server, name, json!({ "text": "x" }))).await;
        assert_eq!(status, StatusCode::OK);
        check("McpCallResponse", &body);
    }
    for (server, name) in [("nobody", "echo"), ("broken", "echo"), ("fake", "quit")] {
        let (_, body) = send(&router, call_request(server, name, json!({}))).await;
        check("CompanionError", &body);
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// A SQLite file with a few herbs in it, written the ordinary way, for a database entry to open.
async fn garden_file(dir: &std::path::Path) -> std::path::PathBuf {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePool};
    let path = dir.join("garden.sqlite");
    let pool = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true),
    )
    .await
    .expect("opens");
    for statement in [
        "CREATE TABLE herbs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, note TEXT)",
        "INSERT INTO herbs (name, price, note) VALUES ('Basil', 2.5, 'sun'), ('Sage', 3.0, NULL), ('Yarrow', 1.75, 'a|b')",
    ] {
        sqlx::query(statement).execute(&pool).await.expect("writes");
    }
    pool.close().await;
    path
}

async fn ready(router: &Router, id: &str) -> Value {
    for _ in 0..100 {
        let (_, listed) = send(
            router,
            Request::get("/mcp/tools")
                .body(Body::empty())
                .expect("builds"),
        )
        .await;
        let state = listed["servers"]
            .as_array()
            .and_then(|servers| servers.iter().find(|server| server["id"] == id))
            .map(|server| server["state"].clone());
        if state != Some(json!("starting")) {
            return listed;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{id} never finished starting");
}

#[tokio::test]
async fn a_database_is_its_own_server_and_its_tools_read_but_never_write() {
    let dir = tempfile::tempdir().expect("temp dir");
    let file = garden_file(dir.path()).await;
    let config = McpConfig::parse(
        &json!({ "databases": {
            "garden": { "path": file, "description": "what grows where" },
            "nowhere": { "path": dir.path().join("missing.sqlite") },
            "odd": { "url": "oracle://reader:s3cret@db" }
        } })
        .to_string(),
    )
    .expect("parses");
    let router = router(McpHost::start(config));
    ready(&router, "sql:nowhere").await;
    let listed = ready(&router, "sql:garden").await;
    check("McpToolsResponse", &listed);
    let server = |id: &str| {
        listed["servers"]
            .as_array()
            .and_then(|servers| servers.iter().find(|server| server["id"] == id))
            .cloned()
            .expect("listed")
    };
    let garden = server("sql:garden");
    assert_eq!(
        (&garden["label"], &garden["kind"], &garden["state"]),
        (&json!("garden"), &json!("sql"), &json!("ready"))
    );
    let instructions = garden["instructions"].as_str().expect("instructions");
    assert!(
        instructions.contains("SQLite") && instructions.contains("what grows where"),
        "{instructions}"
    );
    assert_eq!(server("sql:nowhere")["state"], "failed");
    assert!(
        server("sql:nowhere")["detail"]
            .as_str()
            .is_some_and(|why| why.contains("there is no file"))
    );
    let odd = server("sql:odd")["detail"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    assert!(odd.contains("oracle:") && !odd.contains("s3cret"), "{odd}");
    let tools: Vec<&str> = listed["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter(|tool| tool["serverId"] == "sql:garden")
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(tools, ["describe", "query"]);

    let said = |body: &Value| body["text"].as_str().unwrap_or("").to_owned();
    let (status, all) = send(&router, call_request("sql:garden", "describe", json!({}))).await;
    assert_eq!(status, StatusCode::OK);
    check("McpCallResponse", &all);
    assert!(
        said(&all).contains("herbs: id integer, name text, price real, note text"),
        "{}",
        said(&all)
    );
    let (_, one) = send(
        &router,
        call_request("sql:garden", "describe", json!({ "table": "HERBS" })),
    )
    .await;
    assert!(
        said(&one).contains("1 | Basil | 2.5 | sun"),
        "{}",
        said(&one)
    );
    let (_, asked) = send(
        &router,
        call_request(
            "sql:garden",
            "query",
            json!({ "sql": "SELECT name, note FROM herbs WHERE price < 3 ORDER BY name" }),
        ),
    )
    .await;
    assert_eq!(asked["isError"], false);
    assert_eq!(
        said(&asked),
        "name | note\nBasil | sun\nYarrow | a\\|b\n[2 rows]"
    );
    for sql in [
        "DROP TABLE herbs",
        "SELECT 1; DELETE FROM herbs",
        "ATTACH DATABASE 'elsewhere.db' AS e",
    ] {
        let (_, refused) = send(
            &router,
            call_request("sql:garden", "query", json!({ "sql": sql })),
        )
        .await;
        assert_eq!(refused["isError"], true, "{sql}");
        assert!(
            said(&refused).starts_with("Not run: "),
            "{}",
            said(&refused)
        );
    }
    let (_, missing) = send(
        &router,
        call_request("sql:garden", "describe", json!({ "table": "weeds" })),
    )
    .await;
    assert!(said(&missing).contains("no table called weeds. It has: herbs"));
    let (_, broken) = send(
        &router,
        call_request(
            "sql:garden",
            "query",
            json!({ "sql": "SELECT nope FROM herbs" }),
        ),
    )
    .await;
    assert!(
        said(&broken).starts_with("The database said: ") && said(&broken).contains("nope"),
        "{}",
        said(&broken)
    );
    let (_, counted) = send(
        &router,
        call_request(
            "sql:garden",
            "query",
            json!({ "sql": "SELECT COUNT(*) AS herbs FROM herbs" }),
        ),
    )
    .await;
    assert_eq!(said(&counted), "herbs\n3\n[1 row]");
}
