//! SayIt 自定义托盘菜单窗口。
//!
//! Windows 原生菜单有系统级最小宽度，缩短文案也不会继续变窄；这里改用一个预创建、
//! 隐藏的轻量 WebView 窗口。右键时只定位并显示，避免每次创建 WebView 的延迟。

use crate::storage::Storage;
use serde_json::json;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State,
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

pub const TRAY_MENU_LABEL: &str = "tray-menu";
#[cfg_attr(target_os = "macos", allow(dead_code))]
const TRAY_MENU_WIDTH: f64 = 140.0;
#[cfg_attr(target_os = "macos", allow(dead_code))]
const TRAY_MENU_HEIGHT: f64 = 112.0;

/// macOS 不用这个窗口（见 build_macos_tray）。
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn create_tray_menu_window(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(TRAY_MENU_LABEL).is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        TRAY_MENU_LABEL,
        WebviewUrl::App("tray-menu.html".into()),
    )
    .title("SayIt")
    .inner_size(TRAY_MENU_WIDTH, TRAY_MENU_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .focused(false)
    .visible(false)
    .build()?;

    // 原生菜单点击外部会自动收起；自定义窗口用失焦还原同样的交互。
    let window_to_hide = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) {
            let _ = window_to_hide.hide();
        }
    });

    Ok(())
}

/// 在托盘图标旁边显示菜单。`position` 是 Tauri 给出的全局物理坐标。
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn show_tray_menu(app: &AppHandle, position: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) else {
        log::warn!("[tray-menu] window is missing");
        return;
    };

    let monitor = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            position.x >= origin.x as f64
                && position.x < (origin.x as f64 + size.width as f64)
                && position.y >= origin.y as f64
                && position.y < (origin.y as f64 + size.height as f64)
        })
        .or_else(|| app.primary_monitor().ok().flatten());

    let (left, top, right, bottom, scale) = monitor
        .as_ref()
        .map(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            (
                origin.x as f64,
                origin.y as f64,
                origin.x as f64 + size.width as f64,
                origin.y as f64 + size.height as f64,
                monitor.scale_factor(),
            )
        })
        .unwrap_or((0.0, 0.0, 1920.0, 1080.0, 1.0));

    // TRAY_MENU_* 是 CSS px 的设计尺寸，不是能直接乘 scale 的逻辑尺寸：webview 里 1 CSS px
    // 可能是 `scale × css_zoom` 个设备像素（Windows 辅助功能的文本大小会被 WebView2 当页面
    // 缩放叠上来）。少乘这一份，菜单内容就会从底部溢出、被 .tray-menu-shell 的
    // overflow:hidden 裁掉——3 个 30px 的条目加分隔线本来只剩 1px 余量，「退出」会被切掉。
    let css_zoom = app.state::<crate::window::WindowState>().css_zoom();
    let width = TRAY_MENU_WIDTH * css_zoom * scale;
    let height = TRAY_MENU_HEIGHT * css_zoom * scale;
    let gap = 8.0 * scale;
    let edge = 8.0 * scale;
    let monitor_width = right - left;
    let monitor_height = bottom - top;

    // 兼容任务栏停靠在上、下、左、右。常见的底部任务栏让菜单右边缘稍微越过
    // 光标中心，与 Windows 原生菜单从托盘图标向左展开的视觉锚点一致。
    let (mut x, mut y) = if position.y >= top + monitor_height * 0.75 {
        (position.x - width + 22.0 * scale, position.y - height - gap)
    } else if position.y <= top + monitor_height * 0.25 {
        (position.x - width + 22.0 * scale, position.y + gap)
    } else if position.x <= left + monitor_width * 0.25 {
        (position.x + gap, position.y - height / 2.0)
    } else {
        (position.x - width - gap, position.y - height / 2.0)
    };
    x = x.clamp(left + edge, (right - width - edge).max(left + edge));
    y = y.clamp(top + edge, (bottom - height - edge).max(top + edge));

    // 用物理像素设尺寸：上面的定位算的就是物理像素，走 Logical 会用窗口自己当前的
    // scale 再换算一遍，跨显示器移动时两者可能不是同一个值。ceil 同理不留取整亏损。
    let _ = window.set_size(Size::Physical(PhysicalSize::new(
        width.ceil() as u32,
        height.ceil() as u32,
    )));
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    )));
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();

    let enabled = current_ai_enabled(app.state::<Storage>().inner());
    let _ = window.emit("tray-menu-open", json!({ "enabled": enabled }));
}

fn current_ai_enabled(storage: &Storage) -> bool {
    storage.get("aiEnabled", None).as_bool().unwrap_or(true)
}

fn hide_menu(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        let _ = window.hide();
    }
}

fn show_main(app: &AppHandle) {
    hide_menu(app);
    if let Some(window) = app.get_webview_window("main") {
        crate::window::show_main_window(&window);
    }
}

#[tauri::command]
pub fn set_tray_ai_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    // 主窗口里的开关已经负责落库；这里只把最新状态推给独立的托盘菜单 WebView。
    let _ = app.emit_to(
        TRAY_MENU_LABEL,
        "tray-ai-state",
        json!({ "enabled": enabled }),
    );
    #[cfg(target_os = "macos")]
    sync_macos_ai_item(&app, enabled);
    Ok(())
}

#[tauri::command]
pub fn get_tray_ai_enabled(storage: State<'_, Storage>) -> bool {
    current_ai_enabled(storage.inner())
}

#[tauri::command]
pub fn toggle_tray_ai_enabled(
    app: AppHandle,
    storage: State<'_, Storage>,
) -> Result<bool, String> {
    toggle_ai_enabled(&app, storage.inner())
}

/// 托盘里切换 AI 整理：落库并通知主窗口（主窗口 store 同步内存与录音器缓存）和托盘菜单。
fn toggle_ai_enabled(app: &AppHandle, storage: &Storage) -> Result<bool, String> {
    let next = !current_ai_enabled(storage);
    storage
        .set("aiEnabled", &json!(next))
        .map_err(|error| error.to_string())?;

    // 主窗口 store 会同步内存与录音器缓存；托盘窗口也立即刷新自己的图标。
    let _ = app.emit("ai-cleanup-changed", json!({ "enabled": next }));
    let _ = app.emit_to(
        TRAY_MENU_LABEL,
        "tray-ai-state",
        json!({ "enabled": next }),
    );
    #[cfg(target_os = "macos")]
    sync_macos_ai_item(app, next);
    log::info!("[tray-menu] AI cleanup toggled to {next}");
    Ok(next)
}

// ─── macOS 菜单栏 ───
//
// mac 上不用自绘的 HTML 菜单：那是为了绕开 Windows 原生菜单的最小宽度，而 macOS 菜单栏
// 菜单本来就按内容定宽，原生菜单也更符合用户习惯（点一下图标就弹出、点外面自动收起）。

/// 菜单栏图标菜单里各项的句柄：「AI 整理」状态变化时更新勾选，切换界面语言时改文字。
#[cfg(target_os = "macos")]
pub struct MacTrayMenu {
    open_item: tauri::menu::MenuItem<tauri::Wry>,
    ai_item: tauri::menu::CheckMenuItem<tauri::Wry>,
    quit_item: tauri::menu::MenuItem<tauri::Wry>,
}

/// 与 Windows 托盘菜单的三项一致：打开、AI 整理、退出。
#[cfg(target_os = "macos")]
struct MacTrayLabels {
    open: &'static str,
    ai: &'static str,
    quit: &'static str,
}

#[cfg(target_os = "macos")]
fn sync_macos_ai_item(app: &AppHandle, enabled: bool) {
    if let Some(menu) = app.try_state::<MacTrayMenu>() {
        let _ = menu.ai_item.set_checked(enabled);
    }
}

/// 原生菜单的文字跟随界面语言设置（`ui.language`：auto 时跟系统）。
#[cfg(target_os = "macos")]
fn macos_ui_is_chinese(storage: &Storage) -> bool {
    let setting = storage.get("ui.language", None);
    match setting.as_str() {
        Some("zh-CN") => true,
        Some("en") => false,
        _ => matches!(crate::locale::system_ui_lang(), crate::locale::Lang::ZhCn),
    }
}

#[cfg(target_os = "macos")]
fn macos_tray_labels(storage: &Storage) -> MacTrayLabels {
    if macos_ui_is_chinese(storage) {
        MacTrayLabels { open: "打开 SayIt", ai: "AI 整理", quit: "退出 SayIt" }
    } else {
        MacTrayLabels { open: "Open SayIt", ai: "AI cleanup", quit: "Quit SayIt" }
    }
}

#[cfg(target_os = "macos")]
const APP_MENU_ABOUT: &str = "app-about";
#[cfg(target_os = "macos")]
const APP_MENU_SETTINGS: &str = "app-settings";

/// macOS 屏幕顶部菜单栏里本程序的菜单（SayIt / 编辑 / 窗口），文字跟随界面语言。
///
/// 不用 Tauri 的默认菜单：那套是英文的，还带着用不上的「File」「View」「Help」。
/// 「编辑」菜单不能省：WKWebView 里输入框的 ⌘C / ⌘V / ⌘X / ⌘A / ⌘Z 要靠它的快捷键才生效。
#[cfg(target_os = "macos")]
fn build_macos_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

    let zh = macos_ui_is_chinese(app.state::<Storage>().inner());
    let l = |zh_text: &'static str, en_text: &'static str| if zh { zh_text } else { en_text };

    let about = MenuItemBuilder::with_id(APP_MENU_ABOUT, l("关于 SayIt", "About SayIt")).build(app)?;
    let settings = MenuItemBuilder::with_id(APP_MENU_SETTINGS, l("设置…", "Settings…"))
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "SayIt")
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some(l("服务", "Services")))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some(l("隐藏 SayIt", "Hide SayIt")))?)
        .item(&PredefinedMenuItem::hide_others(app, Some(l("隐藏其他", "Hide Others")))?)
        .item(&PredefinedMenuItem::show_all(app, Some(l("全部显示", "Show All")))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some(l("退出 SayIt", "Quit SayIt")))?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, l("编辑", "Edit"))
        .item(&PredefinedMenuItem::undo(app, Some(l("撤销", "Undo")))?)
        .item(&PredefinedMenuItem::redo(app, Some(l("重做", "Redo")))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some(l("剪切", "Cut")))?)
        .item(&PredefinedMenuItem::copy(app, Some(l("拷贝", "Copy")))?)
        .item(&PredefinedMenuItem::paste(app, Some(l("粘贴", "Paste")))?)
        .item(&PredefinedMenuItem::select_all(app, Some(l("全选", "Select All")))?)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, l("窗口", "Window"))
        .item(&PredefinedMenuItem::minimize(app, Some(l("最小化", "Minimize")))?)
        .item(&PredefinedMenuItem::maximize(app, Some(l("缩放", "Zoom")))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some(l("关闭窗口", "Close Window")))?)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

/// 装上 macOS 应用菜单，并处理「关于」「设置…」两项（其余是系统自带的标准项）。
#[cfg(target_os = "macos")]
pub fn install_macos_app_menu(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build_macos_app_menu(app)?)?;
    app.on_menu_event(|app, event| {
        let page_event = match event.id().as_ref() {
            APP_MENU_ABOUT => "open-about",
            APP_MENU_SETTINGS => "open-settings",
            _ => return,
        };
        show_main(app);
        let _ = app.emit(page_event, ());
    });
    Ok(())
}

/// 界面语言切换后刷新 mac 的原生菜单：顶部应用菜单、菜单栏图标的菜单。
/// Windows 的托盘菜单是网页，会自己跟着界面语言变，这里什么都不做。
#[tauri::command]
pub fn refresh_native_menus(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Some(menu) = app.try_state::<MacTrayMenu>() {
            let labels = macos_tray_labels(app.state::<Storage>().inner());
            let _ = menu.open_item.set_text(labels.open);
            let _ = menu.ai_item.set_text(labels.ai);
            let _ = menu.quit_item.set_text(labels.quit);
        }
        match build_macos_app_menu(&app) {
            Ok(menu) => {
                let _ = app.set_menu(menu);
            }
            Err(error) => log::warn!("[app-menu] rebuild failed: {error}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// 建菜单栏图标：单色模板图（系统按浅色/深色菜单栏自动着色），点击弹出原生菜单。
#[cfg(target_os = "macos")]
pub fn build_macos_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let storage = app.state::<Storage>();
    let labels = macos_tray_labels(storage.inner());
    let open = MenuItemBuilder::with_id("tray-open", labels.open).build(app)?;
    let ai = CheckMenuItemBuilder::with_id("tray-ai", labels.ai)
        .checked(current_ai_enabled(storage.inner()))
        .build(app)?;
    // mac 菜单的惯例是在「退出」旁标出 ⌘Q（只在菜单展开时生效，和顶部应用菜单的 ⌘Q 不冲突）
    let quit = MenuItemBuilder::with_id("tray-quit", labels.quit)
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&ai)
        .separator()
        .item(&quit)
        .build()?;
    app.manage(MacTrayMenu { open_item: open, ai_item: ai, quit_item: quit });

    let icon = tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-template.png"))?;
    TrayIconBuilder::with_id("sayit-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("SayIt")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => show_main(app),
            "tray-ai" => {
                let storage = app.state::<Storage>();
                if let Err(error) = toggle_ai_enabled(app, storage.inner()) {
                    log::warn!("[tray-menu] toggle AI cleanup failed: {error}");
                    // 原生勾选项点一下就会自己翻转，失败时要翻回去
                    sync_macos_ai_item(app, current_ai_enabled(storage.inner()));
                }
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn show_main_from_tray(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
pub fn hide_tray_menu(app: AppHandle) {
    hide_menu(&app);
}

#[tauri::command]
pub fn quit_from_tray(app: AppHandle) {
    app.exit(0);
}
