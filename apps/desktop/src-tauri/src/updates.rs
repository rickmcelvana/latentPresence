//! Updates (P8-T04, ADR-66): a new version from the GitHub release, checked only when the person
//! asks or allowed a check at start, and installed only when they press Install.
//!
//! - **Where**: `plugins.updater.endpoints` in `tauri.conf.json`, the latest release's
//!   `latest.json`, which the release workflow publishes beside the installer. A draft release is
//!   not "latest", so nothing reaches anyone until Rick publishes it.
//! - **Trusted by its signature, not its address**: every installer is signed with the release key
//!   (a GitHub secret) and checked against `plugins.updater.pubkey` before it runs. A test channel
//!   is a build with another address and key (`docs/release.md`), never a switch in this one.
//! - **Installing ends the app** on Windows: the plugin starts the installer and exits the process
//!   at once, without `RunEvent::Exit`, so the companion — and the MCP programs it started — is
//!   stopped here first.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::Companion;

/// What the page shows about an available version.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    /// The release notes, as written on the release.
    pub notes: Option<String>,
}

/// Download progress for the page (`update-progress`): bytes so far and the total when known.
#[derive(Debug, Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn sentence(error: impl std::fmt::Display) -> String {
    format!("The update could not be checked or installed: {error}")
}

/// This app's version, from `tauri.conf.json`.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Whether this build carries the release's public key. A build from a checkout before the key
/// was made has none: nothing it downloaded could be trusted, so it does not ask.
fn has_release_key(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

/// Asks the release for a newer version; `None` when this is the newest.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !has_release_key(&app) {
        return Err(
            "This build cannot update itself: it has no release key (docs/release.md).".into(),
        );
    }
    let found = app
        .updater()
        .map_err(sentence)?
        .check()
        .await
        .map_err(sentence)?;
    Ok(found.map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
    }))
}

/// Downloads the newer version, checks its signature, stops the companion and starts the
/// installer, which ends this process and opens the new version when it is done.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(sentence)?
        .check()
        .await
        .map_err(sentence)?
        .ok_or("There is no newer version to install.")?;
    let mut downloaded: u64 = 0;
    let progress = app.clone();
    // `download` checks the signature against the app's key before returning the bytes.
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(sentence)?;
    log::info!(
        "update: {} downloaded and verified; installing",
        update.version
    );
    if let Some(companion) = app.try_state::<Companion>() {
        companion.stop().await;
    }
    update.install(bytes).map_err(sentence)
}
