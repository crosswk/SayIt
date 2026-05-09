// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod storage;
mod window;
mod keyboard;
mod context;
mod inject;
mod providers;
mod models;

use storage::Storage;
use window::WindowState;
use keyboard::KeyboardHookManager;
use context::ContextDetector;
use tauri::{Manager, Emitter};
use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};

/// Clean up expired audio files based on retention setting.
fn cleanup_expired_audio(storage: &Storage) {
    let retention_val = storage.get("audioRetentionDays", Some(&serde_json::json!(30)));
    let retention_days = retention_val.as_i64().unwrap_or(30);
    if retention_days < 0 {
        return; // -1 = keep forever
    }

    let cutoff_ms = chrono::Utc::now().timestamp_millis() - retention_days * 24 * 60 * 60 * 1000;
    let audio_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("audio");

    if !audio_dir.exists() {
        return;
    }

    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&audio_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    let mtime_ms = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;
                    if mtime_ms < cutoff_ms {
                        if std::fs::remove_file(&path).is_ok() {
                            deleted += 1;
                        }
                    }
                }
            }
        }
    }

    if deleted > 0 {
        log::info!("Audio cleanup: deleted {} expired files", deleted);
    }
}

/// Clean up expired log files based on retention setting.
fn cleanup_expired_logs(storage: &Storage) {
    let retention_val = storage.get("logRetentionDays", Some(&serde_json::json!(30)));
    let retention_days = retention_val.as_i64().unwrap_or(30);
    if retention_days <= 0 {
        return;
    }

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days);
    let cutoff_ts = cutoff.timestamp();

    let log_dir = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs");

    if !log_dir.exists() {
        return;
    }

    let mut deleted = 0u32;
    if let Ok(entries) = std::fs::read_dir(&log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            // 不删除当前日志文件
            if path.file_name().map(|n| n == "sayit.log").unwrap_or(false) {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    let mtime = modified
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs() as i64;
                    if mtime < cutoff_ts {
                        if std::fs::remove_file(&path).is_ok() {
                            deleted += 1;
                        }
                    }
                }
            }
        }
    }

    if deleted > 0 {
        log::info!("Log cleanup: deleted {} expired files", deleted);
    }
}

fn main() {
    // Initialize logger so log::info!/warn!/error! produce output
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("SayIt starting, version={}", env!("CARGO_PKG_VERSION"));
    log::info!("Log file: {:?}", dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs")
        .join("sayit.log"));

    // Allow self-signed certificates and auto-grant microphone for backend connection (WebView2)
    // This must be set before any WebView2 instance is created
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-certificate-errors --auto-accept-camera-and-microphone-capture",
        );
    }

    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.sayit.app")
        .join("sayit.db");

    let storage = Storage::new(db_path).expect("failed to initialize SQLite storage");

    // One-time migration from Electron app's SQLite database
    if let Err(e) = storage.migrate_from_electron() {
        eprintln!("Warning: Electron data migration failed: {}", e);
    }

    // Clean up expired audio files on startup
    cleanup_expired_audio(&storage);

    // Clean up expired log files on startup
    cleanup_expired_logs(&storage);

    // Read PTT setting before moving storage into managed state
    let ptt_setting_val = storage.get("shortcutPTT", None);
    let ptt_str = ptt_setting_val.as_str().unwrap_or("ShiftRight").to_string();
    let hf_setting_val = storage.get("shortcutHandsFree", None);
    let hf_str = hf_setting_val.as_str().unwrap_or("AltRight").to_string();
    eprintln!("[main] PTT setting from DB: raw={:?} parsed={:?}", ptt_setting_val, ptt_str);
    eprintln!("[main] HF setting from DB: raw={:?} parsed={:?}", hf_setting_val, hf_str);

    let window_state = WindowState::new();
    let keyboard_hook = KeyboardHookManager::new();
    let context_detector = ContextDetector::new();

    tauri::Builder::default()
        .manage(storage)
        .manage(window_state)
        .manage(keyboard_hook)
        .manage(context_detector)
        .setup(move |app| {
            let hook: tauri::State<KeyboardHookManager> = app.state();
            hook.start(app.handle(), &ptt_str, &hf_str);

            // 设置窗口图标（用 ICO 文件，包含多尺寸帧，Windows 自动选最合适的）
            if let Some(main_window) = app.get_webview_window("main") {
                let ico_bytes = include_bytes!("../icons/icon.ico");
                if let Ok(icon) = tauri::image::Image::from_bytes(ico_bytes) {
                    let _ = main_window.set_icon(icon);
                }
            }

            // 系统托盘图标
            {
                let show_item = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
                let quit_item = MenuItemBuilder::with_id("quit", "退出 SayIt").build(app)?;
                let tray_menu = MenuBuilder::new(app)
                    .item(&show_item)
                    .separator()
                    .item(&quit_item)
                    .build()?;

                let ico_bytes = include_bytes!("../icons/icon.ico");
                let icon = tauri::image::Image::from_bytes(ico_bytes)
                    .expect("failed to load tray icon");

                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("SayIt — 按住说话，松开输入")
                    .menu(&tray_menu)
                    .on_menu_event(|app, event| {
                        match event.id().as_ref() {
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.unminimize();
                                    let _ = w.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        // 左键单击托盘图标 → 显示主窗口
                        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                            if let Some(w) = tray.app_handle().get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // Start WinEvent hook for foreground window monitoring
            let detector: tauri::State<ContextDetector> = app.state();
            detector.start_winevent_hook(app.handle());

            // Register hands-free global shortcut (only for combo keys; single keys are handled by keyboard hook)
            {
                let storage: tauri::State<Storage> = app.state();
                let hf_val = storage.get("shortcutHandsFree", None);
                let hf_key = hf_val.as_str().unwrap_or("AltRight");
                if !hf_key.is_empty() && hf_key.contains('+') {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if let Err(e) = app.global_shortcut().on_shortcut(
                        hf_key,
                        move |_app, _shortcut, _event| {
                            let _ = _app.emit("toggle-hands-free", serde_json::json!({
                                "source": "globalShortcut",
                            }));
                        },
                    ) {
                        log::warn!("Failed to register hands-free shortcut '{}': {}", hf_key, e);
                    } else {
                        log::info!("Registered hands-free shortcut: {}", hf_key);
                    }
                }
            }

            // 首次安装时自动启用开机自启（仅执行一次）
            {
                use tauri_plugin_autostart::ManagerExt;
                let storage: tauri::State<Storage> = app.state();
                let already_set = storage.get("autoLaunchInitialized", None);
                if already_set.is_null() || already_set.as_str() == Some("") {
                    // 首次运行，注册开机自启并标记
                    let autostart = app.autolaunch();
                    let _ = autostart.enable();
                    let flag = serde_json::json!("true");
                    let _ = storage.set("autoLaunchInitialized", &flag);
                    log::info!("Auto-launch enabled on first run");
                }
            }

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // updater plugin disabled until signing keys are generated
        // .plugin(tauri_plugin_updater::Builder::new().build())
        // .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            // Store
            commands::storage::store_get,
            commands::storage::store_set,
            commands::storage::store_delete,
            // History
            commands::storage::history_list,
            commands::storage::history_count,
            commands::storage::history_add,
            commands::storage::history_update,
            commands::storage::history_delete,
            commands::storage::history_set_favorite,
            // Window
            commands::window::show_overlay,
            commands::window::hide_overlay,
            commands::window::update_overlay_state,
            // Paste / Context
            commands::paste::paste_text,
            commands::paste::get_probe_result,
            commands::paste::get_active_app_context,
            commands::paste::copy_text,
            // System
            commands::system::get_client_runtime_info,
            commands::system::get_auto_launch,
            commands::system::set_auto_launch,
            commands::system::get_update_status,
            commands::system::check_for_updates,
            commands::system::install_downloaded_update,
            commands::system::download_update,
            commands::system::append_debug_log,
            commands::system::save_audio_to_downloads,
            commands::system::reveal_file_in_folder,
            // Audio
            commands::audio::save_audio_file,
            commands::audio::save_pcm_as_wav,
            commands::audio::read_audio_file,
            commands::audio::delete_audio_file,
            // Shortcuts
            commands::shortcuts::shortcuts_changed,
            commands::shortcuts::test_shortcut,
            commands::shortcuts::set_ptt_lab_config,
            // Export
            commands::export::save_text_export,
            commands::export::save_export_bundle,
            commands::export::save_full_export,
            // Diagnostics
            commands::diagnostics::collect_settings,
            commands::diagnostics::get_diagnostics_preview,
            commands::diagnostics::create_diagnostics_zip,
            commands::diagnostics::read_diagnostics_zip,
            commands::diagnostics::copy_diagnostics_zip,
            commands::diagnostics::read_log_file,
            commands::diagnostics::open_log_folder,
            // Providers (cloud ASR / AI)
            providers::registry::cloud_polish,
            providers::registry::cloud_transcribe,
            providers::registry::test_ai_connection,
            providers::registry::test_asr_connection,
            // Doubao realtime streaming ASR
            providers::asr_doubao_realtime::doubao_stream_open,
            providers::asr_doubao_realtime::doubao_stream_send,
            providers::asr_doubao_realtime::doubao_stream_finish,
            providers::asr_doubao_realtime::doubao_stream_close,
            // Qwen realtime streaming ASR
            providers::asr_qwen_realtime::qwen_stream_open,
            providers::asr_qwen_realtime::qwen_stream_send,
            providers::asr_qwen_realtime::qwen_stream_finish,
            providers::asr_qwen_realtime::qwen_stream_close,
            // Models (local model management)
            models::registry::list_available_models,
            models::registry::list_downloaded_models,
            models::registry::download_model,
            models::registry::delete_model,
            models::registry::open_models_folder,
            models::registry::open_model_folder,
            models::local_asr::local_transcribe,
            models::local_asr::preload_local_model,
            models::test_audio::run_asr_benchmark,
            models::test_audio::get_test_audio_b64,
        ])
        .on_window_event(|window, event| {
            // 点击关闭按钮时隐藏到托盘，而不是退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
