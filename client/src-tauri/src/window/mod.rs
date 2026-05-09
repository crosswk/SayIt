use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const OVERLAY_DEFAULT_BASE_WIDTH: f64 = 360.0;
const OVERLAY_BASE_HEIGHT: f64 = 56.0;
const OVERLAY_FALLBACK_WIDTH: f64 = 520.0;
const OVERLAY_FALLBACK_HEIGHT: f64 = 224.0;

#[derive(Debug, Clone, PartialEq)]
enum OverlayLayout {
    Base,
    Fallback,
}

pub struct WindowState {
    overlay_layout: Mutex<OverlayLayout>,
    overlay_base_width: Mutex<f64>,
}

impl WindowState {
    pub fn new() -> Self {
        Self {
            overlay_layout: Mutex::new(OverlayLayout::Base),
            overlay_base_width: Mutex::new(OVERLAY_DEFAULT_BASE_WIDTH),
        }
    }

    pub fn show_overlay(&self, app: &AppHandle) {
        let layout = self.overlay_layout.lock().unwrap().clone();
        let is_fallback = layout == OverlayLayout::Fallback;
        let base_w = *self.overlay_base_width.lock().unwrap();

        if let Some(overlay) = app.get_webview_window("overlay") {
            let bounds = calc_overlay_bounds(app, is_fallback, base_w);
            let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(bounds.0, bounds.1)));
            let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(bounds.2, bounds.3)));
            let _ = overlay.show();
            let _ = overlay.set_always_on_top(true);
            set_overlay_interactivity(&overlay, is_fallback);
        } else {
            self.create_overlay(app, is_fallback, base_w);
        }
    }

    pub fn hide_overlay(&self, app: &AppHandle) {
        // Reset to base layout when hiding
        *self.overlay_layout.lock().unwrap() = OverlayLayout::Base;

        if let Some(overlay) = app.get_webview_window("overlay") {
            set_overlay_interactivity(&overlay, false);
            let _ = overlay.hide();
        }
    }

    pub fn update_overlay_state(&self, app: &AppHandle, data: &Value) {
        let state_str = data.get("state").and_then(|s| s.as_str()).unwrap_or("");

        // Update base width if provided
        if let Some(bw) = data.get("baseWidth").and_then(|v| v.as_f64()) {
            if bw >= 160.0 && bw <= 600.0 {
                *self.overlay_base_width.lock().unwrap() = bw;
            }
        }

        let next_layout = if state_str == "fallback" {
            OverlayLayout::Fallback
        } else {
            OverlayLayout::Base
        };

        let is_fallback = next_layout == OverlayLayout::Fallback;
        let base_w = *self.overlay_base_width.lock().unwrap();

        {
            let mut current = self.overlay_layout.lock().unwrap();
            if *current != next_layout {
                *current = next_layout;
                // Resize overlay
                if let Some(overlay) = app.get_webview_window("overlay") {
                    let bounds = calc_overlay_bounds(app, is_fallback, base_w);
                    let _ = overlay.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(bounds.0, bounds.1)));
                    let _ = overlay.set_size(tauri::Size::Logical(tauri::LogicalSize::new(bounds.2, bounds.3)));
                    let _ = overlay.set_always_on_top(true);
                }
            }
        }

        if let Some(overlay) = app.get_webview_window("overlay") {
            set_overlay_interactivity(&overlay, is_fallback);

            if is_fallback {
                let _ = overlay.show();
            }

            let _ = overlay.emit("overlay-state", data);
        }
    }

    fn create_overlay(&self, app: &AppHandle, is_fallback: bool, base_w: f64) {
        let bounds = calc_overlay_bounds(app, is_fallback, base_w);

        let builder = WebviewWindowBuilder::new(
            app,
            "overlay",
            WebviewUrl::App("overlay.html".into()),
        )
        .title("SayIt Overlay")
        .inner_size(bounds.2, bounds.3)
        .position(bounds.0, bounds.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false);

        match builder.build() {
            Ok(overlay) => {
                set_overlay_interactivity(&overlay, is_fallback);
                let _ = overlay.show();
            }
            Err(e) => {
                eprintln!("[overlay] create_overlay: FAILED: {}", e);
                log::error!("Failed to create overlay window: {}", e);
            }
        }
    }
}

fn set_overlay_interactivity(overlay: &tauri::WebviewWindow, interactive: bool) {
    let _ = overlay.set_ignore_cursor_events(!interactive);
}

/// Returns (x, y, width, height)
fn calc_overlay_bounds(app: &AppHandle, is_fallback: bool, base_w: f64) -> (f64, f64, f64, f64) {
    let (desired_w, desired_h) = if is_fallback {
        (OVERLAY_FALLBACK_WIDTH, OVERLAY_FALLBACK_HEIGHT)
    } else {
        (base_w, OVERLAY_BASE_HEIGHT)
    };

    // Try to get primary monitor size
    let (screen_w, screen_h) = if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale)
    } else {
        (1920.0, 1080.0) // fallback
    };

    let w = desired_w.min(screen_w - 40.0).max(160.0);
    let h = desired_h.min(screen_h - 40.0).max(56.0);
    let x = ((screen_w - w) / 2.0).round();
    let y = (screen_h - h - 72.0).max(8.0);

    (x, y, w, h)
}
