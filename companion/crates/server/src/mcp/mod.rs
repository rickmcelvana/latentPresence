//! The companion's MCP host (P5-T02, ADR-43): the servers the person's own `mcp.json` names,
//! started when the companion starts, and its own read-only Files server — offered to the page
//! through `/mcp/tools` and `/mcp/call`.
//!
//! **Never on a page's request.** A page names a server the file named and a tool it listed;
//! nothing it sends becomes a command line. The gate — ask, always, never — is the page's
//! (ADR-42); this host only runs what was asked of it.

pub mod config;
pub mod files;
pub mod sql;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::extract::State;
use axum::{Json, Router, routing::get, routing::post};
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::IntoTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::memory_api::ApiError;
use config::{FILES_ID, McpConfig, SQL_PREFIX, ServerSpec};
use files::FilesServer;
use sql::SqlServer;

/// A first `npx` downloads its package before it answers.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
/// Longer than the page waits for a person to answer the gate, so the page gives up first.
const CALL_TIMEOUT: Duration = Duration::from_secs(180);
/// How much of a server's stderr is kept to say why it stopped.
const STDERR_LINES: usize = 12;

/// A tool as `/mcp/tools` reports it, less its server.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub annotations: Option<Value>,
}

impl ToolInfo {
    pub fn new(name: &str, description: &str, input_schema: Value, annotations: Value) -> Self {
        Self {
            name: name.to_owned(),
            description: description.to_owned(),
            input_schema,
            annotations: Some(annotations),
        }
    }

    /// From a server's `tools/list` entry as JSON: the hints the contract names, nothing else.
    fn from_listed(tool: &Value) -> Option<Self> {
        let name = tool.get("name")?.as_str()?.to_owned();
        let annotations =
            tool.get("annotations")
                .and_then(Value::as_object)
                .map(|hints| {
                    let kept: serde_json::Map<String, Value> = hints
                        .iter()
                        .filter(|(key, value)| match key.as_str() {
                            "title" => value.is_string(),
                            "readOnlyHint" | "destructiveHint" | "idempotentHint"
                            | "openWorldHint" => value.is_boolean(),
                            _ => false,
                        })
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect();
                    Value::Object(kept)
                });
        let input_schema = match tool.get("inputSchema") {
            Some(Value::Object(schema)) => Value::Object(schema.clone()),
            _ => serde_json::json!({ "type": "object" }),
        };
        Some(Self {
            name,
            description: tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            input_schema,
            annotations,
        })
    }
}

/// `McpCallResultSchema`: what a call returned, flattened as the page's own adapter does.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallOutcome {
    pub is_error: bool,
    pub text: String,
    pub structured: Option<Value>,
    pub images: u32,
}

impl CallOutcome {
    pub fn text(is_error: bool, text: impl Into<String>) -> Self {
        Self {
            is_error,
            text: text.into(),
            structured: None,
            images: 0,
        }
    }

    /// A `tools/call` result as JSON: text joined, resources by their text or link, images
    /// counted — `flattenCallResult` in `packages/providers/src/mcp/client.ts`, in Rust.
    pub fn flatten(result: &Value) -> Self {
        let mut parts = Vec::new();
        let mut images = 0;
        let content = result.get("content").and_then(Value::as_array);
        for item in content.into_iter().flatten() {
            let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
            match kind {
                "text" => parts.extend(item.get("text").and_then(Value::as_str).map(str::to_owned)),
                "resource" => parts.extend(
                    item.pointer("/resource/text")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                ),
                "resource_link" => parts.extend(
                    item.get("uri")
                        .and_then(Value::as_str)
                        .map(|uri| format!("(link: {uri})")),
                ),
                "image" | "audio" => images += 1,
                _ => {}
            }
        }
        Self {
            is_error: result.get("isError").and_then(Value::as_bool) == Some(true),
            text: parts.join("\n\n"),
            structured: result.get("structuredContent").cloned(),
            images,
        }
    }
}

type Client = RunningService<RoleClient, ()>;

#[derive(Clone)]
enum Connection {
    Mcp(Arc<Client>),
    Files(Arc<FilesServer>),
    Sql(Arc<SqlServer>),
}

#[derive(Clone)]
enum ServerState {
    Starting,
    Ready {
        connection: Connection,
        tools: Vec<ToolInfo>,
        instructions: Option<String>,
    },
    Failed(String),
}

struct Hosted {
    id: String,
    kind: &'static str,
    state: RwLock<ServerState>,
}

impl Hosted {
    fn state(&self) -> ServerState {
        self.state
            .read()
            .map(|state| state.clone())
            .unwrap_or(ServerState::Failed("its state was lost".into()))
    }

    fn set(&self, next: ServerState) {
        if let Ok(mut state) = self.state.write() {
            *state = next;
        }
    }
}

/// Every server the companion hosts, in the order `/mcp/tools` reports them.
#[derive(Default)]
pub struct McpHost {
    servers: RwLock<Vec<Arc<Hosted>>>,
}

pub type SharedHost = Arc<McpHost>;

impl McpHost {
    /// Files first, then the file's servers in name order, each connecting in the background.
    pub fn start(config: McpConfig) -> SharedHost {
        let host = Arc::new(Self::default());
        if !config.roots.is_empty() {
            let (files, problems) = FilesServer::new(&config.roots);
            for problem in &problems {
                eprintln!("companion: mcp files root skipped: {problem}");
            }
            let state = if files.has_roots() {
                ready_files(files)
            } else {
                ServerState::Failed(format!(
                    "none of its folders could be opened: {}",
                    problems.join("; ")
                ))
            };
            host.push(FILES_ID, "files", state);
        }
        // P5-T05 (ADR-46): each database is a server of its own, opened in the background.
        for (name, spec) in config.databases {
            let hosted = host.push(&format!("{SQL_PREFIX}{name}"), "sql", ServerState::Starting);
            tokio::spawn(async move {
                hosted.set(match SqlServer::connect(&name, &spec).await {
                    Ok(server) => ServerState::Ready {
                        tools: server.tools(),
                        instructions: Some(server.instructions()),
                        connection: Connection::Sql(Arc::new(server)),
                    },
                    Err(why) => ServerState::Failed(why),
                });
            });
        }
        for (name, spec) in config.servers {
            match spec {
                ServerSpec::Invalid(why) => {
                    host.push(
                        &name,
                        "stdio",
                        ServerState::Failed(format!("mcp.json: {why}")),
                    );
                }
                ServerSpec::Stdio { command, args, env } => {
                    let hosted = host.push(&name, "stdio", ServerState::Starting);
                    tokio::spawn(async move {
                        let stderr = Arc::new(Mutex::new(VecDeque::new()));
                        let outcome =
                            match spawn_stdio(&name, &command, &args, &env, stderr.clone()) {
                                Ok(process) => connect(process).await,
                                Err(error) => {
                                    Err(format!("{command} could not be started: {error}"))
                                }
                            };
                        hosted.set(settle(outcome, &stderr));
                    });
                }
                ServerSpec::Http { url, headers } => {
                    let hosted = host.push(&name, "http", ServerState::Starting);
                    tokio::spawn(async move {
                        let outcome = match http_transport(&url, &headers) {
                            Ok(transport) => connect(transport).await,
                            Err(why) => Err(why),
                        };
                        hosted.set(settle(outcome, &Mutex::default()));
                    });
                }
            }
        }
        host
    }

    fn push(&self, id: &str, kind: &'static str, state: ServerState) -> Arc<Hosted> {
        let hosted = Arc::new(Hosted {
            id: id.to_owned(),
            kind,
            state: RwLock::new(state),
        });
        if let Ok(mut servers) = self.servers.write() {
            servers.push(hosted.clone());
        }
        hosted
    }

    /// Connect a server over any transport and wait for it: what tests use in place of a process.
    pub async fn attach<T, E, A>(&self, id: &str, transport: T)
    where
        T: IntoTransport<RoleClient, E, A> + Send + 'static,
        E: std::error::Error + Send + Sync + 'static,
    {
        let hosted = self.push(id, "stdio", ServerState::Starting);
        hosted.set(settle(connect(transport).await, &Mutex::default()));
    }

    fn find(&self, id: &str) -> Option<Arc<Hosted>> {
        self.servers
            .read()
            .ok()?
            .iter()
            .find(|hosted| hosted.id == id)
            .cloned()
    }

    /// Close every server it started: the processes go with their connections.
    pub async fn shutdown(&self) {
        let servers: Vec<Arc<Hosted>> = self
            .servers
            .read()
            .map(|servers| servers.clone())
            .unwrap_or_default();
        for hosted in servers {
            if let ServerState::Ready { connection, .. } = hosted.state() {
                match connection {
                    Connection::Mcp(client) => {
                        hosted.set(ServerState::Failed("the companion stopped".into()));
                        client.cancellation_token().cancel();
                    }
                    Connection::Sql(server) => {
                        hosted.set(ServerState::Failed("the companion stopped".into()));
                        server.close().await;
                    }
                    Connection::Files(_) => {}
                }
            }
        }
    }

    fn report(&self) -> ToolsResponse {
        let servers: Vec<Arc<Hosted>> = self
            .servers
            .read()
            .map(|servers| servers.clone())
            .unwrap_or_default();
        let mut response = ToolsResponse::default();
        for hosted in servers {
            let (state, detail, instructions) = match hosted.state() {
                ServerState::Starting => ("starting", None, None),
                ServerState::Failed(why) => ("failed", Some(why), None),
                ServerState::Ready {
                    tools,
                    instructions,
                    ..
                } => {
                    response.tools.extend(tools.into_iter().map(|tool| ToolOut {
                        server_id: hosted.id.clone(),
                        name: tool.name,
                        description: tool.description,
                        input_schema: tool.input_schema,
                        annotations: tool.annotations,
                    }));
                    ("ready", None, instructions)
                }
            };
            response.servers.push(ServerOut {
                label: if hosted.id == FILES_ID {
                    "Files".into()
                } else {
                    // A database is named as the person named it.
                    hosted
                        .id
                        .strip_prefix(SQL_PREFIX)
                        .unwrap_or(&hosted.id)
                        .to_owned()
                },
                id: hosted.id.clone(),
                kind: hosted.kind,
                state,
                detail,
                instructions,
            });
        }
        response
    }

    async fn call(&self, request: CallRequest) -> Result<CallOutcome, ApiError> {
        let hosted = self.find(&request.server_id).ok_or_else(|| {
            ApiError::NotFound(format!(
                "the companion runs no server called {}",
                request.server_id
            ))
        })?;
        let (connection, tools) = match hosted.state() {
            ServerState::Ready {
                connection, tools, ..
            } => (connection, tools),
            ServerState::Starting => {
                return Err(ApiError::NotReady(format!(
                    "{} is still starting",
                    hosted.id
                )));
            }
            ServerState::Failed(why) => {
                return Err(ApiError::NotReady(format!(
                    "{} is not running: {why}",
                    hosted.id
                )));
            }
        };
        if !tools.iter().any(|tool| tool.name == request.name) {
            return Err(ApiError::NotFound(format!(
                "{} has no tool called {}",
                hosted.id, request.name
            )));
        }
        match connection {
            Connection::Files(files) => {
                let args = request.arguments;
                let name = request.name;
                tokio::task::spawn_blocking(move || files.call(&name, &args))
                    .await
                    .map_err(|error| ApiError::Internal(error.to_string()))
            }
            Connection::Sql(server) => Ok(server.call(&request.name, &request.arguments).await),
            Connection::Mcp(client) => {
                let params =
                    CallToolRequestParams::new(request.name).with_arguments(request.arguments);
                match tokio::time::timeout(CALL_TIMEOUT, client.call_tool(params)).await {
                    Ok(Ok(result)) => Ok(CallOutcome::flatten(
                        &serde_json::to_value(&result).unwrap_or(Value::Null),
                    )),
                    Ok(Err(error)) => {
                        if matches!(error, rmcp::ServiceError::TransportClosed) {
                            hosted.set(ServerState::Failed("it stopped".into()));
                        }
                        Err(ApiError::Upstream(format!("{} failed: {error}", hosted.id)))
                    }
                    Err(_) => Err(ApiError::Upstream(format!(
                        "{} did not answer within {} s",
                        hosted.id,
                        CALL_TIMEOUT.as_secs()
                    ))),
                }
            }
        }
    }
}

fn ready_files(files: FilesServer) -> ServerState {
    ServerState::Ready {
        connection: Connection::Files(Arc::new(files)),
        tools: FilesServer::tools(),
        instructions: Some(
            "Read-only: folders on this computer the person chose. List the allowed folders first."
                .into(),
        ),
    }
}

type Connected = (Client, Vec<ToolInfo>, Option<String>);

async fn connect<T, E, A>(transport: T) -> Result<Connected, String>
where
    T: IntoTransport<RoleClient, E, A> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    let work = async {
        let client = ().serve(transport).await.map_err(|error| error.to_string())?;
        let listed = client
            .list_all_tools()
            .await
            .map_err(|error| error.to_string())?;
        let tools = listed
            .iter()
            .filter_map(|tool| ToolInfo::from_listed(&serde_json::to_value(tool).ok()?))
            .collect();
        let instructions = client
            .peer_info()
            .and_then(|info| info.instructions.clone());
        Ok((client, tools, instructions))
    };
    tokio::time::timeout(CONNECT_TIMEOUT, work)
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "it did not answer within {} s",
                CONNECT_TIMEOUT.as_secs()
            ))
        })
}

/// The state a connection attempt leaves, with the server's last words when it failed.
fn settle(outcome: Result<Connected, String>, stderr: &Mutex<VecDeque<String>>) -> ServerState {
    match outcome {
        Ok((client, tools, instructions)) => ServerState::Ready {
            connection: Connection::Mcp(Arc::new(client)),
            tools,
            instructions,
        },
        Err(why) => {
            let said: Vec<String> = stderr
                .lock()
                .map(|lines| lines.iter().cloned().collect())
                .unwrap_or_default();
            ServerState::Failed(if said.is_empty() {
                why
            } else {
                format!("{why} — it said: {}", said.join(" | "))
            })
        }
    }
}

fn spawn_stdio(
    name: &str,
    command: &str,
    args: &[String],
    env: &std::collections::BTreeMap<String, String>,
    stderr: Arc<Mutex<VecDeque<String>>>,
) -> std::io::Result<TokioChildProcess> {
    let mut process = tokio::process::Command::new(resolve_command(command));
    process
        .args(args)
        .env_clear()
        .envs(inherited_env(|name| std::env::var_os(name)))
        .envs(env)
        .kill_on_drop(true);
    let (child, err) = TokioChildProcess::builder(process)
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    if let Some(err) = err {
        let name = name.to_owned();
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[mcp {name}] {line}");
                if let Ok(mut kept) = stderr.lock() {
                    if kept.len() == STDERR_LINES {
                        kept.pop_front();
                    }
                    kept.push_back(line);
                }
            }
        });
    }
    Ok(child)
}

/// What a server is started with from the companion's own environment: enough to find programs
/// and a home, nothing else — not a key or a `DATABASE_URL` a shell happened to export. The rest
/// is the entry's own `env`. The names the official MCP SDKs pass by default, and on Windows the
/// two a `.cmd` needs to run.
const INHERITED: &[&str] = if cfg!(windows) {
    &[
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMFILES",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE",
        "COMSPEC",
    ]
} else {
    &[
        "HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "TMPDIR",
    ]
};

fn inherited_env(
    var: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> Vec<(&'static str, std::ffi::OsString)> {
    INHERITED
        .iter()
        .filter_map(|name| var(name).map(|value| (*name, value)))
        .collect()
}

fn http_transport(
    url: &str,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<StreamableHttpClientTransport<reqwest::Client>, String> {
    use reqwest::header::{HeaderName, HeaderValue};
    let mut custom = std::collections::HashMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("mcp.json: {name} is not a header name"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| format!("mcp.json: the {name} header is not valid"))?;
        custom.insert(name, value);
    }
    let config = StreamableHttpClientTransportConfig::with_uri(url).custom_headers(custom);
    Ok(StreamableHttpClientTransport::with_client(
        reqwest::Client::new(),
        config,
    ))
}

/// A bare `npx` on Windows is `npx.cmd`, which `CreateProcess` will not find on its own: look
/// it up through `PATH` and `PATHEXT` as a shell would. A path, or any other system, is as given.
fn resolve_command(command: &str) -> std::path::PathBuf {
    let given = std::path::PathBuf::from(command);
    if !cfg!(windows) || given.components().count() > 1 || given.extension().is_some() {
        return given;
    }
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let path = std::env::var_os("PATH").unwrap_or_default();
    for folder in std::env::split_paths(&path) {
        for extension in extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
        {
            let candidate = folder.join(format!("{command}{}", extension.to_lowercase()));
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    given
}

// ---------------------------------------------------------------------------------------
// Routes (`companionRoutes.mcpTools`, `companionRoutes.mcpCall`)
// ---------------------------------------------------------------------------------------

#[derive(Default, Serialize)]
struct ToolsResponse {
    servers: Vec<ServerOut>,
    tools: Vec<ToolOut>,
}

#[derive(Serialize)]
struct ServerOut {
    id: String,
    label: String,
    kind: &'static str,
    state: &'static str,
    detail: Option<String>,
    instructions: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolOut {
    server_id: String,
    name: String,
    description: String,
    input_schema: Value,
    annotations: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallRequest {
    #[allow(dead_code)]
    call_id: String,
    server_id: String,
    name: String,
    arguments: serde_json::Map<String, Value>,
}

async fn tools(State(host): State<SharedHost>) -> Json<ToolsResponse> {
    Json(host.report())
}

async fn call(
    State(host): State<SharedHost>,
    body: Result<Json<CallRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<CallOutcome>, ApiError> {
    let Json(request) = body.map_err(|rejection| ApiError::BadRequest(rejection.body_text()))?;
    host.call(request).await.map(Json)
}

pub fn router(host: SharedHost) -> Router {
    Router::new()
        .route("/mcp/tools", get(tools))
        .route("/mcp/call", post(call))
        .with_state(host)
}

#[cfg(test)]
mod tests;
