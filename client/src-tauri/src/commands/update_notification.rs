use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "update-notification";
const STATE_EVENT: &str = "update-notification-state";

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct NotificationSnapshot {
    revision: u64,
    data: Option<NotificationData>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationData {
    version: String,
    current_version: String,
    theme: String,
    locale: String,
    installing: bool,
    install_failed: bool,
}

#[derive(Default)]
struct NotificationInner {
    snapshot: NotificationSnapshot,
    monitor_center: Option<(i32, i32)>,
}

#[derive(Default)]
pub struct UpdateNotificationState(Mutex<NotificationInner>);

/// 必须异步创建 WebView，避免 Windows 主线程等待页面初始化时死锁。
#[tauri::command]
pub async fn sync_update_notification(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdateNotificationState>,
    snapshot: NotificationSnapshot,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can publish update state".into());
    }
    {
        let mut inner = state.0.lock().map_err(|e| e.to_string())?;
        if snapshot.revision <= inner.snapshot.revision {
            return Ok(());
        }
        if inner.snapshot.data.is_none() && snapshot.data.is_some() {
            inner.monitor_center = crate::context::capture_foreground_monitor().map(|work| {
                (
                    ((work.left as i64 + work.right as i64) / 2) as i32,
                    ((work.top as i64 + work.bottom as i64) / 2) as i32,
                )
            });
        }
        inner.snapshot = snapshot.clone();
    }

    if snapshot.data.is_none() {
        if let Some(notification) = app.get_webview_window(LABEL) {
            notification.hide().map_err(|e| e.to_string())?;
            notification.emit(STATE_EVENT, &snapshot).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let notification = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => {
            let notification = WebviewWindowBuilder::new(
                &app,
                LABEL,
                WebviewUrl::App("update-notification.html".into()),
            )
            .title("SayIt Update")
            .inner_size(244.0, 128.0)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .focused(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;

            // Alt+F4 与卡片的关闭按钮语义一致，隐藏由主窗口统一处理。
            let app_for_close = app.clone();
            notification.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let state = app_for_close.state::<UpdateNotificationState>();
                    if let Ok(inner) = state.0.lock() {
                        if let Some(data) = &inner.snapshot.data {
                            let _ = app_for_close.emit_to(
                                "main",
                                "update-notification-action",
                                serde_json::json!({ "action": "later", "version": data.version }),
                            );
                        }
                    };
                }
            });
            notification
        }
    };
    // 首次发送可能早于前端监听；get_update_notification 提供同一份快照补齐。
    notification.emit(STATE_EVENT, &snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_update_notification(
    state: State<'_, UpdateNotificationState>,
) -> Result<NotificationSnapshot, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.snapshot.clone())
}

/// 前端布局完成后才展示，revision 防止延迟的 ResizeObserver 把已关闭卡片重新打开。
#[tauri::command]
pub async fn fit_update_notification(
    app: AppHandle,
    window: WebviewWindow,
    revision: u64,
    width: f64,
    height: f64,
    device_pixel_ratio: f64,
) -> Result<(), String> {
    if window.label() != LABEL {
        return Err("Only the update notification can size itself".into());
    }
    if ![width, height, device_pixel_ratio].iter().all(|n| n.is_finite() && *n > 0.0) {
        return Err("Invalid notification dimensions".into());
    }
    // 校验状态与显示窗口在 UI 线程内完成，避免关闭和延迟的布局请求交错。
    // 不能在工作线程持锁调用窗口 API：同步命令或 CloseRequested 回调也可能要读状态。
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = fit_on_main_thread(&handle, &window, revision, width, height, device_pixel_ratio);
        let _ = sender.try_send(result);
    }).map_err(|e| e.to_string())?;
    receiver.recv().await.ok_or("Notification layout was cancelled")?
}

fn fit_on_main_thread(
    app: &AppHandle,
    window: &WebviewWindow,
    revision: u64,
    width: f64,
    height: f64,
    device_pixel_ratio: f64,
) -> Result<(), String> {
    let state = app.state::<UpdateNotificationState>();
    let inner = state.0.lock().map_err(|e| e.to_string())?;
    if inner.snapshot.data.is_none() || inner.snapshot.revision != revision {
        return Ok(());
    }
    let monitor = app.available_monitors().map_err(|e| e.to_string())?
        .into_iter()
        .find(|monitor| {
            inner.monitor_center.is_some_and(|(x, y)| {
                // macOS：前台窗口中心是逻辑点，显示器矩形是「逻辑点 × 该屏缩放」，先换成同一单位
                #[cfg(target_os = "macos")]
                let (x, y) = {
                    let scale = monitor.scale_factor();
                    ((x as f64 * scale).round() as i32, (y as f64 * scale).round() as i32)
                };
                let p = monitor.position();
                let s = monitor.size();
                x as i64 >= p.x as i64 && (x as i64) < p.x as i64 + s.width as i64
                    && y as i64 >= p.y as i64 && (y as i64) < p.y as i64 + s.height as i64
            })
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("No monitor available")?;
    #[cfg(not(target_os = "macos"))]
    let work = monitor.work_area();
    // macOS：Tauri 的工作区少扣了菜单栏，见 window::macos_work_area
    #[cfg(target_os = "macos")]
    let work = &crate::window::macos_work_area(&monitor);
    // Windows「文本大小」会给 WebView2 叠加缩放，CSS px 不能直接当成 Tauri 逻辑像素。
    let css_zoom = (device_pixel_ratio / window.scale_factor().map_err(|e| e.to_string())?).clamp(0.5, 4.0);
    let (x, y, w, h) = notification_bounds(
        (work.position.x, work.position.y, work.size.width, work.size.height),
        monitor.scale_factor(),
        (width.min(2000.0) * css_zoom, height.min(2000.0) * css_zoom),
    );
    let size = PhysicalSize::new(w, h);
    let position = PhysicalPosition::new(x, y);
    if window.inner_size().ok() != Some(size) {
        window.set_size(size).map_err(|e| e.to_string())?;
    }
    if window.outer_position().ok() != Some(position) {
        window.set_position(position).map_err(|e| e.to_string())?;
    }
    if !window.is_visible().unwrap_or(false) {
        show_without_activation(window)?;
    }
    Ok(())
}

fn notification_bounds(work: (i32, i32, u32, u32), scale: f64, design: (f64, f64)) -> (i32, i32, u32, u32) {
    let (left, top, work_width, work_height) = work;
    let gap = (8.0 * scale).round().max(1.0) as u32;
    // 与语音悬浮窗一致：工作区底部居中，离底边 72 个逻辑像素。
    // 前端底部留白也与 Overlay 的 pb-4 对齐，因此可见卡片底边位置相同。
    let bottom_gap = (72.0 * scale).round().max(gap as f64) as u32;
    let width = ((design.0 * scale).ceil().max(1.0) as u32).min(work_width.saturating_sub(gap * 2).max(1));
    let height = ((design.1 * scale).ceil().max(1.0) as u32).min(work_height.saturating_sub(gap * 2).max(1));
    let x = left as i64 + (work_width.saturating_sub(width) / 2) as i64;
    let min_y = (gap as i64).min(work_height.saturating_sub(height) as i64);
    let max_y = (work_height as i64 - height as i64 - gap as i64).max(min_y);
    let y = top as i64 + (work_height as i64 - height as i64 - bottom_gap as i64).clamp(min_y, max_y);
    (x as i32, y as i32, width, height)
}

#[cfg(windows)]
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        SetWindowPos(HWND(hwnd.0 as _), HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            .map_err(|e| e.to_string())
    }
}

/// macOS：`show()` 会把它设成 key window；改用 orderFrontRegardless 不动键盘焦点，
/// 并设成和语音悬浮窗一样的悬浮层（高层级、跨桌面空间、失活不隐藏）。
#[cfg(target_os = "macos")]
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            if let Ok(ns_window) = target.ns_window() {
                unsafe {
                    crate::platform::macos::appkit::configure_overlay_window(ns_window);
                    crate::platform::macos::appkit::order_front_regardless(ns_window);
                }
            }
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn show_without_activation(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::notification_bounds;

    #[test]
    fn centers_above_the_same_bottom_gap_as_the_voice_overlay() {
        assert_eq!(
            notification_bounds((0, 0, 2560, 1400), 1.5, (244.0, 128.0)),
            (1097, 1100, 366, 192),
        );
    }

    #[test]
    fn supports_monitors_left_of_primary_and_large_text() {
        assert_eq!(
            notification_bounds((-1920, -200, 1920, 1040), 1.0, (488.0, 256.0)),
            (-1204, 512, 488, 256),
        );
    }

    #[test]
    fn clamps_large_cards_inside_small_work_areas() {
        let (x, y, width, height) = notification_bounds((100, 200, 320, 240), 2.0, (1536.0, 1280.0));
        assert_eq!((x, y, width, height), (116, 216, 288, 208));
    }
}
