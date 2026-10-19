//! Tray mode (P8-T05, ADR-65): closing the window hides it, and the app goes on in the tray —
//! the companion, and the page with her schedules and reminders, still running.
//!
//! - **The close button hides** the window (unless the person turned that off in Settings, which
//!   the page tells us with `tray_close_to_tray`). The first time, a notification says where the
//!   app went. **Quit**, from the tray's menu, is the only thing that ends everything.
//! - **Hiding is announced to the page** (`tray-hidden`): it ends a voice call, the camera and face
//!   reading, so nothing listens or watches from a window no one can see, and their models go.
//! - **The presence window** is the same window made small, always on top, in a corner of the
//!   screen; the page shows only her and the call controls (`presence` event). Leaving it puts the
//!   window back where it was.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewWindow, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

const MAIN: &str = "main";
/// The presence window's size, in logical pixels: her, a caption line and the call controls.
pub const PRESENCE_SIZE: (f64, f64) = (360.0, 560.0);
/// The normal window's minimum, as `tauri.conf.json` sets it.
const NORMAL_MIN: (f64, f64) = (960.0, 600.0);
/// Kept clear of the screen's edge in the corner the presence window goes to.
const MARGIN: i32 = 16;

/// Where the window was before the presence window, to put it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Normal {
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
    maximized: bool,
}

/// The tray's state for the app's life.
pub struct Tray {
    close_to_tray: AtomicBool,
    hidden_once: AtomicBool,
    presence: Mutex<Option<Normal>>,
    presence_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

impl Default for Tray {
    fn default() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            hidden_once: AtomicBool::new(false),
            presence: Mutex::new(None),
            presence_item: Mutex::new(None),
        }
    }
}

/// The page's Settings → "Closing the window keeps her running" (on unless turned off).
#[tauri::command]
pub fn tray_close_to_tray(enabled: bool, tray: tauri::State<'_, Tray>) {
    tray.close_to_tray.store(enabled, Ordering::Relaxed);
}

/// The page's own "small window" and "back to the full window" buttons.
#[tauri::command]
pub fn presence_set(on: bool, app: AppHandle) -> Result<(), String> {
    set_presence(&app, on)
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN)
}

/// Brings the window back from the tray, the taskbar or behind other windows.
pub fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The bottom-right corner of the work area (the screen less the taskbar) for a window of `size`.
fn corner(
    area_position: PhysicalPosition<i32>,
    area_size: PhysicalSize<u32>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> PhysicalPosition<i32> {
    let margin = (f64::from(MARGIN) * scale).round() as i32;
    let right = area_position.x + area_size.width as i32;
    let bottom = area_position.y + area_size.height as i32;
    PhysicalPosition::new(
        (right - size.width as i32 - margin).max(area_position.x),
        (bottom - size.height as i32 - margin).max(area_position.y),
    )
}

fn set_presence(app: &AppHandle, on: bool) -> Result<(), String> {
    let window = main_window(app).ok_or("the window is gone")?;
    let tray = app.state::<Tray>();
    let mut saved = tray.presence.lock().map_err(|error| error.to_string())?;
    let fail = |error: tauri::Error| error.to_string();
    if on && saved.is_none() {
        *saved = Some(Normal {
            // Inner, as `set_size` takes it: the outer size grew the window by its frame each
            // round trip (16×39 px, 2026-10-19).
            size: window.inner_size().map_err(fail)?,
            position: window.outer_position().map_err(fail)?,
            maximized: window.is_maximized().map_err(fail)?,
        });
        if window.is_maximized().map_err(fail)? {
            window.unmaximize().map_err(fail)?;
        }
        window
            .set_min_size(None::<LogicalSize<f64>>)
            .map_err(fail)?;
        window
            .set_size(LogicalSize::new(PRESENCE_SIZE.0, PRESENCE_SIZE.1))
            .map_err(fail)?;
        window.set_always_on_top(true).map_err(fail)?;
        if let Some(monitor) = window.current_monitor().map_err(fail)? {
            let area = monitor.work_area();
            let size = window.outer_size().map_err(fail)?;
            window
                .set_position(corner(
                    area.position,
                    area.size,
                    size,
                    monitor.scale_factor(),
                ))
                .map_err(fail)?;
        }
        show(app);
    } else if !on && let Some(normal) = saved.take() {
        window.set_always_on_top(false).map_err(fail)?;
        window
            .set_min_size(Some(LogicalSize::new(NORMAL_MIN.0, NORMAL_MIN.1)))
            .map_err(fail)?;
        window.set_size(normal.size).map_err(fail)?;
        window.set_position(normal.position).map_err(fail)?;
        if normal.maximized {
            window.maximize().map_err(fail)?;
        }
    }
    drop(saved);
    if let Ok(item) = tray.presence_item.lock()
        && let Some(item) = item.as_ref()
    {
        let _ = item.set_checked(on);
    }
    window.emit("presence", on).map_err(fail)
}

/// Ends the app from the tray: the window back to its normal size first, so the size remembered
/// for next time is not the presence window's.
fn quit(app: &AppHandle) {
    let _ = set_presence(app, false);
    app.exit(0);
}

/// Hides the window to the tray and tells the page; the first time, says where the app went.
fn hide_to_tray(window: &tauri::Window) {
    let _ = window.hide();
    let _ = window.emit("tray-hidden", ());
    let app = window.app_handle();
    let tray = app.state::<Tray>();
    if !tray.hidden_once.swap(true, Ordering::Relaxed) {
        let _ = app
            .notification()
            .builder()
            .title("latentPresence is still running")
            .body("Her reminders and schedules carry on. Open her again, or quit, from the tray icon.")
            .show();
    }
}

/// The close button: hide instead, unless the person chose otherwise.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let tray = window.app_handle().state::<Tray>();
        if tray.close_to_tray.load(Ordering::Relaxed) {
            api.prevent_close();
            hide_to_tray(window);
        }
    }
}

/// The tray icon and its menu: Open, the presence window, Quit. A left click opens the window.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open latentPresence", true, None::<&str>)?;
    let presence = CheckMenuItem::with_id(
        app,
        "presence",
        "Small window, always on top",
        true,
        false,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &presence,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;
    if let Ok(mut item) = app.state::<Tray>().presence_item.lock() {
        *item = Some(presence);
    }
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("latentPresence")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "presence" => {
                let on = app
                    .state::<Tray>()
                    .presence
                    .lock()
                    .map(|saved| saved.is_none())
                    .unwrap_or(false);
                if let Err(error) = set_presence(app, on) {
                    log::warn!("presence window: {error}");
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_presence_window_sits_in_the_bottom_right_of_the_work_area_clear_of_the_edge() {
        // A 1920×1040 work area (the taskbar below), at 100 % and at 150 %.
        let area = (PhysicalPosition::new(0, 0), PhysicalSize::new(1920, 1040));
        assert_eq!(
            corner(area.0, area.1, PhysicalSize::new(360, 560), 1.0),
            PhysicalPosition::new(1920 - 360 - 16, 1040 - 560 - 16)
        );
        assert_eq!(
            corner(area.0, area.1, PhysicalSize::new(540, 840), 1.5),
            PhysicalPosition::new(1920 - 540 - 24, 1040 - 840 - 24)
        );
        // A second screen to the left, and a window larger than the screen: kept on it.
        assert_eq!(
            corner(
                PhysicalPosition::new(-1280, 0),
                PhysicalSize::new(1280, 680),
                PhysicalSize::new(400, 900),
                1.0
            ),
            PhysicalPosition::new(-1280 + 1280 - 400 - 16, 0)
        );
    }

    #[test]
    fn closing_hides_by_default() {
        let tray = Tray::default();
        assert!(tray.close_to_tray.load(Ordering::Relaxed));
        assert!(tray.presence.lock().unwrap().is_none());
    }
}
