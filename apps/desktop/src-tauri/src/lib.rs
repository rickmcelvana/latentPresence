//! The shell for P0-T08 Spike E. It opens a window on the `apps/web` dev server and does
//! nothing else on purpose: the spike runs known-good pages in an unknown container to see
//! what the container takes away, so anything this file adds is a variable in the result.
//!
//! The log plugin is here because the finding this spike is most likely to produce is an
//! error message, and "didn't work" is not a finding.

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![record])
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
