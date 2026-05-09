use serde_json::Value;
use tauri::{AppHandle, State};
use crate::window::WindowState;

// IMPORTANT: These commands MUST be async on Windows.
// WebviewWindowBuilder::build() deadlocks when called from a synchronous
// Tauri command on Windows (documented Tauri v2 limitation).

#[tauri::command]
pub async fn show_overlay(app: AppHandle, window_state: State<'_, WindowState>) -> Result<(), ()> {
    window_state.show_overlay(&app);
    Ok(())
}

#[tauri::command]
pub async fn hide_overlay(app: AppHandle, window_state: State<'_, WindowState>) -> Result<(), ()> {
    window_state.hide_overlay(&app);
    Ok(())
}

#[tauri::command]
pub async fn update_overlay_state(data: Value, app: AppHandle, window_state: State<'_, WindowState>) -> Result<(), ()> {
    window_state.update_overlay_state(&app, &data);
    Ok(())
}
