use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::system::write_log_line;
use crate::context::{capture_foreground_monitor, MonitorBounds};

const OVERLAY_DEFAULT_BASE_WIDTH: f64 = 360.0;
// 64 而不是刚好够用的 56：内容是底边锚定的（根节点 items-end + pb-4），加高只是在胶囊
// 上方多留一块透明区，底边位置和观感都不变（y = bottom - gap - height，高度抵消掉了），
// 纯粹换取容错。56 时余量只有 2px（16 的 pb-4 + 38 的胶囊 = 54），任何一点缩放误差或
// 日后给胶囊加一根边框都会把顶部裁平——这就是 Windows「文本大小」123% 时的故障现场。
const OVERLAY_BASE_HEIGHT: f64 = 64.0;
const OVERLAY_FALLBACK_WIDTH: f64 = 520.0;
const OVERLAY_FALLBACK_HEIGHT: f64 = 224.0;
/// 识别失败卡片：比结果卡矮，因为它没有文本预览区，只有标题 + 原因 + 可能一行恢复提示。
/// **必须是可交互布局**（见 is_interactive）——它上面有关闭按钮，而非交互布局是点击
/// 穿透的，按钮会点不到。
///
/// 150 → 176：原来那个值是按「原因只占一行」算的，而供应商的错误文案根本不止一行 ——
/// 「账户余额不足，本次请求未能发出。请在供应商后台充值后重试…」在 520px 宽的 text-xs
/// 下就是两行，实测内容高 97（日志 `render ack OK ... content=520x97.33`）。再补上恢复
/// 提示就是 126，而 150 的窗口只能装 134，余量 4px；文案再长一点标题就被 overflow:hidden
/// 从顶部裁掉。176 覆盖「原因三行 + 恢复提示」（146）并留 14px 余量。
/// 520 → 480：三行小字的卡片占 520 显得空，但 440 又太紧 —— 余额不足那条文案（28 字）
/// 会折出「试。」这样只剩一个字加句号的末行。480 让它一行放完。
///
/// **必须与 Overlay.tsx 失败卡的 max-w 一致** —— 卡片比窗口窄时，多出来的透明边照样吞掉
/// 下面程序的点击（这是 is_interactive 布局）；比窗口宽则被 overflow:hidden 裁掉。
///
/// 最长的那条错误文案（err.provider.forbidden，64 字）在 480 下折两行，高度 126，容量内。
const OVERLAY_FAILURE_WIDTH: f64 = 480.0;
const OVERLAY_FAILURE_HEIGHT: f64 = 176.0;
// 流式实时显示：录音气泡 + 波形条堆叠，需要更宽更高的窗口
const OVERLAY_STREAMING_WIDTH: f64 = 480.0;
const OVERLAY_STREAMING_HEIGHT: f64 = 200.0;
// 输入源状态条显示在胶囊上方；窗口仍锚定底部，因此只向上扩展。
const OVERLAY_MIC_HINT_WIDTH: f64 = 480.0;
const OVERLAY_MIC_HINT_HEIGHT: f64 = 104.0;
const OVERLAY_STREAMING_MIC_HINT_HEIGHT: f64 = 244.0;
const OVERLAY_SCREEN_MARGIN: f64 = 8.0;

/// Overlay.tsx 根节点的 `pb-4`，单位是 CSS px。布局仍由 CSS 决定，这里只是镜像值，
/// 用于「内容装不装得下」的自检与单测；改了那边记得同步这里，否则判据会失真。
const OVERLAY_ROOT_PADDING_BOTTOM: f64 = 16.0;

/// webview 的 CSS 缩放相对显示器缩放的额外倍数，可接受范围。
///
/// 为什么需要：Tauri 按「逻辑像素 × 显示器 scale」定窗口大小，而 WebView2 的一个 CSS px
/// 实际是 `显示器 scale × 额外缩放` 个设备像素——Windows 设置 → 辅助功能 → 文本大小
/// （滑块 100%~225% 连续可调）会被 Edge/WebView2 当成页面缩放叠上去。于是窗口按 56 逻辑
/// px 建出来，webview 里只有 56/1.23 ≈ 45.6 CSS px 可用，内容从顶部溢出、被
/// overlay.html 的 `overflow: hidden` 裁平。上限给到 4.0 是留足余量（225% 文本 × 用户
/// 可能另外用 Ctrl+滚轮缩放过共享的 EBWebView profile）。
const OVERLAY_CSS_ZOOM_MIN: f64 = 0.5;
const OVERLAY_CSS_ZOOM_MAX: f64 = 4.0;
/// 发出 blank 之后等多久才真正 hide 窗口（见 `hide_overlay` 里的长注释）。
///
/// 只需要够 webview 出一帧：60Hz 下一帧 16.7ms，80ms 给足了 setState + 重绘 + 合成。
/// 用户看不出差别 —— blank 连胶囊底色都不画，"提示消失"这件事在发 blank 那一刻就完成了，
/// 窗口晚 80ms 消失没有任何视觉痕迹。
const HIDE_AFTER_BLANK_MS: u64 = 80;
const ACK_FIRST_TIMEOUT_MS: u64 = 1_200;
const ACK_SECOND_TIMEOUT_MS: u64 = 700;
const RECOVERY_ACK_TIMEOUT_MS: u64 = 2_000;

/// 旧版轻量 ping/pong 仍保留，便于和历史日志对照。
static LAST_PONG_MS: AtomicI64 = AtomicI64::new(0);
static SHOW_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn record_overlay_pong(_seq: u64) {
    LAST_PONG_MS.store(now_ms(), Ordering::SeqCst);
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, PartialEq)]
enum OverlayLayout {
    Base,
    BaseWithMicHint,
    Fallback,
    /// 识别失败卡片：带关闭按钮，因此同样需要交互。
    Failure,
    /// 流式实时显示：气泡 + 波形，窗口更大且非交互
    Streaming,
    StreamingWithMicHint,
}

impl OverlayLayout {
    /// 该布局是否为可交互（可点击）状态——只有带按钮的卡片需要。
    ///
    /// ⚠️ 非交互布局会 `set_ignore_cursor_events(true)`，窗口整体点击穿透。
    /// 新增任何"有按钮的"状态都必须在这里返回 true，否则按钮在界面上看得见、点不到。
    fn is_interactive(&self) -> bool {
        matches!(self, OverlayLayout::Fallback | OverlayLayout::Failure)
    }

    /// 该布局期望的设计尺寸（宽, 高），单位是 CSS px。
    ///
    /// 注意这**不是**可以直接交给 Tauri 的逻辑尺寸：webview 的 CSS px 可能被额外缩放
    /// （见 OVERLAY_CSS_ZOOM_MIN 的说明），要先乘 css_zoom 才是窗口该有的逻辑尺寸。
    fn dimensions(&self, base_width: f64) -> (f64, f64) {
        match self {
            OverlayLayout::Base => (base_width, OVERLAY_BASE_HEIGHT),
            OverlayLayout::BaseWithMicHint => (
                base_width.max(OVERLAY_MIC_HINT_WIDTH),
                OVERLAY_MIC_HINT_HEIGHT,
            ),
            OverlayLayout::Fallback => (OVERLAY_FALLBACK_WIDTH, OVERLAY_FALLBACK_HEIGHT),
            OverlayLayout::Failure => (OVERLAY_FAILURE_WIDTH, OVERLAY_FAILURE_HEIGHT),
            OverlayLayout::Streaming => (OVERLAY_STREAMING_WIDTH, OVERLAY_STREAMING_HEIGHT),
            OverlayLayout::StreamingWithMicHint => (
                OVERLAY_STREAMING_WIDTH,
                OVERLAY_STREAMING_MIC_HINT_HEIGHT,
            ),
        }
    }
}

pub struct WindowState {
    overlay_layout: Mutex<OverlayLayout>,
    /// 最近一次真正应用到原生窗口的布局。用于跳过重复的 set_position/set_size，
    /// 避免监听期间每 33ms 重设一次窗口几何导致的抖动。
    last_applied_layout: Mutex<Option<OverlayLayout>>,
    overlay_base_width: Mutex<f64>,
    /// webview 里一个 CSS px 相当于几个「显示器逻辑 px」。1.0 表示两者一致。
    /// 由渲染端上报的 devicePixelRatio 除以窗口所在显示器的 scale 得出，见 note_css_zoom。
    overlay_css_zoom: Mutex<f64>,
    overlay_monitor: Mutex<Option<MonitorBounds>>,
    overlay_lifecycle: Mutex<()>,
    latest_overlay_payload: Mutex<Option<Value>>,
    active_show_id: AtomicU64,
    active_generation: AtomicU64,
    show_started_at_ms: AtomicI64,
    last_ack_show_id: AtomicU64,
    last_ack_generation: AtomicU64,
    last_ack_at_ms: AtomicI64,
    recovery_started_show_id: AtomicU64,
    page_load_started_at_ms: AtomicI64,
    page_load_finished_at_ms: AtomicI64,
    renderer_ready_at_ms: AtomicI64,
    /// 进程/状态创建时间，用于日志记录运行时长（配合资源计数排查“长时间运行后悬浮窗失效”）
    created_at: Instant,
}
impl WindowState {
    pub fn new() -> Self {
        Self {
            overlay_layout: Mutex::new(OverlayLayout::Base),
            last_applied_layout: Mutex::new(None),
            overlay_base_width: Mutex::new(OVERLAY_DEFAULT_BASE_WIDTH),
            overlay_css_zoom: Mutex::new(1.0),
            overlay_monitor: Mutex::new(None),
            overlay_lifecycle: Mutex::new(()),
            latest_overlay_payload: Mutex::new(None),
            active_show_id: AtomicU64::new(0),
            active_generation: AtomicU64::new(0),
            show_started_at_ms: AtomicI64::new(0),
            last_ack_show_id: AtomicU64::new(0),
            last_ack_generation: AtomicU64::new(0),
            last_ack_at_ms: AtomicI64::new(0),
            recovery_started_show_id: AtomicU64::new(0),
            page_load_started_at_ms: AtomicI64::new(0),
            page_load_finished_at_ms: AtomicI64::new(0),
            renderer_ready_at_ms: AtomicI64::new(0),
            created_at: Instant::now(),
        }
    }

    /// webview 里 1 个 CSS px 相当于几个显示器逻辑 px。
    pub fn css_zoom(&self) -> f64 {
        *self.overlay_css_zoom.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 记录渲染端上报的 devicePixelRatio，换算成 css_zoom 缓存起来。
    ///
    /// 为什么不直接缓存 dpr：dpr 里同时含了显示器缩放和 webview 的额外缩放，只有除掉
    /// 窗口所在显示器的 scale 才是需要补偿的那一份。缓存 dpr 会在两块不同缩放的显示器
    /// 之间串味（悬浮窗跟着前台窗口跑，换显示器是常态）。
    ///
    /// 返回值表示缓存是否有实质变化，调用方据此决定要不要立刻重设窗口几何。
    fn note_css_zoom(&self, app: &AppHandle, device_pixel_ratio: Option<f64>) -> bool {
        let Some(dpr) = device_pixel_ratio.filter(|value| value.is_finite() && *value > 0.0) else {
            return false;
        };
        let monitor_scale = app
            .get_webview_window("overlay")
            .and_then(|overlay| overlay.scale_factor().ok())
            .or_else(|| app.primary_monitor().ok().flatten().map(|m| m.scale_factor()))
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0);
        let zoom = (dpr / monitor_scale).clamp(OVERLAY_CSS_ZOOM_MIN, OVERLAY_CSS_ZOOM_MAX);

        let previous = {
            let mut cached = self.overlay_css_zoom.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            // 0.01 的死区：dpr 与 scale 都是浮点，每次 present 都上报，末位抖动不该触发
            // 重设几何（重设会带来一帧的位置/尺寸跳动，见 apply_payload_layout 的注释）。
            if (zoom - *cached).abs() < 0.01 {
                return false;
            }
            let previous = *cached;
            *cached = zoom;
            previous
        };

        write_log_line(&format!(
            "[overlay-scale] css zoom {:.4} -> {:.4} dpr={} monitor_scale={}",
            previous, zoom, dpr, monitor_scale,
        ));
        true
    }

    /// 在应用启动后的空闲时段提前创建隐藏的 overlay WebView。
    ///
    /// 第一次口述若等到热键按下后才创建 WebView，页面加载和 React 初始化会额外占用
    /// 数百毫秒。预热只把 renderer 准备好，不显示窗口；真正 present 时仍会重新捕获
    /// 当前前台显示器、应用最终布局并置顶。
    pub fn prewarm_overlay(&self, app: &AppHandle) {
        let _lifecycle_guard = self.overlay_lifecycle.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.active_show_id.load(Ordering::SeqCst) != 0
            || app.get_webview_window("overlay").is_some()
        {
            return;
        }

        let layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let base_width = *self.overlay_base_width.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_log_line("[overlay-health] idle prewarm begin");
        self.create_overlay(app, layout, base_width, false);
    }

    /// 原子地保存状态、显示原生窗口并请求 Overlay 确认本次渲染。
    pub fn present_overlay(&self, app: &AppHandle, data: Value) -> u64 {
        self.apply_payload_layout(&data);
        self.capture_overlay_monitor();
        *self.latest_overlay_payload.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(data);

        let show_id = SHOW_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        self.active_show_id.store(show_id, Ordering::SeqCst);
        self.active_generation.store(0, Ordering::SeqCst);
        self.show_started_at_ms.store(now_ms(), Ordering::SeqCst);
        self.last_ack_show_id.store(0, Ordering::SeqCst);
        self.last_ack_generation.store(0, Ordering::SeqCst);
        self.last_ack_at_ms.store(0, Ordering::SeqCst);
        self.recovery_started_show_id.store(0, Ordering::SeqCst);

        let state_name = self.latest_state_name();
        let (gdi, user_obj) = gui_resource_counts();
        let overlay_visible = app.get_webview_window("overlay").and_then(|o| o.is_visible().ok());
        write_log_line(&format!(
            "[overlay-health] present show_id={} state={} generation=0 uptimeSec={} gdi={} user={} overlayVisible={:?}",
            show_id, state_name, self.created_at.elapsed().as_secs(), gdi, user_obj, overlay_visible,
        ));

        if self.ensure_visible(app, show_id) {
            self.emit_latest(app, true);
        }
        spawn_render_watchdog(app.clone(), show_id);
        spawn_topmost_keeper(app.clone(), show_id);
        show_id
    }

    /// 兼容旧调用点；新代码应使用 present_overlay，将显示和状态更新合成一次操作。
    pub fn show_overlay(&self, app: &AppHandle) -> u64 {
        let data = self.latest_overlay_payload.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
            // 最近一次状态可能是 hide 时写进去的 blank（它专门用来清掉残留帧，
            // 见 hide_overlay）。照它重放会显示一个空窗口，所以当没有状态处理。
            .filter(|payload| payload.get("state").and_then(Value::as_str) != Some("blank"))
            .unwrap_or_else(|| json!({ "state": "waiting", "elapsedSec": 0 }));
        self.present_overlay(app, data)
    }

    pub fn hide_overlay(&self, app: &AppHandle) {
        self.active_show_id.store(0, Ordering::SeqCst);
        *self.overlay_monitor.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        // 下次显示需要重新应用几何。
        *self.last_applied_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;

        let prev_layout = {
            let mut layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous = layout.clone();
            *layout = OverlayLayout::Base;
            previous
        };

        if let Some(overlay) = app.get_webview_window("overlay") {
            // 点击穿透立刻恢复，不等下面那段延迟 —— 否则 fallback 卡片这 80ms 里还会挡鼠标。
            set_overlay_interactivity(&overlay, false);

            // ── 先把内容清空，再隐藏窗口 ──
            //
            // 隐藏只是 hide()，WebView 不销毁、Overlay 组件也不卸载，合成器里留着的最后
            // 一帧就是上一条提示。下次 present 时窗口先显示、新内容要等 IPC + setState +
            // 重绘才到，于是先闪一下**上一次**的文案（用户报的原话：切换润色模式后再按
            // 开关 AI 整理，悬浮窗会先显示上一次的提示内容）。
            //
            // 关键是**趁窗口还看得见的时候**重绘成空：窗口一旦 hide，document 变
            // hidden，rAF 被节流，还能不能出一帧就不好说了。所以顺序必须是
            // 「emit blank → 等一小会儿让它画出来 → hide」。
            //
            // 刻意不用 render-ack 把 hide 卡住（虽然那样更精确）：ack 走双层 rAF，
            // 一旦某次没回来，窗口就永远留在屏幕上 —— 那比闪一下旧内容糟得多。
            // 固定延迟的失败模式只是"这次没来得及画完，退回原来的表现"，不会更坏。
            *self.latest_overlay_payload.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(json!({ "state": "blank" }));
            self.emit_latest(app, false);
            write_log_line(&format!(
                "[overlay-health] blank before hide prev_layout={:?} delay_ms={}",
                prev_layout, HIDE_AFTER_BLANK_MS,
            ));
            spawn_deferred_hide(app.clone(), prev_layout);
        }
    }

    pub fn update_overlay_state(&self, app: &AppHandle, data: &Value) {
        self.apply_payload_layout(data);
        *self.latest_overlay_payload.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(data.clone());

        if let Some(overlay) = app.get_webview_window("overlay") {
            let layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
            // 仅在布局真正变化时才重设原生窗口几何，避免每帧 set_position/set_size 抖动。
            let previous = self.last_applied_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
            let changed = previous.as_ref() != Some(&layout);
            if changed {
                // 录音期间唯一会改窗口几何的地方，必须留痕：这条路径以前一行日志都不写，
                // 于是「悬浮窗闪」这类几何抖动在 sayit.log 里完全无迹可寻，只能靠音量警告
                // 的时间戳反推。一次录音正常只有 1~2 行；同一对 from→to 反复出现就是抖动。
                write_log_line(&format!(
                    "[overlay-layout] {:?} -> {:?} state={} streaming={} mic_hint={}",
                    previous,
                    layout,
                    data.get("state").and_then(Value::as_str).unwrap_or("unknown"),
                    data.get("streaming").and_then(Value::as_bool).unwrap_or(false),
                    data.get("micSourceLabel")
                        .and_then(Value::as_str)
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false),
                ));
                // 卡片类布局可能是从"已隐藏"直接切过来的（比如处理中报错 → 失败卡），
                // 这时窗口还没显示，光改几何是看不见的。
                let is_card = layout.is_interactive();
                self.apply_native_layout(app, &overlay, &layout);
                set_overlay_interactivity(&overlay, layout.is_interactive());
                if is_card {
                    let _ = overlay.show();
                }
            }
            self.emit_latest(app, false);
        }
    }

    /// Overlay 页面注册完事件监听后调用。新建 WebView 时，第一次状态事件可能早于
    /// React listener，因此在 ready 时重放最近状态并重新请求确认。
    pub fn overlay_ready(&self, app: &AppHandle, device_pixel_ratio: Option<f64>) {
        let show_id = self.active_show_id.load(Ordering::SeqCst);
        self.renderer_ready_at_ms.store(now_ms(), Ordering::SeqCst);
        // 必须在下面 show_id == 0 的早退之前记：预热（show_id == 0）就是我们唯一能在
        // 第一次真正显示之前拿到 dpr 的时机。错过它，用户第一次口述就会看到被裁的胶囊。
        self.note_css_zoom(app, device_pixel_ratio);
        if show_id == 0 {
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
            return;
        }

        write_log_line(&format!(
            "[overlay-health] renderer ready show_id={} generation={} diagnostic={}",
            show_id,
            self.active_generation.load(Ordering::SeqCst),
            compact_json(&self.diagnostic_snapshot(app)),
        ));
        if self.ensure_visible(app, show_id) {
            self.emit_latest(app, true);
        }
    }

    pub fn record_render_ack(&self, app: &AppHandle, data: &Value) {
        let show_id = data.get("showId").and_then(Value::as_u64).unwrap_or(0);
        let generation = data.get("generation").and_then(Value::as_u64).unwrap_or(0);
        let healthy = data.get("healthy").and_then(Value::as_bool).unwrap_or(false);
        let active_show_id = self.active_show_id.load(Ordering::SeqCst);
        let active_generation = self.active_generation.load(Ordering::SeqCst);

        if show_id != active_show_id || generation != active_generation {
            write_log_line(&format!(
                "[overlay-health] stale ack show_id={} generation={} active_show_id={} active_generation={}",
                show_id, generation, active_show_id, active_generation,
            ));
            return;
        }

        // 先学缩放：这一轮的窗口已经按旧 css_zoom 建好了，学到新值就地重设几何，让**当前**
        // 这次显示也能被纠正，而不是只让下一次受益（用户按一次热键只看到这一次）。
        if self.note_css_zoom(app, data.get("devicePixelRatio").and_then(Value::as_f64)) {
            let layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
            if let Some(overlay) = app.get_webview_window("overlay") {
                self.apply_native_layout(app, &overlay, &layout);
            }
        }
        self.warn_if_content_clipped(data, show_id);

        if !healthy {
            write_log_line(&format!(
                "[overlay-health] unhealthy render ack show_id={} generation={} detail={}",
                show_id, generation, compact_json(data),
            ));
            return;
        }

        self.last_ack_show_id.store(show_id, Ordering::SeqCst);
        self.last_ack_generation.store(generation, Ordering::SeqCst);
        self.last_ack_at_ms.store(now_ms(), Ordering::SeqCst);
        write_log_line(&format!(
            "[overlay-health] render ack OK show_id={} generation={} latency_ms={} state={} content={}x{} visibility={}",
            show_id,
            generation,
            self.ack_latency_ms(),
            data.get("overlayState").and_then(Value::as_str).unwrap_or("unknown"),
            data.get("contentWidth").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("contentHeight").and_then(Value::as_f64).unwrap_or(0.0),
            data.get("documentVisibility").and_then(Value::as_str).unwrap_or("unknown"),
        ));
    }

    /// 内容装不进窗口时留一行日志。
    ///
    /// 为什么单独一条：render ack 的 `healthy` 只查「宽高 > 0、没被 display:none/visibility
    /// 隐藏」，被裁成一半照样是 healthy。2026-09 那次「胶囊顶部被裁」全程 17 次显示都报
    /// `render ack OK`，只能靠用户截图发现——这类问题必须在日志里能自证。
    fn warn_if_content_clipped(&self, data: &Value, show_id: u64) {
        let number = |key: &str| data.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        // 两个判据都要：clippedTop 是渲染端实测的越界量（最直接），shortfall 是拿视口高度
        // 反算的缺口（老版本前端不上报 clippedTop 时的兜底，也能反过来印证前者）。
        let clipped_top = number("clippedTop");
        let viewport_height = number("viewportHeight");
        let shortfall = if viewport_height > 0.0 {
            number("contentHeight") + OVERLAY_ROOT_PADDING_BOTTOM - viewport_height
        } else {
            0.0
        };
        // 0.5 CSS px 以下是设备像素取整的正常抖动，不算裁切。
        if clipped_top <= 0.5 && shortfall <= 0.5 {
            return;
        }
        write_log_line(&format!(
            "[overlay-scale] content clipped show_id={} state={} clippedTopPx={:.2} shortfallPx={:.2} dpr={} cssZoom={:.4} viewport={}x{} content={}x{}",
            show_id,
            data.get("overlayState").and_then(Value::as_str).unwrap_or("unknown"),
            clipped_top,
            shortfall,
            number("devicePixelRatio"),
            self.css_zoom(),
            number("viewportWidth"),
            viewport_height,
            number("contentWidth"),
            number("contentHeight"),
        ));
    }

    pub fn health_snapshot(&self, app: &AppHandle, show_id: u64) -> Value {
        let active_show_id = self.active_show_id.load(Ordering::SeqCst);
        let active_generation = self.active_generation.load(Ordering::SeqCst);
        let ack_show_id = self.last_ack_show_id.load(Ordering::SeqCst);
        let ack_generation = self.last_ack_generation.load(Ordering::SeqCst);
        let recovery_started = self.recovery_started_show_id.load(Ordering::SeqCst) == show_id;
        let diagnostic = self.diagnostic_snapshot(app);
        json!({
            "showId": show_id,
            "activeShowId": active_show_id,
            "activeGeneration": active_generation,
            "acked": ack_show_id == show_id && ack_generation == active_generation,
            "ackGeneration": ack_generation,
            "ackLatencyMs": if ack_show_id == show_id { self.ack_latency_ms() } else { -1 },
            "recoveryStarted": recovery_started,
            "recoverySucceeded": recovery_started && ack_show_id == show_id && ack_generation > 0,
            "failureClass": self.failure_class(app),
            // Keep the existing frontend response contract; `diagnostic` adds detail.
            "window": overlay_window_snapshot(app),
            "diagnostic": diagnostic,
        })
    }

    fn reset_renderer_lifecycle(&self) {
        self.page_load_started_at_ms.store(0, Ordering::SeqCst);
        self.page_load_finished_at_ms.store(0, Ordering::SeqCst);
        self.renderer_ready_at_ms.store(0, Ordering::SeqCst);
    }

    fn record_page_load(&self, event: PageLoadEvent, url: &str) {
        let timestamp = now_ms();
        let event_name = match event {
            PageLoadEvent::Started => {
                self.page_load_started_at_ms.store(timestamp, Ordering::SeqCst);
                "started"
            }
            PageLoadEvent::Finished => {
                self.page_load_finished_at_ms.store(timestamp, Ordering::SeqCst);
                "finished"
            }
        };
        write_log_line(&format!(
            "[overlay-health] page load {} show_id={} generation={} url={}",
            event_name,
            self.active_show_id.load(Ordering::SeqCst),
            self.active_generation.load(Ordering::SeqCst),
            url,
        ));
    }

    fn diagnostic_snapshot(&self, app: &AppHandle) -> Value {
        let page_started_at = self.page_load_started_at_ms.load(Ordering::SeqCst);
        let page_finished_at = self.page_load_finished_at_ms.load(Ordering::SeqCst);
        let renderer_ready_at = self.renderer_ready_at_ms.load(Ordering::SeqCst);
        let current_ms = now_ms();
        json!({
            "window": overlay_window_snapshot(app),
            "pageLoadStarted": page_started_at > 0,
            "pageLoadFinished": page_finished_at > 0,
            "rendererReady": renderer_ready_at > 0,
            "pageLoadStartedAgeMs": event_age_ms(current_ms, page_started_at),
            "pageLoadFinishedAgeMs": event_age_ms(current_ms, page_finished_at),
            "rendererReadyAgeMs": event_age_ms(current_ms, renderer_ready_at),
        })
    }

    fn failure_class(&self, app: &AppHandle) -> &'static str {
        classify_overlay_failure(
            &overlay_window_snapshot(app),
            self.page_load_started_at_ms.load(Ordering::SeqCst) > 0,
            self.page_load_finished_at_ms.load(Ordering::SeqCst) > 0,
            self.renderer_ready_at_ms.load(Ordering::SeqCst) > 0,
        )
    }

    fn ack_latency_ms(&self) -> i64 {
        let ack_at = self.last_ack_at_ms.load(Ordering::SeqCst);
        let started_at = self.show_started_at_ms.load(Ordering::SeqCst);
        if ack_at <= 0 || started_at <= 0 { -1 } else { ack_at - started_at }
    }

    fn is_acked(&self, show_id: u64, generation: u64) -> bool {
        self.last_ack_show_id.load(Ordering::SeqCst) == show_id
            && self.last_ack_generation.load(Ordering::SeqCst) == generation
    }

    /// 本次 show_id 是否仍是当前正在显示的（不区分 generation，供置顶守护线程判断是否继续）。
    fn is_showing(&self, show_id: u64) -> bool {
        show_id != 0 && self.active_show_id.load(Ordering::SeqCst) == show_id
    }

    /// 悬浮窗正显示时，把它重新顶到 topmost 带最上层。供前台窗口切换钩子调用，
    /// 让用户切到/打开别的置顶程序时，悬浮窗立即回到最上面。
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn overlay_visible(&self) -> bool {
        self.active_show_id.load(Ordering::SeqCst) != 0
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn reassert_overlay_topmost_if_visible(&self, app: &AppHandle) {
        if !self.overlay_visible() {
            return;
        }
        reassert_overlay_topmost(app);
    }

    fn is_active(&self, show_id: u64, generation: u64) -> bool {
        self.active_show_id.load(Ordering::SeqCst) == show_id
            && self.active_generation.load(Ordering::SeqCst) == generation
    }

    fn capture_overlay_monitor(&self) {
        let monitor = capture_foreground_monitor();
        if let Some(value) = &monitor {
            write_log_line(&format!(
                "[overlay-position] target_monitor source={} work=({},{},{},{})",
                value.source, value.left, value.top, value.right, value.bottom,
            ));
        }
        *self.overlay_monitor.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = monitor;
    }

    fn apply_payload_layout(&self, data: &Value) {
        if let Some(width) = data.get("baseWidth").and_then(Value::as_f64) {
            if (160.0..=600.0).contains(&width) {
                *self.overlay_base_width.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = width;
            }
        }

        let state = data.get("state").and_then(Value::as_str);
        // streaming 标志在录音开始时即为真（气泡从一开始就在，避免中途弹出+缩放）；
        // 兼容旧逻辑：有 streamingText 也算。
        let streaming_on = data.get("streaming").and_then(Value::as_bool).unwrap_or(false)
            || data
                .get("streamingText")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
        let mic_hint_on = data
            .get("micSourceLabel")
            .and_then(Value::as_str)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let candidate_layout = if state == Some("fallback") {
            OverlayLayout::Fallback
        } else if state == Some("failure") {
            OverlayLayout::Failure
        } else if state == Some("listening") && streaming_on && mic_hint_on {
            OverlayLayout::StreamingWithMicHint
        } else if state == Some("listening") && streaming_on {
            // 录音中开启了实时显示 → 放大窗口容纳气泡（整段录音保持该尺寸，中途不再缩放）
            OverlayLayout::Streaming
        } else if matches!(state, Some("listening") | Some("thinking")) && mic_hint_on {
            OverlayLayout::BaseWithMicHint
        } else {
            OverlayLayout::Base
        };

        let mut current_layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let stable_visible_phase = matches!(
            state,
            Some("listening") | Some("thinking") | Some("toast") | Some("error")
        );
        let keep_expanded_bounds = stable_visible_phase
            && matches!(
                (&*current_layout, &candidate_layout),
                (OverlayLayout::BaseWithMicHint, OverlayLayout::Base)
                    | (OverlayLayout::StreamingWithMicHint, OverlayLayout::Streaming)
                    | (OverlayLayout::StreamingWithMicHint, OverlayLayout::BaseWithMicHint)
                    | (OverlayLayout::StreamingWithMicHint, OverlayLayout::Base)
                    // Streaming 这两支是 2026-09 补的。前端曾有五个警告方法各自手写
                    // payload、都漏了 `streaming` 字段，于是低音量警告每 5 秒把布局判成
                    // Base，窗口收缩一帧再被下一次心跳撑回去——开着实时字幕不说话时
                    // 悬浮窗"一闪一闪"。前端已收口到 listeningPayload()，这里是兜底：
                    // 哪怕将来又有新出口漏带字段，窗口也不该在可见期间缩回去。
                    | (OverlayLayout::Streaming, OverlayLayout::Base)
                    | (OverlayLayout::Streaming, OverlayLayout::BaseWithMicHint)
            );

        // 提示文字 3 秒后会隐藏，无语音/错误也会把内容换成短 toast，但只要悬浮窗
        // 仍可见就不能顺带收缩原生窗口：窗口按底边锚定，收缩需要重新定位，WebView2
        // 会把两次几何更新之间的中间帧显示成下跳。保留透明上方空间，直到 hide 或
        // 下一次 waiting 明确开始新一轮显示时再恢复基础尺寸。
        if !keep_expanded_bounds {
            *current_layout = candidate_layout;
        }
    }

    fn latest_state_name(&self) -> String {
        self.latest_overlay_payload.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref()
            .and_then(|payload| payload.get("state"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string()
    }

    fn payload_for_emit(&self, probe: bool) -> Option<Value> {
        let mut payload = self.latest_overlay_payload.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()?;
        let show_id = self.active_show_id.load(Ordering::SeqCst);
        let generation = self.active_generation.load(Ordering::SeqCst);
        let object = payload.as_object_mut()?;
        object.insert("_overlayShowId".to_string(), json!(show_id));
        object.insert("_overlayGeneration".to_string(), json!(generation));
        object.insert("_overlayProbe".to_string(), json!(probe));
        Some(payload)
    }

    fn emit_latest(&self, app: &AppHandle, probe: bool) {
        let Some(overlay) = app.get_webview_window("overlay") else { return; };
        let Some(payload) = self.payload_for_emit(probe) else { return; };
        if let Err(error) = overlay.emit("overlay-state", payload) {
            write_log_line(&format!(
                "[overlay-health] emit FAILED show_id={} generation={} error={:?}",
                self.active_show_id.load(Ordering::SeqCst),
                self.active_generation.load(Ordering::SeqCst),
                error,
            ));
        }
    }

    fn ensure_visible(&self, app: &AppHandle, show_id: u64) -> bool {
        // WebviewWindowBuilder 的 label 注册与 Manager 句柄可见性不是原子操作。
        // 多个 present 并发时若都看到 handle=MISSING，会争抢同一 "overlay" label。
        let _lifecycle_guard = self.overlay_lifecycle.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let base_width = *self.overlay_base_width.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let Some(overlay) = app.get_webview_window("overlay") else {
            write_log_line(&format!(
                "[overlay-health] handle missing show_id={} — creating",
                show_id,
            ));
            self.create_overlay(app, layout, base_width, true);
            return false;
        };

        let position_error = self.apply_native_layout(app, &overlay, &layout);
        let show_error = show_overlay_window(&overlay).err();
        #[cfg(not(target_os = "macos"))]
        let top_error = overlay.set_always_on_top(true).err().map(|error| format!("{:?}", error));
        // macOS 不调 set_always_on_top：tao 会把层级异步改回 NSFloatingWindowLevel（实测层级 5），
        // 和下面 reassert 的主线程回调谁先执行没有保证；层级统一由 reassert 设成 NSStatusWindowLevel。
        #[cfg(target_os = "macos")]
        let top_error: Option<String> = None;
        // set_always_on_top(true) 在状态未变时可能是 no-op，这里再用原生 SetWindowPos 强制
        // 把窗口顶到 topmost 带最上层，确保即使下方已有别的置顶窗口也能压过它。
        reassert_overlay_topmost(app);
        set_overlay_interactivity(&overlay, layout.is_interactive());

        let snapshot = overlay_window_snapshot(app);
        if position_error.is_some() || show_error.is_some() || top_error.is_some() {
            write_log_line(&format!(
                "[overlay-health] native show FAILED show_id={} position_error={:?} show_error={:?} top_error={:?} snapshot={}",
                show_id, position_error, show_error, top_error, compact_json(&snapshot),
            ));
        } else {
            write_log_line(&format!(
                "[overlay-health] native show OK show_id={} snapshot={}",
                show_id, compact_json(&snapshot),
            ));
        }
        true
    }

    fn apply_native_layout(
        &self,
        app: &AppHandle,
        overlay: &tauri::WebviewWindow,
        layout: &OverlayLayout,
    ) -> Option<String> {
        // 记录本次应用的布局，供 update_overlay_state 判重、跳过无谓的窗口重设。
        *self.last_applied_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(layout.clone());
        let base_width = *self.overlay_base_width.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let css_zoom = self.css_zoom();
        let target_monitor = self.overlay_monitor.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();

        // macOS：各显示器缩放可以不同，物理像素不能跨屏比较，全程按逻辑坐标算。
        #[cfg(target_os = "macos")]
        {
            let bounds = macos_overlay_bounds(app, target_monitor.as_ref(), layout, base_width, css_zoom);
            let position_error = overlay.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(bounds.0, bounds.1),
            )).err();
            let size_error = overlay.set_size(tauri::Size::Logical(
                tauri::LogicalSize::new(bounds.2, bounds.3),
            )).err();
            // 不调 set_always_on_top：它会把层级改回 NSFloatingWindowLevel，层级交给 reassert_overlay_topmost
            return match (position_error, size_error) {
                (None, None) => None,
                (position, size) => Some(format!("position={:?} size={:?}", position, size)),
            };
        }

        #[cfg(not(target_os = "macos"))]
        if let Some(bounds) = target_monitor
            .as_ref()
            .and_then(|value| calc_monitor_overlay_bounds(app, value, layout, base_width, css_zoom))
        {
            let position_error = overlay.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition::new(bounds.0, bounds.1),
            )).err();
            let size_error = overlay.set_size(tauri::Size::Physical(
                tauri::PhysicalSize::new(bounds.2, bounds.3),
            )).err();
            let _ = overlay.set_always_on_top(true);

            return match (position_error, size_error) {
                (None, None) => None,
                (position, size) => Some(format!("position={:?} size={:?}", position, size)),
            };
        }

        #[cfg(not(target_os = "macos"))]
        {
            let bounds = calc_overlay_bounds(app, layout, base_width, css_zoom);
            let position_error = overlay.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(bounds.0, bounds.1),
            )).err();
            let size_error = overlay.set_size(tauri::Size::Logical(
                tauri::LogicalSize::new(bounds.2, bounds.3),
            )).err();
            let _ = overlay.set_always_on_top(true);

            match (position_error, size_error) {
                (None, None) => None,
                (position, size) => Some(format!("position={:?} size={:?}", position, size)),
            }
        }
    }

    fn recover_overlay(&self, app: &AppHandle, show_id: u64) {
        let _lifecycle_guard = self.overlay_lifecycle.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // 等锁期间可能已经 hide 或开始了下一次显示，必须重新校验。
        if !self.is_active(show_id, 0) {
            return;
        }

        self.active_generation.store(1, Ordering::SeqCst);
        self.last_ack_show_id.store(0, Ordering::SeqCst);
        self.last_ack_generation.store(0, Ordering::SeqCst);
        self.recovery_started_show_id.store(show_id, Ordering::SeqCst);
        write_log_line(&format!(
            "[overlay-health] recovery begin show_id={} failure_class={} diagnostic={}",
            show_id,
            self.failure_class(app),
            compact_json(&self.diagnostic_snapshot(app)),
        ));

        if let Some(overlay) = app.get_webview_window("overlay") {
            if let Err(error) = overlay.destroy() {
                write_log_line(&format!(
                    "[overlay-health] destroy FAILED show_id={} error={:?}",
                    show_id, error,
                ));
            }
        }

        for _ in 0..20 {
            if app.get_webview_window("overlay").is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }

        if app.get_webview_window("overlay").is_some() {
            write_log_line(&format!(
                "[overlay-health] recovery FAILED show_id={} reason=stale_handle diagnostic={}",
                show_id,
                compact_json(&self.diagnostic_snapshot(app)),
            ));
            return;
        }

        let layout = self.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let base_width = *self.overlay_base_width.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        self.create_overlay(app, layout, base_width, true);
    }

    fn create_overlay(
        &self,
        app: &AppHandle,
        layout: OverlayLayout,
        base_width: f64,
        show_immediately: bool,
    ) {
        self.reset_renderer_lifecycle();
        let bounds = calc_overlay_bounds(app, &layout, base_width, self.css_zoom());
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
        .visible(false)
        .on_page_load(|window, payload| {
            let state = window.app_handle().state::<WindowState>();
            state.record_page_load(payload.event(), payload.url().as_str());
        });

        match builder.build() {
            Ok(overlay) => {
                let position_error = self.apply_native_layout(app, &overlay, &layout);
                set_overlay_interactivity(&overlay, layout.is_interactive());
                // macOS：一建出来就设好悬浮层属性（层级、跨桌面空间、失活不隐藏）
                #[cfg(target_os = "macos")]
                reassert_overlay_topmost(app);
                let show_error = if show_immediately {
                    show_overlay_window(&overlay).err()
                } else {
                    None
                };
                write_log_line(&format!(
                    "[overlay-health] create dispatched show_id={} generation={} prewarm={} initial_bounds={:?} position_error={:?} show_error={:?} shell_visible={} diagnostic={}",
                    self.active_show_id.load(Ordering::SeqCst),
                    self.active_generation.load(Ordering::SeqCst),
                    !show_immediately,
                    bounds,
                    position_error,
                    show_error,
                    overlay.is_visible().unwrap_or(false),
                    compact_json(&self.diagnostic_snapshot(app)),
                ));
            }
            Err(error) => {
                write_log_line(&format!(
                    "[overlay-health] create FAILED show_id={} generation={} bounds={:?} error={:?}",
                    self.active_show_id.load(Ordering::SeqCst),
                    self.active_generation.load(Ordering::SeqCst),
                    bounds,
                    error,
                ));
            }
        }
    }
}
/// 把悬浮窗重新顶到 topmost 带的最上层。
///
/// 为什么需要：`WS_EX_TOPMOST` 只保证在普通窗口之上；多个 topmost 窗口之间，谁最后
/// 被显示/激活/SetWindowPos 谁就在上面。悬浮窗只在显示那一刻抢了一次置顶，之后若有
/// 别的 topmost 窗口（PotPlayer「总在最前」、会议共享工具条、PowerToys 置顶窗等）出现
/// 或被重新激活，就会盖住它。这里用原生 `SetWindowPos(HWND_TOPMOST)` 主动把自己重新顶上去。
///
/// 关键：
/// - 带 `SWP_NOACTIVATE`，绝不抢焦点（悬浮窗设计上永不激活）。
/// - 直接用原生 SetWindowPos，而不是 Tauri 的 `set_always_on_top(true)`——后者在状态未变
///   (true→true) 时可能是 no-op，不会真正下发 SetWindowPos，起不到重新抬升的作用。
#[cfg(windows)]
fn reassert_overlay_topmost(app: &AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let Some(overlay) = app.get_webview_window("overlay") else { return; };
    // 通过 isize 中转重建 HWND，规避 tauri 与本 crate 各自 windows 版本的 HWND 类型不一致。
    let hwnd_raw = match overlay.hwnd() {
        Ok(h) => h.0 as isize,
        Err(_) => return,
    };
    if hwnd_raw == 0 {
        return;
    }
    let hwnd = HWND(hwnd_raw as *mut _);
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// macOS：重设悬浮层属性（`set_always_on_top` 会把层级改回普通置顶），并在可见时
/// 不激活地放到最前。NSWindow 的方法只能在主线程调用。
#[cfg(target_os = "macos")]
fn reassert_overlay_topmost(app: &AppHandle) {
    let Some(overlay) = app.get_webview_window("overlay") else { return; };
    let window = overlay.clone();
    let _ = overlay.run_on_main_thread(move || {
        if let Ok(ns_window) = window.ns_window() {
            unsafe {
                crate::platform::macos::appkit::configure_overlay_window(ns_window);
                if crate::platform::macos::appkit::window_is_visible(ns_window) {
                    crate::platform::macos::appkit::order_front_regardless(ns_window);
                }
            }
        }
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
fn reassert_overlay_topmost(_app: &AppHandle) {}

/// 显示悬浮窗且不抢焦点。
///
/// Windows：`show()` + 后面的 SetWindowPos(SWP_NOACTIVATE)（见 reassert_overlay_topmost）。
/// macOS：`show()` 会走 makeKeyAndOrderFront 把它设成 key window，这里改用
/// `orderFrontRegardless`，不改变键盘焦点。
fn show_overlay_window(overlay: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = overlay.clone();
        overlay
            .run_on_main_thread(move || {
                if let Ok(ns_window) = window.ns_window() {
                    unsafe {
                        crate::platform::macos::appkit::configure_overlay_window(ns_window);
                        crate::platform::macos::appkit::order_front_regardless(ns_window);
                    }
                }
            })
            .map_err(|error| format!("{:?}", error))
    }
    #[cfg(not(target_os = "macos"))]
    {
        overlay.show().map_err(|error| format!("{:?}", error))
    }
}

/// 主窗网页进程崩溃后的自动重载次数记录（时间戳，毫秒）。
#[cfg_attr(not(windows), allow(dead_code))]
static MAIN_RENDERER_RELOADS: Mutex<Vec<i64>> = Mutex::new(Vec::new());
#[cfg_attr(not(windows), allow(dead_code))]
const MAIN_RENDERER_RELOAD_WINDOW_MS: i64 = 5 * 60 * 1000;
#[cfg_attr(not(windows), allow(dead_code))]
const MAIN_RENDERER_RELOAD_MAX: usize = 3;

/// 这次崩溃还能不能自动重载：5 分钟内最多 3 次，超过就停手，避免反复崩溃时无限重载。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn main_renderer_reload_allowed(now_ms: i64) -> bool {
    let mut history = MAIN_RENDERER_RELOADS.lock().unwrap_or_else(|p| p.into_inner());
    reload_allowed_in_window(&mut history, now_ms, MAIN_RENDERER_RELOAD_WINDOW_MS, MAIN_RENDERER_RELOAD_MAX)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn reload_allowed_in_window(history: &mut Vec<i64>, now_ms: i64, window_ms: i64, max: usize) -> bool {
    history.retain(|t| now_ms - *t < window_ms);
    if history.len() >= max {
        return false;
    }
    history.push(now_ms);
    true
}

/// 主窗藏到托盘时告诉 WebView2「内存可以少用」，再显示时恢复。
///
/// 主窗藏着的时间远多于开着的时间（常驻托盘 + 开机自启），而它的渲染进程是 SayIt 内存的大头。
/// 只是内存目标，不停 JS：录音、WebSocket 都跑在这个进程里，必须照常工作（所以不用 TrySuspend）。
/// 运行时太旧（没有 ICoreWebView2_19）就什么也不做。
pub fn set_main_window_memory_low(window: &tauri::WebviewWindow, low: bool) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(move |webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows_core::Interface;
            unsafe {
                let Ok(core) = webview.controller().CoreWebView2() else { return };
                let Ok(core19) = core.cast::<ICoreWebView2_19>() else { return };
                let level = if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                if let Err(e) = core19.SetMemoryUsageTargetLevel(level) {
                    log::warn!("[memory] SetMemoryUsageTargetLevel failed: {e:?}");
                } else {
                    log::info!("[memory] main window memory target {}", if low { "low" } else { "normal" });
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (window, low);
}

/// macOS：主窗口藏起来时把 Dock 图标也收起（只留菜单栏图标，像常驻工具一样），
/// 主窗口显示时再放回来。Windows 上什么都不做（任务栏按钮跟着窗口走）。
pub fn set_dock_icon_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        let _ = app.set_activation_policy(policy);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

/// 显示主窗的统一入口：恢复内存目标、show、解除最小化、抢焦点。
/// 只 show 不 unminimize 会让以最小化状态诞生的窗口停在屏幕外（pitfalls #11）。
pub fn show_main_window(window: &tauri::WebviewWindow) {
    set_dock_icon_visible(window.app_handle(), true);
    set_main_window_memory_low(window, false);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// 主窗藏到托盘的统一入口。
pub fn hide_main_window(window: &tauri::Window) {
    let _ = window.hide();
    set_dock_icon_visible(window.app_handle(), false);
    if let Some(webview_window) = window.app_handle().get_webview_window(window.label()) {
        set_main_window_memory_low(&webview_window, true);
    }
}

/// 悬浮窗显示期间，周期性地把它重新顶到最上层，兜住「显示后才出现/重申置顶的窗口」。
/// 只在本次 show_id 仍是当前显示时运行；一旦切到下一次显示或隐藏（active_show_id 变化）即退出。
fn spawn_topmost_keeper(app: AppHandle, show_id: u64) {
    let _ = thread::Builder::new()
        .name(format!("overlay-topmost-{}", show_id))
        .spawn(move || {
            let state = app.state::<WindowState>();
            // 首次快速重申一次（覆盖「悬浮窗弹出时下方已有 PotPlayer 等置顶窗」的场景）。
            reassert_overlay_topmost(&app);
            loop {
                thread::sleep(Duration::from_millis(400));
                if !state.is_showing(show_id) {
                    return;
                }
                reassert_overlay_topmost(&app);
            }
        });
}

/// 真正执行 `overlay.hide()`，延后 `HIDE_AFTER_BLANK_MS` 给 webview 一帧时间画成空白。
///
/// 中途若有新的 present 开始（`active_show_id` 不再是 0），就**放弃这次隐藏** ——
/// 那时窗口已经带着新内容显示出来了，再 hide 会把它吞掉。
fn spawn_deferred_hide(app: AppHandle, prev_layout: OverlayLayout) {
    let _ = thread::Builder::new()
        .name("overlay-deferred-hide".to_string())
        .spawn(move || {
            thread::sleep(Duration::from_millis(HIDE_AFTER_BLANK_MS));
            let state = app.state::<WindowState>();
            if state.active_show_id.load(Ordering::SeqCst) != 0 {
                write_log_line(
                    "[overlay-health] deferred hide skipped — a new present already started",
                );
                return;
            }
            let Some(overlay) = app.get_webview_window("overlay") else { return; };
            if let Err(error) = overlay.hide() {
                write_log_line(&format!(
                    "[overlay-diag] hide FAILED prev_layout={:?} hide_err={:?}",
                    prev_layout, error,
                ));
            }
        });
}

fn spawn_render_watchdog(app: AppHandle, show_id: u64) {
    let _ = thread::Builder::new()
        .name(format!("overlay-watchdog-{}", show_id))
        .spawn(move || {
            thread::sleep(Duration::from_millis(ACK_FIRST_TIMEOUT_MS));
            {
                let state = app.state::<WindowState>();
                if !state.is_active(show_id, 0) || state.is_acked(show_id, 0) {
                    return;
                }
                write_log_line(&format!(
                    "[overlay-health] ack timeout phase=1 show_id={} failure_class={} diagnostic={}",
                    show_id,
                    state.failure_class(&app),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
                state.emit_latest(&app, true);
            }

            thread::sleep(Duration::from_millis(ACK_SECOND_TIMEOUT_MS));
            {
                let state = app.state::<WindowState>();
                if !state.is_active(show_id, 0) || state.is_acked(show_id, 0) {
                    return;
                }
                write_log_line(&format!(
                    "[overlay-health] ack timeout phase=2 show_id={} failure_class={} — confirmed unhealthy diagnostic={}",
                    show_id,
                    state.failure_class(&app),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
                state.recover_overlay(&app, show_id);
            }

            thread::sleep(Duration::from_millis(RECOVERY_ACK_TIMEOUT_MS));
            let state = app.state::<WindowState>();
            if !state.is_active(show_id, 1) {
                return;
            }
            if state.is_acked(show_id, 1) {
                write_log_line(&format!(
                    "[overlay-health] recovery OK show_id={} latency_ms={} diagnostic={}",
                    show_id,
                    state.ack_latency_ms(),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
            } else {
                write_log_line(&format!(
                    "[overlay-health] recovery FAILED show_id={} reason=no_render_ack failure_class={} diagnostic={}",
                    show_id,
                    state.failure_class(&app),
                    compact_json(&state.diagnostic_snapshot(&app)),
                ));
            }
        });
}

/// 当前进程的 GDI / USER 句柄数。长时间运行后若这两个数持续增长，
/// 说明有句柄泄漏——是“悬浮窗用久后不再出现、重启即好”的典型根因。
#[cfg(windows)]
fn gui_resource_counts() -> (u32, u32) {
    // GetGuiResources 在不同 windows crate 版本里的模块路径不稳定，直接用 FFI 声明最稳。
    // GR_GDIOBJECTS=0，GR_USEROBJECTS=1；当前进程用伪句柄 (HANDLE)-1。
    #[link(name = "user32")]
    extern "system" {
        fn GetGuiResources(hprocess: *mut core::ffi::c_void, uiflags: u32) -> u32;
    }
    let cur_proc = -1isize as *mut core::ffi::c_void;
    unsafe { (GetGuiResources(cur_proc, 0), GetGuiResources(cur_proc, 1)) }
}

#[cfg(not(windows))]
fn gui_resource_counts() -> (u32, u32) {
    (0, 0)
}

fn event_age_ms(current_ms: i64, event_ms: i64) -> i64 {
    if event_ms <= 0 {
        -1
    } else {
        current_ms.saturating_sub(event_ms)
    }
}

fn classify_overlay_failure(
    window: &Value,
    page_load_started: bool,
    page_load_finished: bool,
    renderer_ready: bool,
) -> &'static str {
    if window.get("handleExists").and_then(Value::as_bool) != Some(true) {
        return "handle_missing";
    }

    // Tauri can register a WebviewWindow label before wry asynchronously creates the
    // native WebView2 controller. A label with no readable position/size is therefore a
    // shell/phantom handle, not a successfully-created overlay.
    let native_window_ready = window.get("position").is_some_and(|value| !value.is_null())
        && window.get("size").is_some_and(|value| !value.is_null());
    if !native_window_ready {
        return "native_create_failed";
    }
    if !page_load_started {
        return "page_load_not_started";
    }
    if !page_load_finished {
        return "page_load_incomplete";
    }
    if !renderer_ready {
        return "renderer_not_ready";
    }

    let visible = window.get("visible").and_then(Value::as_bool) == Some(true);
    let on_screen = window
        .get("intersectsAnyMonitor")
        .and_then(Value::as_bool)
        == Some(true);
    if !visible || !on_screen {
        return "visibility_or_position";
    }

    "render_ack_missing"
}

fn compact_json(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

fn overlay_window_snapshot(app: &AppHandle) -> Value {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return json!({ "handleExists": false });
    };

    let visible = overlay.is_visible().ok();
    let position = overlay.outer_position().ok();
    let size = overlay.outer_size().ok();
    let monitors = app.available_monitors().unwrap_or_default();
    let primary_monitor = app.primary_monitor().ok().flatten();

    let intersects_any = match (&position, &size) {
        (Some(position), Some(size)) => monitors.iter().any(|monitor| {
            let monitor_position = monitor.position();
            let monitor_size = monitor.size();
            let window_right = position.x as i64 + size.width as i64;
            let window_bottom = position.y as i64 + size.height as i64;
            let monitor_right = monitor_position.x as i64 + monitor_size.width as i64;
            let monitor_bottom = monitor_position.y as i64 + monitor_size.height as i64;
            window_right > monitor_position.x as i64
                && (position.x as i64) < monitor_right
                && window_bottom > monitor_position.y as i64
                && (position.y as i64) < monitor_bottom
        }),
        _ => false,
    };

    let mut snapshot = Map::new();
    snapshot.insert("handleExists".to_string(), json!(true));
    snapshot.insert("visible".to_string(), json!(visible));
    snapshot.insert("intersectsAnyMonitor".to_string(), json!(intersects_any));
    snapshot.insert(
        "position".to_string(),
        position.map(|value| json!({ "x": value.x, "y": value.y })).unwrap_or(Value::Null),
    );
    snapshot.insert(
        "size".to_string(),
        size.map(|value| json!({ "width": value.width, "height": value.height })).unwrap_or(Value::Null),
    );
    if let Some(monitor) = primary_monitor {
        let position = monitor.position();
        let size = monitor.size();
        snapshot.insert("primaryMonitor".to_string(), json!({
            "x": position.x,
            "y": position.y,
            "width": size.width,
            "height": size.height,
            "scaleFactor": monitor.scale_factor(),
        }));
    }
    Value::Object(snapshot)
}

fn set_overlay_interactivity(overlay: &tauri::WebviewWindow, interactive: bool) {
    let _ = overlay.set_ignore_cursor_events(!interactive);
}

#[cfg(test)]
mod reload_limit_tests {
    use super::reload_allowed_in_window;

    #[test]
    fn at_most_three_reloads_in_five_minutes() {
        let mut h = Vec::new();
        let w = 5 * 60 * 1000;
        assert!(reload_allowed_in_window(&mut h, 0, w, 3));
        assert!(reload_allowed_in_window(&mut h, 1_000, w, 3));
        assert!(reload_allowed_in_window(&mut h, 2_000, w, 3));
        assert!(!reload_allowed_in_window(&mut h, 3_000, w, 3));
        // 最早那次滑出窗口之后又能重载
        assert!(reload_allowed_in_window(&mut h, w + 1, w, 3));
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_overlay_failure, overlay_bounds_in_work_area, OverlayLayout, WindowState,
        OVERLAY_BASE_HEIGHT, OVERLAY_DEFAULT_BASE_WIDTH, OVERLAY_ROOT_PADDING_BOTTOM,
    };
    use serde_json::json;

    /// 2560x1440 @150%，任务栏占掉底部 122px —— 报「胶囊顶部被裁」那台机器的实际布局。
    const WORK: (i64, i64, i64, i64) = (0, 0, 2560, 1318);
    const SCALE: f64 = 1.5;
    /// Windows 设置 → 辅助功能 → 文本大小 123% 时实测的额外缩放（dpr 1.8427 / scale 1.5）。
    const TEXT_SCALE_123: f64 = 1.2285;
    /// 胶囊的 `min-height: 38px`（Overlay.tsx）。CSS 改了这里会先红，正是想要的效果。
    const OVERLAY_PILL_MIN_HEIGHT: f64 = 38.0;

    /// 胶囊在 webview 里需要的 CSS 高度：根节点 pb-4 + 胶囊 min-height。
    fn required_css_height() -> f64 {
        OVERLAY_ROOT_PADDING_BOTTOM + OVERLAY_PILL_MIN_HEIGHT
    }

    #[test]
    fn base_window_fits_pill_at_default_scale() {
        let (_, _, _, height) = overlay_bounds_in_work_area(
            WORK,
            SCALE,
            OverlayLayout::Base.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
            1.0,
        );
        // 窗口物理高换回 CSS px（css_zoom = 1 时 dpr 就是 scale）后要装得下内容。
        let css_height = height as f64 / SCALE;
        assert!(
            css_height >= required_css_height(),
            "base window {}px physical = {}css < required {}css",
            height,
            css_height,
            required_css_height(),
        );
    }

    /// 这条是本次故障的回归钉子：文本大小放大时窗口必须跟着长高，否则内容从顶部溢出、
    /// 被 overlay.html 的 overflow:hidden 裁平。修复前 height 恒为 84（56×1.5），
    /// webview 里只有 56 CSS px，装不下 54 + 需要的余量。
    #[test]
    fn base_window_still_fits_pill_when_os_text_scale_enlarges_css_px() {
        let (_, _, _, height) = overlay_bounds_in_work_area(
            WORK,
            SCALE,
            OverlayLayout::Base.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
            TEXT_SCALE_123,
        );
        // 此时 1 CSS px = scale × css_zoom 个设备像素。
        let css_height = height as f64 / (SCALE * TEXT_SCALE_123);
        assert!(
            css_height >= required_css_height(),
            "scaled base window {}px physical = {}css < required {}css",
            height,
            css_height,
            required_css_height(),
        );
        assert!(
            height > (OVERLAY_BASE_HEIGHT * SCALE) as u32,
            "window did not grow with css_zoom: {}",
            height,
        );
    }

    #[test]
    fn every_layout_fits_its_content_under_os_text_scale() {
        // 各布局在 webview 里需要的 CSS 高度（pb-4 + 内容），内容高取实测值。
        // 兜底卡片 149、输入源条 30 + gap 8、流式气泡 110 + gap 8 都来自现场日志/CSS。
        let cases = [
            ("base", OverlayLayout::Base, required_css_height()),
            ("mic_hint", OverlayLayout::BaseWithMicHint, required_css_height() + 8.0 + 30.0),
            ("fallback", OverlayLayout::Fallback, OVERLAY_ROOT_PADDING_BOTTOM + 149.0),
            // 失败卡：py-4(32) + 标题 20 + 原因**最多三行** 60 + 恢复提示 20
            //        + 两处间距 12 + 边框 2 ≈ 146
            //
            // ⚠️ 这里原来按「原因只有一行」算成 110，是错的：供应商的错误文案
            // （「账户余额不足，本次请求未能发出…」）在 520px 宽下就占两行，实测内容高 97，
            // 加上恢复提示 126 —— 旧窗口 150 只能装 134，余量 4px。断言写松了，
            // 于是这条自检在真实最坏情况下照样全绿。
            ("failure", OverlayLayout::Failure, OVERLAY_ROOT_PADDING_BOTTOM + 146.0),
            ("streaming", OverlayLayout::Streaming, required_css_height() + 8.0 + 110.0),
            (
                "streaming_mic_hint",
                OverlayLayout::StreamingWithMicHint,
                required_css_height() + 8.0 + 110.0 + 8.0 + 30.0,
            ),
        ];
        for (name, layout, required) in cases {
            let (_, _, _, height) = overlay_bounds_in_work_area(
                WORK,
                SCALE,
                layout.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
                TEXT_SCALE_123,
            );
            let css_height = height as f64 / (SCALE * TEXT_SCALE_123);
            assert!(
                css_height >= required,
                "{}: {}css available < {}css required",
                name,
                css_height,
                required,
            );
        }
    }

    /// 底边贴屏距离是屏幕几何，不该跟着 webview 的缩放变——否则调一下系统文本大小，
    /// 悬浮窗就整体往屏幕中间跑。
    #[test]
    fn bottom_edge_stays_put_regardless_of_css_zoom() {
        let bottom_of = |css_zoom: f64| {
            let (_, y, _, height) = overlay_bounds_in_work_area(
                WORK,
                SCALE,
                OverlayLayout::Base.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
                css_zoom,
            );
            y as i64 + height as i64
        };
        assert_eq!(bottom_of(1.0), bottom_of(TEXT_SCALE_123));
        assert_eq!(bottom_of(1.0), bottom_of(2.25));
    }

    /// 窗口再大也不能被推出工作区：夹取之后 y 仍须落在工作区内。
    #[test]
    fn extreme_css_zoom_stays_inside_work_area() {
        let (x, y, width, height) = overlay_bounds_in_work_area(
            WORK,
            SCALE,
            OverlayLayout::StreamingWithMicHint.dimensions(OVERLAY_DEFAULT_BASE_WIDTH),
            4.0,
        );
        assert!(x >= 0, "x={}", x);
        assert!(y >= 0, "y={}", y);
        assert!(x as i64 + width as i64 <= 2560, "right={}", x as i64 + width as i64);
        assert!(y as i64 + height as i64 <= 1318, "bottom={}", y as i64 + height as i64);
    }

    /// macOS：按整屏矩形找可用区域；Tauri 物理像素取整带来的半个点误差也要能对上。
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_visible_area_is_matched_by_screen_frame() {
        use crate::platform::macos::appkit::ScreenArea;
        let areas = [
            // 主屏：顶上 25 点菜单栏，底下 70 点程序坞
            ScreenArea { frame: (0.0, 0.0, 1440.0, 900.0), visible: (0.0, 25.0, 1440.0, 805.0) },
            // 右侧外接屏，比主屏高出 180 点
            ScreenArea { frame: (1440.0, -180.0, 1920.0, 1080.0), visible: (1440.0, -155.0, 1920.0, 1055.0) },
        ];
        assert_eq!(
            super::visible_area_for_frame((0.0, 0.0, 1440.0, 900.0), &areas),
            Some((0.0, 25.0, 1440.0, 805.0)),
        );
        assert_eq!(
            super::visible_area_for_frame((1440.5, -180.0, 1920.0, 1079.5), &areas),
            Some((1440.0, -155.0, 1920.0, 1055.0)),
        );
        assert_eq!(super::visible_area_for_frame((0.0, 0.0, 1280.0, 800.0), &areas), None);
    }

    /// 依次喂入 payload，返回每一步之后的布局。只驱动 apply_payload_layout，
    /// 不碰窗口，所以不需要 AppHandle。
    fn layouts_after(payloads: &[serde_json::Value]) -> Vec<OverlayLayout> {
        let state = WindowState::new();
        payloads
            .iter()
            .map(|payload| {
                state.apply_payload_layout(payload);
                state.overlay_layout.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
            })
            .collect()
    }

    /// 只有带按钮的卡片布局才接收鼠标点击，其余一律穿透。
    ///
    /// 用 match 而不是数组：新增布局变体时这里会**编译失败**，强制作者表态"这个布局
    /// 有没有按钮"。漏设的症状极难查 —— 按钮在界面上画得好好的，就是点不到，
    /// 因为整个窗口被 set_ignore_cursor_events(true) 穿透了。
    #[test]
    fn only_card_layouts_receive_mouse_clicks() {
        let expected = |layout: &OverlayLayout| match layout {
            OverlayLayout::Fallback | OverlayLayout::Failure => true,
            OverlayLayout::Base
            | OverlayLayout::BaseWithMicHint
            | OverlayLayout::Streaming
            | OverlayLayout::StreamingWithMicHint => false,
        };
        for layout in [
            OverlayLayout::Base,
            OverlayLayout::BaseWithMicHint,
            OverlayLayout::Fallback,
            OverlayLayout::Failure,
            OverlayLayout::Streaming,
            OverlayLayout::StreamingWithMicHint,
        ] {
            assert_eq!(
                layout.is_interactive(),
                expected(&layout),
                "interactivity drifted for {:?}",
                layout,
            );
        }
    }

    /// 失败卡必须拿到自己的布局，且不能被"可见期间别收缩"那条兜底挡住。
    ///
    /// 场景是真实的：录音中掉线会先显示输入源提示条（BaseWithMicHint），随后才失败。
    /// 如果 failure 落进 keep_expanded_bounds 的配对里，窗口会停在提示条的尺寸上，
    /// 卡片被 overflow:hidden 裁掉一大半。
    #[test]
    fn failure_state_gets_its_own_layout_even_after_a_mic_hint() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "micSourceLabel": "Blackwire 5220" }),
            json!({ "state": "failure", "failureTitle": "recognition failed" }),
        ]);
        assert_eq!(
            layouts,
            vec![OverlayLayout::BaseWithMicHint, OverlayLayout::Failure],
        );
    }

    #[test]
    fn streaming_flag_expands_the_window_while_listening() {
        assert_eq!(
            layouts_after(&[json!({ "state": "listening", "streaming": true })]),
            vec![OverlayLayout::Streaming],
        );
    }

    /// 回归钉（2026-09「开着实时字幕不说话时悬浮窗一闪一闪」）：
    ///
    /// 低音量警告每 5 秒发一次 listening 更新，那几个 payload 曾漏带 `streaming`。
    /// 布局一旦被判回 Base，窗口就从 480×200 收缩、下一帧心跳再撑回去 —— 而 webview 里
    /// 的 DOM 完全没动，气泡被 overflow:hidden 裁掉一帧，看起来就是闪。
    ///
    /// 前端已收口到 listeningPayload()，这条钉的是原生侧的兜底：可见期间**任何**缺字段的
    /// listening 更新都不许让窗口缩回去。
    #[test]
    fn listening_update_without_streaming_flag_must_not_shrink_the_window() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "streaming": true }),
            // 这就是当年那份 payload：只有警告文案，没有 streaming
            json!({ "state": "listening", "warning": "volume is low", "warningTone": "warn" }),
            json!({ "state": "listening", "streaming": true }),
        ]);
        assert_eq!(
            layouts,
            vec![
                OverlayLayout::Streaming,
                OverlayLayout::Streaming,
                OverlayLayout::Streaming,
            ],
        );
    }

    /// 同一条兜底也要覆盖「输入源提示还在显示」的那一支，否则提示条一出现就又漏一个组合。
    #[test]
    fn streaming_window_survives_a_mic_hint_only_update() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "streaming": true }),
            json!({ "state": "listening", "micSourceLabel": "Blackwire 5220" }),
        ]);
        assert_eq!(
            layouts,
            vec![OverlayLayout::Streaming, OverlayLayout::Streaming],
        );
    }

    /// 兜底不能兜过头：新一轮显示从 waiting 开始，那时必须真的回到基础尺寸，
    /// 否则上一轮的大窗口会一直留着。
    #[test]
    fn a_new_waiting_phase_resets_to_the_base_layout() {
        let layouts = layouts_after(&[
            json!({ "state": "listening", "streaming": true }),
            json!({ "state": "waiting", "elapsedSec": 0 }),
        ]);
        assert_eq!(layouts, vec![OverlayLayout::Streaming, OverlayLayout::Base]);
    }

    fn native_window() -> serde_json::Value {
        json!({
            "handleExists": true,
            "visible": true,
            "intersectsAnyMonitor": true,
            "position": { "x": 10, "y": 20 },
            "size": { "width": 200, "height": 56 }
        })
    }

    #[test]
    fn classifies_phantom_tauri_handle_as_native_create_failure() {
        let window = json!({
            "handleExists": true,
            "visible": null,
            "intersectsAnyMonitor": false,
            "position": null,
            "size": null
        });
        assert_eq!(
            classify_overlay_failure(&window, false, false, false),
            "native_create_failed"
        );
    }

    #[test]
    fn classifies_page_and_renderer_stages() {
        let window = native_window();
        assert_eq!(
            classify_overlay_failure(&window, false, false, false),
            "page_load_not_started"
        );
        assert_eq!(
            classify_overlay_failure(&window, true, false, false),
            "page_load_incomplete"
        );
        assert_eq!(
            classify_overlay_failure(&window, true, true, false),
            "renderer_not_ready"
        );
        assert_eq!(
            classify_overlay_failure(&window, true, true, true),
            "render_ack_missing"
        );
    }

    #[test]
    fn classifies_visible_but_offscreen_window() {
        let mut window = native_window();
        window["intersectsAnyMonitor"] = json!(false);
        assert_eq!(
            classify_overlay_failure(&window, true, true, true),
            "visibility_or_position"
        );
    }
}

fn monitor_info(app: &AppHandle) -> (f64, f64, f64) {
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        (size.width as f64 / scale, size.height as f64 / scale, scale)
    } else {
        (1920.0, 1080.0, 1.0)
    }
}

fn calc_overlay_bounds(
    app: &AppHandle,
    layout: &OverlayLayout,
    base_width: f64,
    css_zoom: f64,
) -> (f64, f64, f64, f64) {
    let (design_width, design_height) = layout.dimensions(base_width);
    // 设计尺寸是 CSS px；乘 css_zoom 之后才是能交给 Tauri 的逻辑尺寸。
    let desired_width = design_width * css_zoom;
    let desired_height = design_height * css_zoom;
    let (screen_width, screen_height, _) = monitor_info(app);
    let width = desired_width.min(screen_width - 40.0).max(160.0);
    let height = desired_height
        .min(screen_height - 40.0)
        .max(OVERLAY_BASE_HEIGHT * css_zoom);
    let x = ((screen_width - width) / 2.0).round();
    let y = (screen_height - height - 72.0).max(8.0);
    (x, y, width, height)
}

/// 显示器内定位的纯数学部分，全程物理像素，便于单测钉住缩放行为。
///
/// - `work`：目标显示器工作区 `(left, top, right, bottom)`，物理像素
/// - `scale`：该显示器的缩放
/// - `design`：布局的设计尺寸，CSS px
/// - `css_zoom`：webview 里 1 CSS px 相当于几个逻辑 px
fn overlay_bounds_in_work_area(
    work: (i64, i64, i64, i64),
    scale: f64,
    design: (f64, f64),
    css_zoom: f64,
) -> (i32, i32, u32, u32) {
    let (left, top, right, bottom) = work;
    let work_width = (right - left).max(1);
    let work_height = (bottom - top).max(1);
    // margin 与 bottom_gap 描述「窗口离屏幕边多远」，是屏幕几何，**不跟 css_zoom 走**：
    // webview 内部怎么排版不该改变悬浮窗贴屏底的距离。
    let margin = (OVERLAY_SCREEN_MARGIN * scale).round().max(1.0) as i64;
    let bottom_gap = (72.0 * scale).round().max(margin as f64) as i64;
    let available_width = (work_width - margin * 2).max(1);
    let available_height = (work_height - margin * 2).max(1);
    // 用 ceil 而不是 round：宁可多出一个物理像素的透明边，也不要向下取整把本就不多的
    // 垂直余量吃掉——少一个像素就是胶囊顶部被裁一条。
    let width = ((design.0 * css_zoom * scale).ceil().max(1.0) as i64).min(available_width);
    let height = ((design.1 * css_zoom * scale).ceil().max(1.0) as i64).min(available_height);
    let x = left + ((work_width - width) / 2);
    let min_y = top + margin;
    // height 已被 available_height 夹住，所以 max_y >= min_y 恒成立，clamp 不会 panic。
    let max_y = bottom - margin - height;
    let y = (bottom - bottom_gap - height).clamp(min_y, max_y);
    (x as i32, y as i32, width as u32, height as u32)
}

/// macOS：在前台窗口所在显示器（取不到就用主显示器）的工作区底部居中放置，全程逻辑坐标。
///
/// `target` 是 context::capture_foreground_monitor 给的前台窗口矩形（逻辑点）。
/// Tauri 的显示器位置/尺寸是「逻辑点 × 该屏缩放」，各自除以自己的缩放就回到统一的逻辑坐标系。
#[cfg(target_os = "macos")]
fn macos_overlay_bounds(
    app: &AppHandle,
    target: Option<&MonitorBounds>,
    layout: &OverlayLayout,
    base_width: f64,
    css_zoom: f64,
) -> (f64, f64, f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    let logical_rect = |monitor: &tauri::Monitor| {
        let scale = monitor.scale_factor().max(0.1);
        let position = monitor.position();
        let size = monitor.size();
        (
            position.x as f64 / scale,
            position.y as f64 / scale,
            size.width as f64 / scale,
            size.height as f64 / scale,
        )
    };
    let by_target = target.and_then(|t| {
        let cx = (t.left as f64 + t.right as f64) / 2.0;
        let cy = (t.top as f64 + t.bottom as f64) / 2.0;
        monitors.iter().find(|monitor| {
            let (x, y, w, h) = logical_rect(monitor);
            cx >= x && cx < x + w && cy >= y && cy < y + h
        })
    });
    let primary = app.primary_monitor().ok().flatten();
    let Some(monitor) = by_target.or(primary.as_ref()) else {
        return calc_overlay_bounds(app, layout, base_width, css_zoom);
    };
    let scale = monitor.scale_factor().max(0.1);
    let work = macos_work_area(monitor);
    let left = work.position.x as f64 / scale;
    let top = work.position.y as f64 / scale;
    let right = left + work.size.width as f64 / scale;
    let bottom = top + work.size.height as f64 / scale;
    let (x, y, width, height) = overlay_bounds_in_work_area(
        (left.round() as i64, top.round() as i64, right.round() as i64, bottom.round() as i64),
        1.0,
        layout.dimensions(base_width),
        css_zoom,
    );
    (x as f64, y as f64, width as f64, height as f64)
}

/// macOS：显示器工作区（去掉菜单栏和程序坞），单位与 Tauri 相同（逻辑点 × 该屏缩放）。
///
/// 不直接用 `Monitor::work_area()`：Tauri 在 macOS 上只按程序坞修正了 x，y 仍取整屏顶边，
/// 高度却已扣掉菜单栏和程序坞，整块工作区因此上移了一个菜单栏的高度。这里按
/// NSScreen.visibleFrame 重算；对不上 NSScreen 时退回 Tauri 的值。
#[cfg(target_os = "macos")]
pub(crate) fn macos_work_area(monitor: &tauri::Monitor) -> tauri::PhysicalRect<i32, u32> {
    let scale = monitor.scale_factor().max(0.1);
    let position = monitor.position();
    let size = monitor.size();
    let frame = (
        position.x as f64 / scale,
        position.y as f64 / scale,
        size.width as f64 / scale,
        size.height as f64 / scale,
    );
    let areas = crate::platform::macos::appkit::screen_areas();
    match visible_area_for_frame(frame, &areas) {
        Some((x, y, width, height)) => tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new((x * scale).round() as i32, (y * scale).round() as i32),
            size: tauri::PhysicalSize::new(
                (width * scale).round().max(1.0) as u32,
                (height * scale).round().max(1.0) as u32,
            ),
        },
        None => *monitor.work_area(),
    }
}

/// 按整屏矩形找到对应显示器的可用区域。容差 2 个逻辑点，吸收 Tauri 物理像素取整带来的误差。
#[cfg(target_os = "macos")]
fn visible_area_for_frame(
    frame: (f64, f64, f64, f64),
    areas: &[crate::platform::macos::appkit::ScreenArea],
) -> Option<(f64, f64, f64, f64)> {
    const TOLERANCE: f64 = 2.0;
    let close = |a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)| {
        (a.0 - b.0).abs() <= TOLERANCE
            && (a.1 - b.1).abs() <= TOLERANCE
            && (a.2 - b.2).abs() <= TOLERANCE
            && (a.3 - b.3).abs() <= TOLERANCE
    };
    areas.iter().find(|area| close(area.frame, frame)).map(|area| area.visible)
}

/// 在录音开始时的前台窗口所在显示器底部居中放置。
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn calc_monitor_overlay_bounds(
    app: &AppHandle,
    target: &MonitorBounds,
    layout: &OverlayLayout,
    base_width: f64,
    css_zoom: f64,
) -> Option<(i32, i32, u32, u32)> {
    let center_x = target.left as i64 + (target.right as i64 - target.left as i64) / 2;
    let center_y = target.top as i64 + (target.bottom as i64 - target.top as i64) / 2;
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        center_x >= position.x as i64
            && center_x < position.x as i64 + size.width as i64
            && center_y >= position.y as i64
            && center_y < position.y as i64 + size.height as i64
    })?;

    let scale = monitor.scale_factor();
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }

    Some(overlay_bounds_in_work_area(
        (
            target.left as i64,
            target.top as i64,
            target.right as i64,
            target.bottom as i64,
        ),
        scale,
        layout.dimensions(base_width),
        css_zoom,
    ))
}
