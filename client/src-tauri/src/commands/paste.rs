use crate::context::{AppContext, ContextDetector};
use crate::inject;
use crate::window::WindowState;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct PasteResult {
    pub ok: bool,
    pub strategy: Option<String>,
    pub reason: Option<String>,
    pub detail: Option<String>,
    /// True when paste used SendInput on a Chromium window — can't verify success.
    #[serde(default)]
    pub uncertain: bool,
}

/// paste_text accepts optional pre-probed hwnd/focusHwnd from the frontend.
/// When provided, it uses inject_text_to_hwnd which skips re-capturing context
/// (avoids the stale-foreground-window problem after PTT release).
#[tauri::command]
pub fn paste_text(
    text: String,
    hwnd: Option<String>,
    focus_hwnd: Option<String>,
    restore_clipboard: Option<bool>,
    app: AppHandle,
    window_state: State<WindowState>,
) -> Result<PasteResult, String> {
    let restore_clipboard = restore_clipboard.unwrap_or(false);
    let result = match hwnd.as_deref() {
        Some(h) if !h.is_empty() && h != "0" => {
            let target_val = h.parse::<isize>().unwrap_or(0);
            let focus_val = focus_hwnd
                .as_deref()
                .and_then(|f| f.parse::<isize>().ok())
                .unwrap_or(0);
            crate::commands::system::write_log_line(&format!(
                "[RUST] [paste] pre-probed hwnd target={} focus={}",
                target_val, focus_val
            ));
            inject::inject_text_to_hwnd(&text, target_val, focus_val, restore_clipboard)
        }
        _ => {
            crate::commands::system::write_log_line(
                "[RUST] [paste] no pre-probed hwnd, fallback to inject_text",
            );
            inject::inject_text(&text, restore_clipboard)
        }
    };

    // If injection failed because target is not editable, trigger overlay fallback
    if !result.ok {
        if result.reason.as_deref() == Some("not_editable") {
            let _ = inject_to_clipboard(&text);

            let fallback_data = serde_json::json!({
                "state": "fallback",
                "text": text,
                "reason": "not_editable",
            });
            window_state.update_overlay_state(&app, &fallback_data);
        }
    }

    Ok(PasteResult {
        ok: result.ok,
        strategy: result.strategy,
        reason: result.reason,
        detail: result.detail,
        uncertain: result.uncertain,
    })
}

#[tauri::command]
pub fn get_probe_result(detector: State<ContextDetector>) -> Result<Value, String> {
    let started_at = chrono::Utc::now().timestamp_millis();
    let ctx = detector.capture("probe");
    let completed_at = chrono::Utc::now().timestamp_millis();

    Ok(probe_result_for_context(&ctx, started_at, completed_at))
}

/// 录音启动只捕获一次前台窗口，同时返回提示词路由所需的完整上下文与插字探测结果。
/// 过去前端连续调用 get_active_app_context + get_probe_result，底层 UI Automation 会
/// 对同一个窗口完整扫描两遍，既增加热键延迟，也给两次捕获之间的焦点变化留下竞态。
#[tauri::command]
pub fn get_recording_context(
    include_text_context: Option<bool>,
    detector: State<ContextDetector>,
) -> Result<Value, String> {
    let started_at = chrono::Utc::now().timestamp_millis();
    let ctx = detector.capture_recording("recording_start", include_text_context.unwrap_or(false));
    let completed_at = chrono::Utc::now().timestamp_millis();
    let app_context = serde_json::to_value(&ctx).map_err(|e| e.to_string())?;
    let probe = probe_result_for_context(&ctx, started_at, completed_at);

    Ok(serde_json::json!({
        "appContext": app_context,
        "probe": probe,
    }))
}

fn probe_result_for_context(ctx: &AppContext, started_at: i64, completed_at: i64) -> Value {
    // 与 inject 共用同一个判据实现，顺带拿到「结论是哪一层给出的」
    let gate = crate::inject::editability_gate(ctx);
    let editable = gate.is_editable();

    // Check if the target is our own process
    let is_current_app_process = {
        let self_pid = std::process::id();
        ctx.pid == self_pid
    };

    // Build a verdict string
    let verdict = if is_current_app_process {
        "self_process"
    } else if editable {
        "editable"
    } else {
        "not_editable"
    };

    let probe_id = started_at; // use timestamp as probe ID

    serde_json::json!({
        "editable": editable,
        "hwnd": &ctx.hwnd,
        "focusHwnd": &ctx.focus_hwnd,
        "pid": ctx.pid,
        "tid": ctx.tid,
        "process": &ctx.process_name,
        // not_editable 时前端只把这个 detail 串记进日志（见 RecorderOrchestrator 的
        // "Target is not editable"），所以四层判据的输入和结论都得在里面 —— 缺了的话
        // 日志只能说明"被拦了"，说不出是哪一层落空。
        "detail": crate::inject::describe_editability(ctx, gate),
        // 结构化的同一件事，供诊断界面直接展示，不必让前端再解析 detail 串
        "gate": gate.as_str(),
        "hasCaret": ctx.has_caret,
        "windowClass": &ctx.window_class,
        "focusClass": &ctx.focus_class,
        "controlType": &ctx.control_type,
        "automationId": &ctx.automation_id,
        "isValuePatternAvailable": ctx.is_value_pattern_available,
        "isTextPatternAvailable": ctx.is_text_pattern_available,
        "isTextPattern2Available": ctx.is_text_pattern2_available,
        "isKeyboardFocusable": ctx.is_keyboard_focusable,
        "isEnabled": ctx.is_enabled,
        "isReadOnly": ctx.is_read_only,
        "verdict": verdict,
        "probeId": probe_id,
        "startedAt": started_at,
        "completedAt": completed_at,
        "isCurrentAppProcess": is_current_app_process,
    })
}

#[tauri::command]
pub fn get_active_app_context(detector: State<ContextDetector>) -> Result<Option<Value>, String> {
    let ctx = detector.capture("query");
    let val = serde_json::to_value(&ctx).map_err(|e| e.to_string())?;
    Ok(Some(val))
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    inject_to_clipboard(&text).map_err(|e| e.to_string())
}

fn inject_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        unsafe {
            if crate::inject::set_clipboard_with_retry_pub(text, 5, 30) {
                Ok(())
            } else {
                Err("clipboard write failed".to_string())
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        crate::inject::copy_to_clipboard(text)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = text;
        Err("not implemented on this platform".to_string())
    }
}
