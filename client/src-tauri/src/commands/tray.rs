//! 托盘（Windows）/ 菜单栏（macOS）图标和它的原生菜单，外加 macOS 顶部的应用菜单。
//!
//! Windows 上曾经用一个预创建、隐藏的 WebView 窗口自绘托盘菜单（为了绕开原生菜单的
//! 系统最小宽度、做出带开关的样式）。2026-10 去掉了：那个窗口常驻一个 WebView2 渲染进程，
//! 只为一个三项菜单，内存不值；还额外背着 CSS 缩放、跨屏定位、失焦收起这些自己造的轮子。
//! 现在两个平台都用原生菜单，别为了样式再改回网页菜单（见 .kiro/decisions.md）。

use crate::storage::Storage;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// 托盘菜单里各项的句柄：「AI 整理」状态变化时更新勾选，切换界面语言时改文字。
pub struct TrayMenu {
    open_item: tauri::menu::MenuItem<tauri::Wry>,
    ai_item: tauri::menu::CheckMenuItem<tauri::Wry>,
    quit_item: tauri::menu::MenuItem<tauri::Wry>,
}

/// 三项：打开、AI 整理、退出。
///
/// 「AI 整理」两套文字都要：原生勾选项关闭时只是**没有对勾**，一眼看不出是关着还是
/// 这一项本来就没有勾选状态（用户反馈）。所以文字里再写明状态，勾 + 括号两个信号。
struct TrayLabels {
    open: &'static str,
    ai_on: &'static str,
    ai_off: &'static str,
    quit: &'static str,
}

impl TrayLabels {
    fn ai(&self, enabled: bool) -> &'static str {
        if enabled {
            self.ai_on
        } else {
            self.ai_off
        }
    }
}

const TRAY_OPEN: &str = "tray-open";
const TRAY_AI: &str = "tray-ai";
const TRAY_QUIT: &str = "tray-quit";

fn current_ai_enabled(storage: &Storage) -> bool {
    storage.get("aiEnabled", None).as_bool().unwrap_or(true)
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        crate::window::show_main_window(&window);
    }
}

/// 勾选和括号里的状态文字一起更新，两者必须同源，否则会出现「打着勾、写着已关闭」。
fn sync_ai_item(app: &AppHandle, enabled: bool) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let labels = tray_labels(app.state::<Storage>().inner());
        let _ = menu.ai_item.set_checked(enabled);
        let _ = menu.ai_item.set_text(labels.ai(enabled));
    }
}

/// 原生菜单的文字跟随界面语言设置（`ui.language`：auto 时跟系统）。
/// 原生菜单不在网页里，前端的 i18n 管不到它，所以 Rust 自己判一次。
fn ui_is_chinese(storage: &Storage) -> bool {
    let setting = storage.get("ui.language", None);
    match setting.as_str() {
        Some("zh-CN") => true,
        Some("en") => false,
        _ => matches!(crate::locale::system_ui_lang(), crate::locale::Lang::ZhCn),
    }
}

fn tray_labels(storage: &Storage) -> TrayLabels {
    let zh = ui_is_chinese(storage);
    // mac 菜单的惯例是「退出 SayIt」；Windows 托盘菜单惯例只写「退出」，与原来的网页菜单一致。
    let quit = match (zh, cfg!(target_os = "macos")) {
        (true, true) => "退出 SayIt",
        (true, false) => "退出",
        (false, true) => "Quit SayIt",
        (false, false) => "Quit",
    };
    if zh {
        TrayLabels { open: "打开 SayIt", ai_on: "AI 整理（已开启）", ai_off: "AI 整理（已关闭）", quit }
    } else {
        TrayLabels { open: "Open SayIt", ai_on: "AI cleanup (on)", ai_off: "AI cleanup (off)", quit }
    }
}

/// 主窗口里切换「AI 整理」后，同步托盘菜单的勾选（主窗口的开关已经负责落库）。
#[tauri::command]
pub fn set_tray_ai_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    sync_ai_item(&app, enabled);
    Ok(())
}

/// 托盘里切换 AI 整理：落库并通知主窗口（主窗口 store 同步内存与录音器缓存）。
fn toggle_ai_enabled(app: &AppHandle, storage: &Storage) -> Result<bool, String> {
    let next = !current_ai_enabled(storage);
    storage
        .set("aiEnabled", &json!(next))
        .map_err(|error| error.to_string())?;
    let _ = app.emit("ai-cleanup-changed", json!({ "enabled": next }));
    sync_ai_item(app, next);
    log::info!("[tray-menu] AI cleanup toggled to {next}");
    Ok(next)
}

/// 托盘图标。Windows：由 256px 原图直接生成的几档尺寸，按主窗所在屏幕的缩放比例选最接近
/// 托盘槽位的那张，避免 256 → 32 → 系统实际尺寸的二次缩放（小图做过轻微锐化）。
#[cfg(not(target_os = "macos"))]
fn tray_icon(app: &AppHandle) -> tauri::Result<tauri::image::Image<'static>> {
    let tray_scale = app
        .get_webview_window("main")
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(1.0);
    let (bytes, size): (&'static [u8], u32) = if tray_scale >= 1.75 {
        (include_bytes!("../../icons/tray-32.png"), 32)
    } else if tray_scale >= 1.375 {
        (include_bytes!("../../icons/tray-24.png"), 24)
    } else if tray_scale >= 1.125 {
        (include_bytes!("../../icons/tray-20.png"), 20)
    } else {
        (include_bytes!("../../icons/tray-16.png"), 16)
    };
    log::info!("[tray] icon size={}px for scale factor {:.2}", size, tray_scale);
    tauri::image::Image::from_bytes(bytes)
}

/// macOS：单色模板图，系统按浅色/深色菜单栏自动着色。
#[cfg(target_os = "macos")]
fn tray_icon(_app: &AppHandle) -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-template.png"))
}

/// 建托盘图标和原生菜单。
///
/// - Windows：左键打开主窗口，右键弹菜单（系统托盘的惯例）。
/// - macOS：点一下就弹菜单（菜单栏图标的惯例），打开主窗口走菜单第一项。
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let storage = app.state::<Storage>();
    let labels = tray_labels(storage.inner());
    let ai_enabled = current_ai_enabled(storage.inner());
    let open = MenuItemBuilder::with_id(TRAY_OPEN, labels.open).build(app)?;
    let ai = CheckMenuItemBuilder::with_id(TRAY_AI, labels.ai(ai_enabled))
        .checked(ai_enabled)
        .build(app)?;
    let quit_builder = MenuItemBuilder::with_id(TRAY_QUIT, labels.quit);
    // mac 菜单的惯例是在「退出」旁标出 ⌘Q（只在菜单展开时生效，和顶部应用菜单的 ⌘Q 不冲突）。
    // Windows 托盘菜单没有这个惯例，标了反而像是全局快捷键。
    #[cfg(target_os = "macos")]
    let quit_builder = quit_builder.accelerator("CmdOrCtrl+Q");
    let quit = quit_builder.build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&ai)
        .separator()
        .item(&quit)
        .build()?;
    app.manage(TrayMenu { open_item: open, ai_item: ai, quit_item: quit });

    let builder = TrayIconBuilder::with_id("sayit-tray")
        .icon(tray_icon(app)?)
        .tooltip("SayIt")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => show_main(app),
            TRAY_AI => {
                let storage = app.state::<Storage>();
                if let Err(error) = toggle_ai_enabled(app, storage.inner()) {
                    log::warn!("[tray-menu] toggle AI cleanup failed: {error}");
                    // 原生勾选项点一下就会自己翻转，失败时要翻回去
                    sync_ai_item(app, current_ai_enabled(storage.inner()));
                }
            }
            TRAY_QUIT => app.exit(0),
            _ => {}
        });

    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    #[cfg(not(target_os = "macos"))]
    let builder = builder.on_tray_icon_event(|tray, event| {
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            show_main(tray.app_handle());
        }
    });

    builder.build(app)?;
    Ok(())
}

// ─── macOS 顶部菜单栏里的应用菜单 ───

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

    let zh = ui_is_chinese(app.state::<Storage>().inner());
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

/// 界面语言切换后刷新原生菜单：托盘菜单（两个平台），以及 mac 的顶部应用菜单。
#[tauri::command]
pub fn refresh_native_menus(app: AppHandle) {
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let storage = app.state::<Storage>();
        let labels = tray_labels(storage.inner());
        let _ = menu.open_item.set_text(labels.open);
        let _ = menu.ai_item.set_text(labels.ai(current_ai_enabled(storage.inner())));
        let _ = menu.quit_item.set_text(labels.quit);
    }
    #[cfg(target_os = "macos")]
    match build_macos_app_menu(&app) {
        Ok(menu) => {
            let _ = app.set_menu(menu);
        }
        Err(error) => log::warn!("[app-menu] rebuild failed: {error}"),
    }
}
