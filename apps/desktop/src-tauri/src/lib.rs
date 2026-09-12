//! The shell for P0-T08 Spike E. It opens a window on the `apps/web` dev server and does
//! nothing else on purpose: the spike runs known-good pages in an unknown container to see
//! what the container takes away, so anything this file adds is a variable in the result.
//!
//! The log plugin is here because the finding this spike is most likely to produce is an
//! error message, and "didn't work" is not a finding.
//!
//! **Amended for the Windows sitting, 2026-09-11.** The paragraph above still governs, with
//! one deliberate exception: the tray and the OS notification path are built here now. The
//! Linux leg left both rows "not measured" and gave a good reason — building Rust features
//! to test a shell Linux will not ship is work in the direction the answer already ruled
//! out. That reason inverts on Windows. WebView2 is the container ADR-07 ships *first*, the
//! brief asks for both rows by name, and ADR-14's schedules and P8-T05's tray mode are the
//! two features that depend on them. They are additions to the shell rather than to the
//! page, so the webview capability readings stay uncontaminated.

use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri_plugin_notification::NotificationExt;

/// The only command the shell has, and it is measurement plumbing rather than a feature.
///
/// A Tauri window has no address bar, no devtools by default and — on GNOME Wayland — no
/// way for another process to screenshot it. Without this, the only route from a result
/// inside the webview to the write-up is a person retyping a table off a screen, which is
/// how a wrong number reaches a decision. The probe page calls it once and the report
/// lands in the terminal that launched the app.
#[tauri::command]
fn record(report: String) {
    println!("--- spike E report from inside the webview ---\n{report}");
}

/// What container this actually is, asked of the runtime rather than of a package manager.
///
/// `webview_version` reports what wry loaded. `pkg-config --modversion webkit2gtk-4.1`
/// reports what is installed to build against, which is a different question — the Linux
/// leg recorded both for exactly that reason, and the Windows column needs the same.
fn report_environment() {
    match tauri::webview_version() {
        Ok(version) => log::info!("webview runtime: {version}"),
        Err(error) => log::info!("webview runtime: unavailable ({error})"),
    }
    log::info!(
        "os: {} {}, tauri {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        tauri::VERSION
    );
}

/// The tray, and the notification the tray sends.
///
/// "It built" is not the test. A tray icon that appears under one desktop environment and
/// silently does not under another is the kind of thing this spike exists to catch, so
/// every outcome is logged and the write-up quotes a line rather than a memory.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show the window", true, None::<&str>)?;
    let notify = MenuItem::with_id(
        app,
        "notify",
        "Send a test notification",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &notify, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    TrayIconBuilder::with_id("spike-e")
        .icon(icon)
        .tooltip("latentPresence (spike)")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                let _ = window.show();
                let _ = window.set_focus();
            }
            "notify" => {
                // The OS notification service, reached from Rust. This is a different path
                // from the web `Notification` the probe page tests, it is the one ADR-14
                // and P8-T05 will actually use, and on Linux it needs a daemon that may not
                // be running — so a failure is a finding and is logged rather than dropped.
                //
                // Note what this does and does not claim. `Ok` means the call succeeded,
                // not that a toast was drawn: Focus Assist and per-app settings suppress
                // after the API has returned.
                let result = app
                    .notification()
                    .builder()
                    .title("latentPresence")
                    .body("Spike E: the native notification call returned.")
                    .show();
                match result {
                    Ok(()) => log::info!("notification: call returned Ok"),
                    Err(error) => log::error!("notification failed: {error}"),
                }
            }
            "quit" => app.exit(0),
            other => log::warn!("unhandled tray item: {other}"),
        })
        .build(app)?;

    log::info!("tray: built");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![record])
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;

            report_environment();

            if let Err(error) = build_tray(app.handle()) {
                // The webview capability readings are the larger half of the spike and do
                // not depend on the tray. Losing it must not cost the run that takes them.
                log::error!("tray failed: {error}");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
