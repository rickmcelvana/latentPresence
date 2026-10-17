//! latentPresence for the desktop (P8-T01, ADR-60): the web app in a window, with the companion
//! running inside this process.
//!
//! - **The companion** is the same library `pnpm companion` runs (`latentpresence_companion::serve`):
//!   bound on loopback, on 8787 when it is free and on a port the OS picks when it is not (a
//!   developer's own companion may hold 8787), and **paired** — a token made fresh at each launch,
//!   held only here, handed to the page by `companion_info` and required on every request. Its
//!   relay also reaches this machine's Ollama and LM Studio (`Relay::desktop`), which refuse the
//!   window's origin.
//! - **Secrets** — the API keys the page saves — go to Windows Credential Manager through
//!   `secret_set` / `secret_get` / `secret_delete` (the `keyring` crate), not into the webview.
//! - **The database address** (ADR-62), if the person gave one, is kept in Credential Manager too
//!   and handed to the companion at each start; changing it restarts the companion on the same
//!   socket and token (`database_set` / `database_clear`), so the page carries on.
//! - **The companion's own settings** (ADR-63) — Home Assistant, the folders it may read, web
//!   search, databases, documents — are read and changed here (`companion_config*`), through the
//!   companion's `config_edit`: secrets to Credential Manager, a folder only from the system's
//!   folder dialog, never a program. Each change restarts the companion, as the address does.
//! - **One window**: a second launch focuses the first (`single-instance`), and its size and place
//!   are remembered (`window-state`).
//!
//! Spike E's probe command and test tray are gone; the tray mode is P8-T05.

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::time::Duration;

use latentpresence_companion::config_edit::{self, Change, ConfigFiles, ConfigView, OsStore};
use latentpresence_companion::{DEFAULT_PORT, pairing, relay, serve};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

/// The Credential Manager "service" every key is filed under; the account is the page's ref
/// (`llm:openai`, `tts`, `mcp:<id>`).
const KEYCHAIN_SERVICE: &str = "latentPresence";

/// What the page needs to reach its companion.
#[derive(Clone, serde::Serialize)]
struct CompanionInfo {
    url: String,
    token: String,
}

/// One run of the companion, and how to end it.
struct Running {
    stop: oneshot::Sender<()>,
    done: tauri::async_runtime::JoinHandle<()>,
}

/// The companion: its socket and token for the app's whole life (the page keeps the address it
/// was given), and the run on it now. A new database address restarts the run, not the socket.
struct Companion {
    info: CompanionInfo,
    listener: TcpListener,
    running: tokio::sync::Mutex<Option<Running>>,
}

impl Companion {
    /// A run on a clone of the socket, with the database address kept in Credential Manager if
    /// there is one (else the companion reads `DATABASE_URL` as it always has).
    fn start(&self) -> std::io::Result<Running> {
        let listener = self.listener.try_clone()?;
        // A duplicated socket does not carry the original's non-blocking mode on Windows, and
        // tokio needs it: without it the run never answered (2026-10-17).
        listener.set_nonblocking(true)?;
        let token = self.info.token.clone();
        let database_url = match stored_database_url() {
            Ok(url) => url,
            Err(error) => {
                log::warn!(
                    "companion: the database address could not be read from Credential Manager: {error}"
                );
                None
            }
        };
        log::info!(
            "companion: starting ({})",
            if database_url.is_some() {
                "the database address saved in the app"
            } else {
                "no saved database address"
            }
        );
        let (stop, stopped) = oneshot::channel::<()>();
        let done = tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    log::error!("companion: the listener could not be handed to tokio: {error}");
                    return;
                }
            };
            let options = serve::ServeOptions {
                listener,
                token: Some(token),
                relay: relay::Relay::desktop(),
                database_url,
            };
            let shutdown = async {
                let _ = stopped.await;
            };
            if let Err(error) = serve::serve(options, shutdown).await {
                log::error!("companion stopped: {error}");
            }
        });
        Ok(Running { stop, done })
    }

    /// Ends the run now, if there is one, and waits a moment for the MCP servers it started.
    async fn stop(&self) {
        let running = self.running.lock().await.take();
        if let Some(running) = running {
            let _ = running.stop.send(());
            let _ = tokio::time::timeout(Duration::from_secs(3), running.done).await;
        }
    }

    /// A fresh run, for a changed database address. The page's address and token stay valid.
    async fn restart(&self) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if let Some(previous) = running.take() {
            let _ = previous.stop.send(());
            let _ = tokio::time::timeout(Duration::from_secs(5), previous.done).await;
        }
        *running = Some(self.start().map_err(|error| error.to_string())?);
        log::info!("companion: restarted");
        Ok(())
    }
}

#[tauri::command]
fn companion_info(companion: tauri::State<'_, Companion>) -> CompanionInfo {
    companion.info.clone()
}

/// The Credential Manager account the database address is filed under. Not a page ref: the page's
/// `secret_*` refs are `llm:*`, `tts`, `stt` and `mcp:*`.
const DATABASE_SECRET: &str = "companion:database";

fn stored_database_url() -> Result<Option<String>, String> {
    match entry(DATABASE_SECRET)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(keyring::v1::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// What the page may know about the saved database address: that there is one, and where it
/// points — never the password, which stays between Credential Manager and the companion.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
struct DatabaseInfo {
    saved: bool,
    /// `mysql://user@host:3306/name`, the password left out.
    address: Option<String>,
}

/// A MariaDB address the companion can use: `mysql://` or `mariadb://`, with a host.
fn checked_database_url(raw: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| {
        "That is not a database address. It looks like mysql://user:password@host:3306/latentpresence".to_owned()
    })?;
    if !matches!(url.scheme(), "mysql" | "mariadb") {
        return Err("A MariaDB address starts with mysql:// (or mariadb://).".to_owned());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("The address has no server name after the //.".to_owned());
    }
    Ok(url)
}

fn redacted(url: &tauri::Url) -> String {
    let mut shown = url.clone();
    let _ = shown.set_password(None);
    shown.to_string()
}

fn database_info_now() -> Result<DatabaseInfo, String> {
    Ok(match stored_database_url()? {
        Some(raw) => DatabaseInfo {
            saved: true,
            address: Some(checked_database_url(&raw).map_or_else(
                |_| "(saved, but not an address)".to_owned(),
                |url| redacted(&url),
            )),
        },
        None => DatabaseInfo {
            saved: false,
            address: None,
        },
    })
}

#[tauri::command]
fn database_info() -> Result<DatabaseInfo, String> {
    database_info_now()
}

/// Saves the database address in Credential Manager and restarts the companion on it (ADR-62).
#[tauri::command]
async fn database_set(
    url: String,
    companion: tauri::State<'_, Companion>,
) -> Result<DatabaseInfo, String> {
    let checked = checked_database_url(&url)?;
    entry(DATABASE_SECRET)?
        .set_password(checked.as_str())
        .map_err(|error| error.to_string())?;
    companion.restart().await?;
    database_info_now()
}

/// Forgets the saved address and restarts the companion without it.
#[tauri::command]
async fn database_clear(companion: tauri::State<'_, Companion>) -> Result<DatabaseInfo, String> {
    match entry(DATABASE_SECRET)?.delete_credential() {
        Ok(()) | Err(keyring::v1::Error::NoEntry) => {}
        Err(error) => return Err(error.to_string()),
    }
    companion.restart().await?;
    database_info_now()
}

/// Whether Windows will draw this app's toasts. It routes a toast by the app's identity, which the
/// installer's Start menu shortcut carries; tauri-plugin-notification sets it only when the exe is
/// not in `target\debug` or `target\release` (its `desktop.rs`, 2.7.0), and a toast without it
/// is accepted and dropped (Spike E). Run from a build folder, the page is told no, so a reminder
/// is said by her instead of lost.
#[tauri::command]
fn os_notifications() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    !(dir.ends_with("target/debug") || dir.ends_with("target/release"))
}

fn entry(name: &str) -> Result<keyring::v1::Entry, String> {
    keyring::v1::Entry::new(KEYCHAIN_SERVICE, name).map_err(|error| error.to_string())
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    entry(&name)?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

/// `None` when there is no such key, which is not an error.
#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::v1::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn config_files() -> Result<ConfigFiles, String> {
    ConfigFiles::locate()
        .ok_or_else(|| "Windows gave no folder for the app's settings (APPDATA).".to_owned())
}

/// The companion's settings as the page may see them: no secret, only where each one is.
#[tauri::command]
fn companion_config() -> Result<ConfigView, String> {
    Ok(config_edit::view(&config_files()?, &OsStore))
}

/// One change from Settings or the wizard; the companion restarts on the result.
#[tauri::command]
async fn companion_config_change(
    change: Change,
    companion: tauri::State<'_, Companion>,
) -> Result<ConfigView, String> {
    let files = config_files()?;
    config_edit::apply(&files, change, &OsStore)?;
    companion.restart().await?;
    Ok(config_edit::view(&files, &OsStore))
}

/// Where a picked folder goes.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum FolderFor {
    /// The Files server's roots (`mcp.json`).
    Files,
    /// The documents to index (`documents.json`).
    Documents,
}

/// The system's folder dialog; the folder the person picks is added. `None` when they cancel.
/// This, not the page, names the folder (ADR-43/44's guarantee, ADR-63).
#[tauri::command]
async fn companion_config_pick_folder(
    target: FolderFor,
    app: tauri::AppHandle,
    companion: tauri::State<'_, Companion>,
) -> Result<Option<ConfigView>, String> {
    let title = match target {
        FolderFor::Files => "Choose a folder she may read",
        FolderFor::Documents => "Choose a folder of documents",
    };
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_title(title)
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    let files = config_files()?;
    match target {
        FolderFor::Files => config_edit::add_root(&files, &path)?,
        FolderFor::Documents => config_edit::add_documents_folder(&files, &path)?,
    }
    companion.restart().await?;
    Ok(Some(config_edit::view(&files, &OsStore)))
}

/// A SQLite file as a database, from the system's file dialog. `None` when they cancel.
#[tauri::command]
async fn companion_config_pick_sqlite(
    name: String,
    app: tauri::AppHandle,
    companion: tauri::State<'_, Companion>,
) -> Result<Option<ConfigView>, String> {
    let dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .file()
            .set_title("Choose a SQLite database file")
            .add_filter("SQLite database", &["sqlite", "sqlite3", "db"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    let files = config_files()?;
    config_edit::add_sqlite_database(&files, &name, &path)?;
    companion.restart().await?;
    Ok(Some(config_edit::view(&files, &OsStore)))
}

/// Restarts the companion on the files as they are now: after `mcp.json` was edited by hand.
#[tauri::command]
async fn companion_config_reload(
    companion: tauri::State<'_, Companion>,
) -> Result<ConfigView, String> {
    companion.restart().await?;
    Ok(config_edit::view(&config_files()?, &OsStore))
}

/// Opens `mcp.json` in whatever Windows opens `.json` with, for the programs it lists, which are
/// changed only by hand. An empty file is made first if there is none.
#[tauri::command]
fn companion_config_open() -> Result<(), String> {
    let files = config_files()?;
    if !files.mcp.exists() {
        if let Some(dir) = files.mcp.parent() {
            std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        std::fs::write(&files.mcp, "{\n  \"mcpServers\": {}\n}\n")
            .map_err(|error| error.to_string())?;
    }
    std::process::Command::new("explorer.exe")
        .arg(&files.mcp)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Loopback, on the companion's usual port if nobody holds it, else any free one.
fn bind_companion() -> std::io::Result<TcpListener> {
    let preferred = SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT));
    let listener = TcpListener::bind(preferred)
        .or_else(|_| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Binds and starts the companion; the page can ask for it as soon as this returns.
fn start_companion() -> std::io::Result<Companion> {
    let listener = bind_companion()?;
    let address = listener.local_addr()?;
    let companion = Companion {
        info: CompanionInfo {
            url: format!("http://{address}"),
            token: pairing::new_token(),
        },
        listener,
        running: tokio::sync::Mutex::new(None),
    };
    let first = companion.start()?;
    *companion
        .running
        .try_lock()
        .expect("nothing else holds a companion being built") = Some(first);
    log::info!("companion: http://{address} (paired)");
    Ok(companion)
}

/// The app's answer to the webview's permission requests (P8-T02, ADR-61). Left to WebView2, the
/// microphone and the camera are asked for in a prompt naming `http://tauri.localhost`, and a
/// Block there is remembered with no settings page to undo it. The page is this app's own and
/// asks only after a click (Start voice, Read my face, the first-run check), so the app answers
/// as a native app would; Windows' own privacy switches still apply. Nothing else is granted.
fn permission_for(kind: PermissionKind) -> PermissionResponse {
    match kind {
        PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
        _ => PermissionResponse::Default,
    }
}

/// Stops the companion and waits a moment for the MCP servers it started to go with it.
fn stop_companion(app: &tauri::AppHandle) {
    let Some(companion) = app.try_state::<Companion>() else {
        return;
    };
    tauri::async_runtime::block_on(companion.stop());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // First: a second launch hands over to this one and exits before starting anything.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            companion_info,
            os_notifications,
            secret_set,
            secret_get,
            secret_delete,
            database_info,
            database_set,
            database_clear,
            companion_config,
            companion_config_change,
            companion_config_pick_folder,
            companion_config_pick_sqlite,
            companion_config_open,
            companion_config_reload
        ])
        .setup(|app| {
            match tauri::webview_version() {
                Ok(version) => log::info!("webview runtime: {version}"),
                Err(error) => log::warn!("webview runtime: unavailable ({error})"),
            }
            app.manage(start_companion()?);
            // The window is built here, after the companion is managed, rather than from the
            // config ("create": false), so it can answer the webview's permission requests.
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .ok_or("tauri.conf.json has no main window")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                .on_permission_request(|_, kind| permission_for(kind))
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the latentPresence window could not be built");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Logged both sides: a shutdown that hangs shows which half it hung in.
            log::info!("exit: stopping the companion");
            stop_companion(app);
            log::info!("exit: companion stopped");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_database_address_must_be_mariadb_with_a_server_and_is_shown_without_its_password() {
        let url =
            checked_database_url(" mysql://lp:s3cret@192.168.40.101:3306/latentpresence ").unwrap();
        assert_eq!(
            redacted(&url),
            "mysql://lp@192.168.40.101:3306/latentpresence"
        );
        assert!(checked_database_url("mariadb://lp:pw@db.example/lp").is_ok());
        for refused in [
            "",
            "not a url",
            "postgres://u:p@host/db",
            "http://host/db",
            "mysql:///lp",
        ] {
            assert!(checked_database_url(refused).is_err(), "{refused}");
        }
    }

    #[test]
    fn the_app_grants_the_microphone_and_camera_and_leaves_everything_else_to_the_webview() {
        assert!(matches!(
            permission_for(PermissionKind::Microphone),
            PermissionResponse::Allow
        ));
        assert!(matches!(
            permission_for(PermissionKind::Camera),
            PermissionResponse::Allow
        ));
        for other in [
            PermissionKind::Geolocation,
            PermissionKind::Notifications,
            PermissionKind::ClipboardRead,
        ] {
            assert!(matches!(permission_for(other), PermissionResponse::Default));
        }
    }
}
