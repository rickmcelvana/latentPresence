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
//! - **One window**: a second launch focuses the first (`single-instance`), and its size and place
//!   are remembered (`window-state`).
//!
//! Spike E's probe command and test tray are gone; the tray mode is P8-T05.

use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::sync::Mutex;
use std::time::Duration;

use latentpresence_companion::{DEFAULT_PORT, pairing, relay, serve};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Manager, RunEvent};
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

/// The running companion: what the page is told, and how to stop it.
struct Companion {
    info: CompanionInfo,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    done: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[tauri::command]
fn companion_info(companion: tauri::State<'_, Companion>) -> CompanionInfo {
    companion.info.clone()
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
    let token = pairing::new_token();
    let (stop, stopped) = oneshot::channel::<()>();
    let serve_token = token.clone();
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
            token: Some(serve_token),
            relay: relay::Relay::desktop(),
        };
        let shutdown = async {
            let _ = stopped.await;
        };
        if let Err(error) = serve::serve(options, shutdown).await {
            log::error!("companion stopped: {error}");
        }
    });
    log::info!("companion: http://{address} (paired)");
    Ok(Companion {
        info: CompanionInfo {
            url: format!("http://{address}"),
            token,
        },
        stop: Mutex::new(Some(stop)),
        done: Mutex::new(Some(done)),
    })
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
    if let Some(stop) = companion.stop.lock().ok().and_then(|mut stop| stop.take()) {
        let _ = stop.send(());
    }
    if let Some(done) = companion.done.lock().ok().and_then(|mut done| done.take()) {
        let _ = tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(3), done).await
        });
    }
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
            secret_delete
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
