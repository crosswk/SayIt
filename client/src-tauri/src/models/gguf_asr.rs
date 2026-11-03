// 本地 ASR 推理（GGUF / ggml）— 走 transcribe.cpp 的 Rust 绑定 transcribe-cpp。
//
// 与旧的 sherpa-onnx 路径（local_asr.rs）相比：
//   - 模型是 GGUF 块量化（Q8_0 等），kernel 直接吃量化权重，不像 ORT 的 INT8
//     动态量化每步都要 quantize/dequantize —— 自回归模型（Qwen3-ASR）差一个量级。
//   - 计算后端是运行时注册的：有 GPU 模块就能用 GPU，没有就自动 CPU。
//   - families 自报 max_audio_ms（Qwen3 约 87 分钟），但「吃得下」不等于「该一次喂」：
//     整段长录音一次推理会让集成显卡单个任务超过 Windows 看门狗的 2 秒而被重置。
//     所以 local_asr 先按停顿切成 ≤30 s 的块再调这里（见 MAX_CHUNK_SEC）；
//     这里的超限分段只是兜底。
//
// 线程模型：Session 是 Send 但不是 Sync，run 要 &mut self；同一个 Model 同时
// 只允许一个 run 在飞（库内部用 per-model 锁保证）。所以这里用一个全局
// Mutex<Option<Loaded>> 常驻，推理时拿 &mut。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use transcribe_cpp::{
    Backend, DeviceType, Feature, Itn, Model, ModelOptions, Pnc, RunOptions, Session,
    SessionOptions,
};
#[cfg(test)]
use transcribe_cpp::TimestampKind;

// 生产路径一律走 checked_model_dir（先校验 id 再拼路径），未校验的版本只留给测试。
#[cfg(test)]
use super::downloader::model_dir;

/// 已加载的引擎。Session 内部持有 Model 的 Arc，所以重复推理不会重新加载权重。
///
/// 缓存 key 是 (model_id, accelerator, gpu_device)：这三个变了才需要真的重建模型。
/// language 不在 key 里 —— 它只是 RunOptions 的运行时参数，每次转写传入即可，
/// 切换识别语言不应该付一次"重载 + 预热"（1.7B 约 9 s）的钱。
pub(crate) struct Loaded {
    model_id: String,
    accelerator: String,
    /// 用户选的显卡标识（`GgufDevice::id`，空 = 自动）。
    ///
    /// key 里存的是**设置值**而不是解析出来的 registry 索引：索引会随驱动更新
    /// 变（上游明确说明），拿它当 key 会让同一份设置在枚举抖动时反复重载模型。
    gpu_device: String,
    /// 实际绑定的后端字符串（"cpu" / "vulkan" / …），用于诊断页显示。
    backend: String,
    /// 实际绑定的设备描述（如 "NVIDIA GeForce RTX 4060"）。
    ///
    /// 必须如实回报，不能拿"用户选了哪张"顶替：`gpu_device` 索引 0 是上游的
    /// 自动哨兵，选中 registry 索引 0 那张卡时我们传的是 0，最终由库的探测顺序
    /// 决定用哪张（独显优先）。绝大多数情况两者一致，但集显排在索引 0、机器
    /// 又有独显时就会不一致 —— 那时界面必须显示真实结果，否则用户永远查不出
    /// "我设了却没生效"。
    device: Option<String>,
    /// 本 session 能接受的最长音频（毫秒）。0 = 无实际上限。
    max_audio_ms: i64,
    /// 这个模型族是否支持 ITN / PNC 的运行时开关。加载时探一次，之后按结果决定
    /// 要不要在 RunOptions 里请求 —— 对不支持的族请求会让库每次都打一条 WARN。
    supports_itn: bool,
    supports_pnc: bool,
    /// 模型自报的语种码。加载时抄一份，因为**各族的码粒度不一样**，界面上的
    /// `localAsr.language`（只有 auto/zh/en/ja/ko）不能直接透传，得按这份清单
    /// 解析成模型真正认识的那个串。详见 `resolve_language`。
    languages: Vec<String>,
    session: Session,
}

static CACHE: Mutex<Option<Loaded>> = Mutex::new(None);

/// 引擎状态的轻量镜像：只放"诊断 / 状态查询要读的那几个字段"，与 CACHE 分成两把锁。
///
/// 为什么必须分开：`ensure_loaded` 在**整个"卸旧 + 加载 + 预热"期间**都持着 CACHE
/// 锁（1.7B 约 9 s，冷盘 / 弱 GPU / 首次编译 Vulkan pipeline 会更久）。
/// 而 `gguf_asr_diagnostics` 曾经是同步 `#[tauri::command]` —— Tauri 把同步命令放在
/// 主线程执行，主线程又是 UI 事件循环，于是"进设置页选个模型"会让整个窗口假死到
/// 加载结束，用户只能强杀进程（0.1.4 的用户反馈就是这个）。
///
/// 所以规矩是：**任何"只是想知道当前状态"的读取都走这把小锁，绝不排在 CACHE 后面。**
/// 这把锁只在赋值/克隆的瞬间持有，不会跨任何耗时操作。
static STATUS: Mutex<EngineStatus> = Mutex::new(EngineStatus {
    loading_model: None,
    backend: None,
    device: None,
});

struct EngineStatus {
    /// 正在加载中的模型 id；None = 当前没有加载在进行。
    loading_model: Option<String>,
    /// 已加载引擎实际绑定的后端字符串（"cpu" / "vulkan" / …）；None = 未加载。
    backend: Option<String>,
    /// 实际绑定的设备描述；None = 未加载或库没报。见 `Loaded::device`。
    device: Option<String>,
}

fn mark_loading(model_id: &str) {
    if let Ok(mut status) = STATUS.lock() {
        status.loading_model = Some(model_id.to_string());
        // 旧引擎马上就要被丢弃，先把 backend 清空：否则重载期间诊断页会报一个
        // 已经不存在的后端。
        status.backend = None;
        status.device = None;
    }
}

fn mark_loaded(backend: &str, device: Option<&str>) {
    if let Ok(mut status) = STATUS.lock() {
        status.backend = Some(backend.to_string());
        status.device = device.map(|d| d.to_string());
    }
}

fn mark_unloaded() {
    if let Ok(mut status) = STATUS.lock() {
        status.backend = None;
        status.device = None;
    }
}

/// 离开 `ensure_loaded` 时一定清掉"加载中"标记。中途任何一个 `?` 提前返回
/// （没下载 / 加载失败 / 建 session 失败）都不能让界面永远停在"正在加载"。
struct LoadingGuard;

impl Drop for LoadingGuard {
    fn drop(&mut self) {
        if let Ok(mut status) = STATUS.lock() {
            status.loading_model = None;
        }
    }
}

/// 后端只需注册一次。dynamic-backends 构建下，不先注册就加载模型会直接报
/// TRANSCRIBE_ERR_BACKEND，所以这一步是硬前置。
static INIT: std::sync::Once = std::sync::Once::new();

/// 注册计算后端 + 把 ggml/native 的日志接到 log facade。
///
/// **懒调用，绝不放回启动路径。** 这一步会 dlopen exe 旁边所有 ggml 模块，其中
/// `ggml-vulkan.dll`（70 MB）一被载入就立刻 `vk::createInstance()` 建出真实的 Vulkan
/// 上下文：实测白占约 36 MB 共享显存、让进程带着 `engtype_compute` 出现在任务管理器的
/// GPU 进程列表里，本身还要 80~520 ms。云 API / 服务器模式一个模型都不加载，付这笔钱
/// 收益为零（0.1.8 前的实际情况，用户反馈"即便使用云 API 模式也持续占用 GPU"）。
/// 而且上游标注 idempotent 但 NOT retryable，进程内没有反注册路径 —— 注册了就撤不回来。
///
/// 生产调用点只有两个，都在真正需要本地引擎的那一刻：
/// - `ensure_loaded()` —— 所有模型加载的必经之路（`preload` / `transcribe` 都走它）
/// - `describe_devices()` —— 本地模式的设置页与用户主动打开的诊断页
///
/// 目前只扫 exe 旁边的模块目录（build.rs 会把 transcribe.dll + ggml-*.dll 放那儿）。
/// 注意 `init_backends(dir)` 只扫**一个**目录，不是"追加一个目录"：所以将来做
/// GPU 加速包时，不能只把 ggml-vulkan.dll 单独放到另一个目录再指过去（那样 CPU
/// 模块就不在扫描范围内了）。届时的做法是：首次运行把 exe 旁的 CPU 模块拷到
/// 用户可写目录，加速包也下到同一个目录，然后统一 init_backends(那个目录)。
pub fn init_backends() {
    INIT.call_once(|| {
        transcribe_cpp::init_logging();
        match transcribe_cpp::init_backends_default() {
            Ok(()) => log::info!("transcribe backends registered"),
            Err(e) => log::error!("transcribe backends init failed: {}", e),
        }

        let devices = transcribe_cpp::devices();
        log::info!(
            "transcribe compute devices ({}): [{}]",
            devices.len(),
            devices
                .iter()
                .map(|d| format!("{}:{}", d.kind, d.name))
                .collect::<Vec<_>>()
                .join(", ")
        );
    });
}

/// 该模型的权重是否已经下载好（目录里能找到 .gguf）。
/// 只给测试用：生产路径上"没下载"是由 `ensure_loaded` 报错表达的，不需要预检。
#[cfg(test)]
pub fn model_is_downloaded(model_id: &str) -> bool {
    find_gguf(&model_dir(model_id)).is_ok()
}

/// 一个已注册的计算设备，给前端（诊断页 / 设置页）展示用。
#[derive(Debug, Clone, serde::Serialize)]
pub struct GgufDevice {
    /// "cpu" / "vulkan" / …
    pub kind: String,
    pub name: String,
    /// 设备可用内存（MB）。CPU 报的是系统内存，GPU 报的是显存。
    pub memory_mb: u64,
    /// 设置里用来记住"选了哪张卡"的稳定标识。
    ///
    /// 优先用后端报的 `device_id`（PCI 设备对应的总线 id），拿不到就回落到
    /// `kind:name`。**绝不能存 registry 索引** —— 上游明确说索引会随驱动更新
    /// 或换机器变动，存索引等于让用户的选择在某次驱动更新后静默指向另一张卡。
    pub id: String,
    /// ggml registry 索引，也就是 `ModelOptions::gpu_device` 的取值空间。
    /// 带给前端只为排序与调试展示，不作为持久化标识。
    pub index: usize,
    /// 是不是 GPU/IGPU（只有这两类能被显式指定）。CPU 与 BLAS 之类的 ACCEL 设备
    /// 传给 `gpu_device` 会被上游判成 INVALID_ARG，整次加载失败。
    pub is_gpu: bool,
}

/// 把设置里存的显卡标识解析成 `ModelOptions::gpu_device`。
///
/// 返回值是 ggml registry 索引，0 = 交给库自动挑（独显优先，各档内按注册顺序）。
///
/// 三条硬规则，违反任意一条上游都会直接 `TRANSCRIBE_ERR_INVALID_ARG`、
/// 让整次模型加载失败（不是回落，是报错）：
/// 1. 请求 CPU 后端时必须是 0 —— 没有 GPU 可选。
/// 2. 只能指向 GPU/IGPU 设备。
/// 3. 必须在 `[0, device_count)` 范围内。
///
/// 还有一条不是错误但会让结果与用户预期不符：**索引 0 是"自动"哨兵，没办法
/// 显式选中 registry 索引 0 那张卡**。实际影响很小，因为自动探测本来就是独显
/// 优先、同档按注册顺序，所以"第一张独显"就是自动的结果；真正落空的只有
/// "索引 0 是集显、机器还有独显、用户偏要用集显"这一种组合。那种情况下只能
/// 靠 `GGML_VK_VISIBLE_DEVICES` 在进程启动前限制可见设备。
///
/// 所以加载完成后一律用 `Model::device()` 把**实际**绑定的设备回报给界面，
/// 不拿用户的选择顶替 —— 见 `Loaded::device`。
fn resolve_gpu_device(selected: &str, accelerator: &str) -> i32 {
    if selected.is_empty() || selected == "auto" {
        return 0;
    }
    pick_gpu_device_index(&describe_devices(), selected, accelerator)
}

/// `resolve_gpu_device` 的决策部分，抽出来是为了能不碰真实硬件地测。
/// 所有的回落分支都在这里，枚举设备那一步留在调用方。
fn pick_gpu_device_index(devices: &[GgufDevice], selected: &str, accelerator: &str) -> i32 {
    if selected.is_empty() || selected == "auto" {
        return 0;
    }
    if accelerator == "cpu" {
        log::warn!(
            "A specific GPU ({}) is selected but the compute backend is set to CPU; ignoring the GPU selection",
            selected
        );
        return 0;
    }
    let Some(dev) = devices.iter().find(|d| d.id == selected) else {
        // 换了显卡、拔了外置 GPU、驱动没起来都会走到这里。回落到自动而不是报错：
        // 用户的本意是"用本地识别"，不是"用这张卡，否则别识别"。
        log::warn!(
            "The selected GPU ({}) is not among the registered compute devices; falling back to automatic selection",
            selected
        );
        return 0;
    };
    if !dev.is_gpu {
        log::warn!(
            "The selected compute device ({}) is not a GPU; falling back to automatic selection",
            dev.name
        );
        return 0;
    }
    if dev.index == 0 {
        // 不是失败：0 就是自动，而自动的探测顺序本来就会先挑这一档里的独显。
        log::info!(
            "The selected GPU ({}) sits at registry index 0, which is the automatic sentinel; the library will pick it by probe order",
            dev.name
        );
        return 0;
    }
    log::info!("Requesting GPU device {} ({})", dev.index, dev.name);
    dev.index as i32
}

/// 诊断信息：已注册的计算设备 + 当前绑定的后端。
/// 用来确认到底跑在 cpu 还是 vulkan 上，避免"以为开了 GPU 其实回落了"。
#[derive(Debug, Clone, serde::Serialize)]
pub struct GgufDiagnostics {
    pub devices: Vec<GgufDevice>,
    pub current_backend: Option<String>,
    /// 实际绑定的设备描述。多显卡机器上"选了哪张"和"真的用了哪张"可能不同
    /// （见 `resolve_gpu_device`），界面显示的必须是这个。
    pub current_device: Option<String>,
    /// 正在加载中的模型 id。非 None 时 `current_backend` 一定是 None ——
    /// 界面这时该说"正在加载"，而不是"模型未加载"。
    pub loading_model: Option<String>,
    pub native_version: String,
    /// 当前进程的工作集（MB）。核显机器上模型权重也算在这里面，所以这个数
    /// 就是用户在任务管理器看到的那个数。
    pub process_memory_mb: u64,
}

/// **必须是 async。** Tauri 把同步命令放在主线程执行，而主线程就是 UI 事件循环；
/// 这里要做 native FFI（`devices()` 枚举计算设备、`version()`），在主线程上跑一旦
/// 慢下来窗口就"无响应"。改成 async + spawn_blocking 后，即使底层卡住也只卡这一个
/// 后台任务。状态字段读的是 STATUS 小锁，不会等模型加载。
#[tauri::command]
pub async fn gguf_asr_diagnostics() -> Result<GgufDiagnostics, String> {
    tokio::task::spawn_blocking(|| GgufDiagnostics {
        devices: describe_devices(),
        current_backend: current_backend(),
        current_device: current_device(),
        loading_model: loading_model(),
        native_version: transcribe_cpp::version(),
        process_memory_mb: process_memory_mb(),
    })
    .await
    .map_err(|e| format!("Failed to read local engine state: {}", e))
}

/// 当前进程的工作集，MB。用来回答"这个模型到底吃多少内存"——权重体积不等于
/// 内存占用（还有 KV cache、计算缓冲、mel 缓冲），实测比估算靠谱。
pub fn process_memory_mb() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..Default::default()
        };
        let ok = unsafe {
            GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        };
        if ok.is_ok() {
            return (counters.WorkingSetSize / (1024 * 1024)) as u64;
        }
        0
    }
    // macOS：phys_footprint（与「活动监视器」的「内存」列一致）
    #[cfg(target_os = "macos")]
    {
        crate::platform::macos::sysinfo::process_memory_mb()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        0
    }
}

/// 列出已注册的计算设备，给诊断页 / 设置页用。
///
/// 自己负责注册后端（启动路径上已经不做了），否则拿到的永远是空列表。
///
/// 这不会让云 / 服务器模式的用户白付 Vulkan 初始化：本函数只有两个调用点，
/// `LocalModeSection` 的 GPU 摘要（`VoiceEnginePage` 里由 `workMode === 'local'`
/// 门住，只在本地模式渲染）和用户主动打开的诊断页。两者都意味着用户正在查看
/// 本地引擎的硬件信息，这时枚举设备就是他要的结果。
pub fn describe_devices() -> Vec<GgufDevice> {
    init_backends();
    transcribe_cpp::devices()
        .into_iter()
        .enumerate()
        .map(|(i, d)| {
            let name = if d.description.is_empty() {
                d.name.clone()
            } else {
                d.description.clone()
            };
            GgufDevice {
                kind: d.kind.to_string(),
                // index 由库给（枚举时填的就是 registry 索引）；它是 Option，只有
                // `Model::device()` 取回的设备才会是 None，而这里一定是枚举来的。
                // 回落到 enumerate 的序号只是防御，两者本来就相等。
                index: d.index.unwrap_or(i),
                is_gpu: matches!(d.device_type, DeviceType::Gpu | DeviceType::Igpu),
                id: d
                    .device_id
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", d.kind, name)),
                name,
                memory_mb: d.memory_total / (1024 * 1024),
            }
        })
        .collect()
}

/// 在模型目录里找唯一的 .gguf 文件。catalog 里每个 GGUF 模型只下一个权重文件，
/// 所以不需要用户/前端记住文件名，避免换量化档时两头都要改。
fn find_gguf(dir: &Path) -> Result<PathBuf, String> {
    if !dir.exists() {
        return Err("The model has not been downloaded".into());
    }
    let mut hits: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read model directory: {}", e))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.eq_ignore_ascii_case("gguf"))
        })
        .collect();
    match hits.len() {
        0 => Err("The model directory contains no .gguf file".into()),
        1 => Ok(hits.remove(0)),
        _ => {
            // 多个量化档共存时取最大的（通常是精度最高的那个），并留日志。
            hits.sort_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0));
            let pick = hits.pop().unwrap();
            log::warn!(
                "The model directory contains multiple .gguf files; selected the largest: {}",
                pick.file_name().unwrap_or_default().to_string_lossy()
            );
            Ok(pick)
        }
    }
}

/// 选择后端。Auto = 库自己挑最好的已注册设备，挑不到 GPU 就用 CPU。
fn resolve_backend(pref: &str) -> Backend {
    match pref {
        "cpu" => Backend::Cpu,
        "gpu" => {
            // 只有真的注册了 GPU 设备才请求它，否则退回 Auto，避免加载直接失败。
            // macOS 上是 Metal（Windows 构建没有编入 Metal，backend_available 恒为 false）
            for b in [Backend::Cuda, Backend::Vulkan, Backend::Metal] {
                if transcribe_cpp::backend_available(b) {
                    return b;
                }
            }
            log::warn!("GPU was requested but no GPU backend is available; falling back to Auto");
            Backend::Auto
        }
        _ => Backend::Auto,
    }
}

/// 加载模型（若 key 未变则复用）。`accelerator` 取 "auto" | "cpu" | "gpu"，
/// `gpu_device` 是 `GgufDevice::id`（空 = 自动挑）。
/// 换加速器或换显卡都要重建：设备是 Model::load_with 时绑定的，之后改不了。
fn ensure_loaded(model_id: &str, accelerator: &str, gpu_device: &str) -> Result<(), String> {
    // 后端注册的**唯一生产入口之一**（另一个是 describe_devices）。启动路径上不再注册，
    // 所以这里必须自己保证前置条件：dynamic-backends 构建下不先注册就 Model::load_with
    // 会直接报 TRANSCRIBE_ERR_BACKEND，而下面 resolve_backend 里的 backend_available()
    // 也要靠它才能看到 GPU。
    //
    // 放在 CACHE.lock() **之前**：首次注册要 80~520 ms，而 CACHE 锁会被整个
    // "卸旧 + 加载 + 预热"过程持有（见 STATUS 的说明），不该再往里塞耗时操作。
    // init_backends 内部是 Once，重复调用无代价，并发调用由 Once 自己串行。
    init_backends();

    let mut cache = CACHE.lock().map_err(|e| format!("Failed to acquire model cache lock: {}", e))?;

    if let Some(ref c) = *cache {
        if c.model_id == model_id && c.accelerator == accelerator && c.gpu_device == gpu_device {
            // 与空闲卸载共用同一把锁更新时间，保证守护线程拿到锁后不会
            // 把刚被复用、即将开始推理的模型当成过期模型卸载。
            touch_activity();
            return Ok(());
        }
    }

    // 从这里开始就算"加载中"了：卸旧引擎本身也要时间，而这段时间里状态查询
    // 应该说"正在加载"，不是"未加载"。
    mark_loading(model_id);
    let _loading_guard = LoadingGuard;

    // 先释放旧引擎再建新的，避免同时驻留两份权重（GGUF 动辄几百 MB ~ 数 GB）。
    *cache = None;

    // model_id 来自前端（设置里的 localAsr.modelId），先校验再拼路径。
    let path = find_gguf(&crate::models::downloader::checked_model_dir(model_id)?)?;
    log::info!("Loading GGUF ASR model: {} ({})", model_id, path.display());
    let start = Instant::now();

    let options = ModelOptions {
        backend: resolve_backend(accelerator),
        // 0 = 自动/首个匹配；非 0 = 指定的 ggml registry 索引。见 resolve_gpu_device。
        gpu_device: resolve_gpu_device(gpu_device, accelerator),
    };
    let model = Model::load_with(&path, &options)
        .map_err(|e| format!("Failed to load model ({}): {}", model_id, e))?;

    let backend = model.backend();
    // 实际绑定到哪个设备。失败不影响功能，只是诊断少一条信息 —— 但多显卡机器上
    // 这是回答"我指定的那张卡到底用上了没有"的唯一依据，所以失败也要留日志。
    let device = match model.device() {
        Ok(d) => Some(if d.description.is_empty() {
            d.name
        } else {
            d.description
        }),
        Err(e) => {
            log::warn!("Could not read the bound compute device: {}", e);
            None
        }
    };
    let caps = model.capabilities();
    let arch = model.arch();
    let languages = caps.languages.clone();
    let n_langs = languages.len();
    let supports_itn = model.supports(Feature::Itn);
    let supports_pnc = model.supports(Feature::Pnc);
    let session = model
        .session_with(&SessionOptions::default())
        .map_err(|e| format!("Failed to create session ({}): {}", model_id, e))?;

    let max_audio_ms = session
        .limits()
        .map(|l| l.effective_max_audio_ms)
        .unwrap_or(caps.max_audio_ms);

    let mut entry = Loaded {
        model_id: model_id.to_string(),
        accelerator: accelerator.to_string(),
        gpu_device: gpu_device.to_string(),
        backend,
        device,
        max_audio_ms,
        supports_itn,
        supports_pnc,
        languages,
        session,
    };
    let load_ms = start.elapsed().as_millis();

    // 预热：见 warmup() 的说明。必须在放进缓存之前做完，否则并发的第一次转写会
    // 抢在预热之前跑，白付一次 pipeline 编译。
    let warmup_ms = warmup(&mut entry);

    log::info!(
        "GGUF ASR ready in {}ms (load {}ms + warmup {}ms): {} arch={} backend={} device={} langs={} max_audio_ms={} itn={} pnc={}",
        start.elapsed().as_millis(),
        load_ms,
        warmup_ms,
        model_id,
        arch,
        entry.backend,
        entry.device.as_deref().unwrap_or("unknown"),
        n_langs,
        max_audio_ms,
        supports_itn,
        supports_pnc
    );

    mark_loaded(&entry.backend, entry.device.as_deref());
    *cache = Some(entry);
    // 必须在释放 CACHE 锁之前刷新；否则空闲守护线程可能在这里插入并卸载
    // 刚加载完成、马上要用于推理的模型。
    touch_activity();
    Ok(())
}

/// 一小段真实中文语音，编进二进制里专门用于预热（97 KB，就是 benchmark 用的那条）。
/// 用真实语音而不是静音：Qwen3 这类自回归模型在静音上可能一个 token 都不生成，
/// 那样 decoder 侧的 pipeline 就建不起来，预热等于没做。
const WARMUP_WAV: &[u8] = include_bytes!("../../resources/test_zh.wav");
/// 预热只用前这么多秒，够把 kernel 都摸一遍就行，不必跑完整段。
const WARMUP_SEC: usize = 2;

/// 加载完权重后跑一次推理，把计算后端的 compute pipeline 建起来。
///
/// 为什么必须做：ggml 的 Vulkan pipeline 是**首次推理时才惰性编译**的，不在模型
/// 加载阶段。不预热的话这笔一次性开销会落在用户的第一次口述上 —— 实测 1.7B 在
/// Vulkan 上第一次解码 8.7 s、第二次同样长度只要 2.6 s。
///
/// 返回耗时（毫秒）。失败不算错误：预热只是优化，失败了顶多第一次慢一点。
fn warmup(entry: &mut Loaded) -> u128 {
    let t0 = Instant::now();
    let pcm: Vec<f32> = WARMUP_WAV
        .get(44..) // 跳过 WAV header
        .unwrap_or(&[])
        .chunks_exact(2)
        .take(WARMUP_SEC * 16000)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    if pcm.is_empty() {
        return 0;
    }
    // 预热只为建 pipeline，语言无所谓，用自动检测即可
    let opts = run_options(
        "auto",
        &entry.languages,
        entry.supports_itn,
        entry.supports_pnc,
    );
    if let Err(e) = entry.session.run(&pcm, &opts) {
        log::warn!("Warm-up inference failed; functionality is unaffected, but the first run will be slower: {}", e);
    }
    t0.elapsed().as_millis()
}

/// 把界面上的语种设置解析成**当前模型真正接受的那个串**。
///
/// 为什么不能直接透传：各族自报的语种码粒度不一样。SenseVoice / Fun-ASR /
/// Qwen3-ASR 报的是裸码（`zh` / `en` / `ja`），而 parakeet 族的 nemotron-3.5 报的
/// 是带地区的 locale（`en-US` / `en-GB` / `zh-CN` / `ja-JP` …）并且**只认带地区的
/// 形式** —— 把 `en` 传给它会直接 `unsupported language (status 10)`，整次转写失败。
/// 而 `localAsr.language` 的取值只有 `auto|zh|en|ja|ko`，永远给不出 `en-US`。
///
/// 三级降解：精确命中 → 同语言的第一个 locale → 放弃。
///
/// 最后一级刻意回落到 `None`（自动检测）而不是把原串硬塞过去：模型压根没广告
/// 这个语种时（比如给纯英文的 parakeet 选中文），让它自己判最多是结果不理想，
/// 硬塞则是稳定报错。这一条也顺手修掉了老行为里的一个坑 —— Fun-ASR 只支持
/// zh/en/ja，之前选「韩语」会把 `ko` 塞给它。
fn resolve_language(requested: &str, supported: &[String]) -> Option<String> {
    if matches!(requested, "" | "auto") {
        return None;
    }
    // 语种无关的模型（caps.languages 为空）没有清单可比，按原样传。
    if supported.is_empty() {
        return Some(requested.to_string());
    }
    if let Some(hit) = supported.iter().find(|l| l.eq_ignore_ascii_case(requested)) {
        return Some(hit.clone());
    }
    let prefix = format!("{}-", requested.to_ascii_lowercase());
    if let Some(hit) = supported
        .iter()
        .find(|l| l.to_ascii_lowercase().starts_with(&prefix))
    {
        return Some(hit.clone());
    }
    None
}

/// 构造运行参数。
///
/// ITN 只在模型族真支持时才请求：SenseVoice 的标点就挂在 ITN 上（不开会走
/// `<|woitn|>` 分支、输出没有标点），而 Qwen3-ASR 不支持这个开关、标点是模型
/// 固有行为。对不支持的族请求 On 不会出错，但库每次转写都会打一条
/// "does not support itn control" 的 WARN —— 按加载时探到的能力来决定，
/// 日志才干净。PNC 同理（parakeet 族两个也都不支持，标点是固有行为）。
fn run_options(
    language: &str,
    supported_languages: &[String],
    supports_itn: bool,
    supports_pnc: bool,
) -> RunOptions {
    RunOptions {
        language: resolve_language(language, supported_languages),
        itn: if supports_itn { Itn::On } else { Itn::Default },
        pnc: if supports_pnc { Pnc::On } else { Pnc::Default },
        ..Default::default()
    }
}

/// 用常驻 session 转写。超过 session 上限的音频按上限切段顺序解码。
/// `language` 是每次转写传入的运行时参数，不影响模型缓存。
fn transcribe_with_cache(
    samples: &[f32],
    sample_rate: usize,
    language: &str,
) -> Result<String, String> {
    let mut cache = CACHE.lock().map_err(|e| format!("Failed to acquire model cache lock: {}", e))?;
    let entry = cache.as_mut().ok_or("Model is not loaded")?;
    // 守卫会在所有成功/错误返回路径上、释放 CACHE 锁之前刷新最后活动时间。
    let _activity_guard = ActivityGuard;
    touch_activity();
    let opts = run_options(
        language,
        &entry.languages,
        entry.supports_itn,
        entry.supports_pnc,
    );

    let limit = if entry.max_audio_ms > 0 {
        (entry.max_audio_ms as usize / 1000) * sample_rate
    } else {
        usize::MAX
    };

    if samples.len() <= limit {
        return entry
            .session
            .run(samples, &opts)
            .map(|t| t.text.trim().to_string())
            .map_err(|e| format!("Inference failed: {}", e));
    }

    // 极长音频（超过模型上下文）才走分段。日常口述不会走到这里。
    log::warn!(
        "Audio length {:.1}s exceeds the model limit {:.1}s; decoding in segments",
        samples.len() as f64 / sample_rate as f64,
        limit as f64 / sample_rate as f64
    );
    let mut out = String::new();
    for chunk in samples.chunks(limit) {
        let text = entry
            .session
            .run(chunk, &opts)
            .map_err(|e| format!("Inference failed: {}", e))?;
        append_segment_text(&mut out, &text.text);
    }
    Ok(out)
}

/// 把分段识别出的一段文字接到结果后面。前一段没以标点收尾时补一个空格，
/// 免得两段英文粘成一个词。超上限分段和 local_asr 按停顿切块共用这一份。
pub(crate) fn append_segment_text(out: &mut String, text: &str) {
    let t = text.trim();
    if t.is_empty() {
        return;
    }
    if !out.is_empty() && !out.ends_with(|c: char| "，。！？、,.!?".contains(c)) {
        out.push(' ');
    }
    out.push_str(t);
}

// ── 对外接口（被 local_asr.rs 的命令层分派调用）──

/// 显卡在本进程里出过后端错误，之后一律改用 CPU。
///
/// 典型来源是 Windows 显卡看门狗把显卡重置了（LiveKernelEvent 141，Vulkan 报
/// DeviceLost）。重置之后本进程拿到的 Vulkan 设备就废了，ggml 不会重建它：
/// 2026-10-19 实测，之后不管识别多短、换哪个模型，加载和推理都立刻报
/// `backend error (status 8)`，只能重启 SayIt。改用 CPU 至少还能用，只是慢。
/// 只记在内存里：重启后显卡是好的，下次照常用 GPU。
static GPU_FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn effective_accelerator(requested: &str) -> &str {
    if GPU_FAILED.load(std::sync::atomic::Ordering::Relaxed) {
        "cpu"
    } else {
        requested
    }
}

/// 库把显卡层面的失败统一报成 `backend error`（status 8）。错误串里看不到
/// DeviceLost 本身（那句只出现在库自己的日志里），所以按这个类别判。
fn is_backend_error(error: &str) -> bool {
    error.contains("backend error")
}

/// 刚才那次是不是跑在显卡上（或者本来要上显卡、加载就失败了）。
fn was_on_gpu(accelerator: &str) -> bool {
    match current_backend() {
        Some(backend) => !backend.to_lowercase().contains("cpu"),
        None => accelerator != "cpu",
    }
}

/// 在显卡上出了后端错误时，标记显卡不可用并用 CPU 重试一次。
fn with_gpu_fallback<T>(
    model_id: &str,
    accelerator: &str,
    gpu_device: &str,
    run: impl Fn(&str) -> Result<T, String>,
) -> Result<T, String> {
    let accel = effective_accelerator(accelerator);
    match run(accel) {
        Err(error) if accel != "cpu" && is_backend_error(&error) && was_on_gpu(accel) => {
            GPU_FAILED.store(true, std::sync::atomic::Ordering::Relaxed);
            log::error!(
                "GPU backend failed; local ASR switches to CPU until SayIt restarts model={} gpu_device={} error={}",
                model_id,
                gpu_device,
                error
            );
            run("cpu")
        }
        other => other,
    }
}

/// 预加载模型。
pub fn preload(model_id: &str, accelerator: &str, gpu_device: &str) -> Result<(), String> {
    with_gpu_fallback(model_id, accelerator, gpu_device, |accel| {
        ensure_loaded(model_id, accel, gpu_device)
    })
}

/// 释放常驻引擎，交还几百 MB ~ 数 GB 内存。
pub fn unload() {
    if let Ok(mut cache) = CACHE.lock() {
        if let Some(entry) = cache.take() {
            log::info!("Unloading GGUF ASR model: {}", entry.model_id);
        }
    }
    mark_unloaded();
}

/// 当前绑定的后端字符串，None = 未加载。
/// 读 STATUS 那把小锁，**不碰 CACHE** —— 见 STATUS 的说明。
pub fn current_backend() -> Option<String> {
    STATUS.lock().ok().and_then(|s| s.backend.clone())
}

/// 当前**实际**绑定的计算设备描述，None = 未加载或库没报。
/// 多显卡机器上这才是"用的哪张卡"的答案，别用用户的选择代替。
pub fn current_device() -> Option<String> {
    STATUS.lock().ok().and_then(|s| s.device.clone())
}

/// 正在加载中的模型 id，None = 没有加载在进行。
/// 与 `current_backend` 互斥：加载中时后端一定是 None，界面该显示"正在加载"
/// 而不是"模型未加载"。
pub fn loading_model() -> Option<String> {
    STATUS.lock().ok().and_then(|s| s.loading_model.clone())
}

/// 转写一段 16 kHz mono f32 PCM。
pub fn transcribe(
    model_id: &str,
    language: &str,
    accelerator: &str,
    gpu_device: &str,
    samples: &[f32],
    sample_rate: usize,
) -> Result<String, String> {
    with_gpu_fallback(model_id, accelerator, gpu_device, |accel| {
        ensure_loaded(model_id, accel, gpu_device)?;
        transcribe_with_cache(samples, sample_rate, language)
    })
}

// ── 空闲卸载 ──

/// 最近一次用到引擎的时刻（Unix 毫秒）。加载和转写都会刷新。
static LAST_USE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn touch_activity() {
    LAST_USE_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

/// 推理持有 CACHE 锁期间的活动守卫。声明在锁变量之后，因此离开函数时会先
/// 更新时间、再释放锁；空闲线程拿到锁时看到的一定是本次推理完成后的时间。
struct ActivityGuard;

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        touch_activity();
    }
}

/// 当前空闲卸载配置。0 = 永不自动卸载；设置页可动态改为 10 / 30 / 60。
static IDLE_UNLOAD_MINUTES: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
static IDLE_UNLOADER_STARTED: std::sync::Once = std::sync::Once::new();

pub fn set_idle_unload_minutes(idle_minutes: u64) {
    IDLE_UNLOAD_MINUTES.store(idle_minutes, std::sync::atomic::Ordering::SeqCst);
    if idle_minutes == 0 {
        log::info!("Local model idle unload is disabled; the model will remain in memory");
    } else {
        log::info!("Local model idle unload interval set to {} minutes", idle_minutes);
    }
}

/// 启动唯一的空闲守护线程。线程每轮读取最新配置，因此设置页修改后立即生效，
/// 无需重复创建线程。到期判断与 cache.take 在同一次加锁内完成；若推理正在运行，
/// 守护线程会等待推理释放锁，再看到 ActivityGuard 刷新的时间，不会误卸载。
///
/// 卸载后的第一次转写需要重新加载和预热（大模型约数秒）；默认值 0 让模型常驻，
/// 内存紧张的用户可主动选择空闲 10 / 30 / 60 分钟后释放。
pub fn spawn_idle_unloader(initial_idle_minutes: u64) {
    set_idle_unload_minutes(initial_idle_minutes);
    IDLE_UNLOADER_STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            // 配置为 0 时避免无意义地争用推理锁；拿到锁后还会再读一次，防止
            // 用户恰在这段间隙切换为“不自动卸载”却仍按旧配置卸载一次。
            if IDLE_UNLOAD_MINUTES.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                continue;
            }

            let mut cache = match CACHE.lock() {
                Ok(cache) => cache,
                Err(error) => {
                    log::warn!("Failed to acquire lock during local model idle check: {}", error);
                    continue;
                }
            };
            let idle_minutes =
                IDLE_UNLOAD_MINUTES.load(std::sync::atomic::Ordering::SeqCst);
            if idle_minutes == 0 {
                continue;
            }
            let idle_ms = idle_minutes.saturating_mul(60).saturating_mul(1000);
            if cache.is_none() {
                continue;
            }

            let last = LAST_USE_MS.load(std::sync::atomic::Ordering::Relaxed);
            if last == 0 || now_ms().saturating_sub(last) < idle_ms {
                continue;
            }

            if let Some(entry) = cache.take() {
                log::info!(
                    "Local model was idle for {} minutes; unloaded to free memory: {}",
                    idle_minutes,
                    entry.model_id
                );
                // 这里是直接 take 而不是走 unload()（已经持着 CACHE 锁了），
                // 所以状态镜像要自己同步，否则诊断页会一直报着已卸载的后端。
                mark_unloaded();
            }
        });
    });
}

// 注：曾有个 `is_gguf_model()` 用于在 sherpa / GGUF 之间分派。1c 之后本地只剩
// 这一个引擎，分派没有意义，已删除。catalog 里的 id 仍保留 `-gguf` 后缀 ——
// 它现在的作用是让新权重目录和上一代 ONNX 目录不撞名，从而让旧模型回收能靠
// 目录名白名单精确定位（见 local_asr::LEGACY_MODEL_IDS）。

#[cfg(test)]
mod tests {
    use super::*;

    const SR_U: usize = 16000;

    /// 读 16 kHz / mono / 16-bit WAV 为 f32（只够读我们自己的测试音频）。
    fn read_wav(name: &str) -> Vec<f32> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("resources/{name}: {e}"));
        assert_eq!(&bytes[0..4], b"RIFF");
        bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect()
    }

    fn read_test_wav() -> Vec<f32> {
        read_wav("test_zh.wav")
    }

    /// 英文测试音频。纯英文模型（parakeet-unified-en）在中文音频上输出**空字符串**，
    /// 拿 test_zh.wav 测它只会得到一条看不出原因的"输出为空"。
    /// 由 dev-scripts/make-test-en-wav.ps1 生成，可重现。
    fn read_test_en_wav() -> Vec<f32> {
        read_wav("test_en.wav")
    }

    /// 模型没下载就跳过（CI / 干净机器上不该因为缺几百 MB 权重而红）。
    fn model_present(model_id: &str) -> bool {
        find_gguf(&model_dir(model_id)).is_ok()
    }

    fn run(model_id: &str, repeats: usize) -> String {
        run_with(model_id, repeats, read_test_wav(), "auto")
    }

    /// `language` 走的是真实的 `transcribe()` 入口，所以这些测试也在过
    /// `resolve_language`（例如把 `en` 解析成 nemotron 要的 `en-US`）。
    fn run_with(model_id: &str, repeats: usize, base: Vec<f32>, language: &str) -> String {
        init_backends();
        assert!(
            !transcribe_cpp::devices().is_empty(),
            "没有注册到任何计算设备：DLL 没放到 exe 旁边？"
        );
        let mut pcm = Vec::with_capacity(base.len() * repeats);
        for _ in 0..repeats {
            pcm.extend_from_slice(&base);
        }
        transcribe(model_id, language, "auto", "", &pcm, SR_U).expect("转写失败")
    }

    /// SenseVoice：转写要出中文，且**必须有标点**。
    /// 标点靠 RunOptions 的 itn=on 打开（默认走 <|woitn|> 分支、没有标点），
    /// 这条断言就是防止哪天有人把 itn 改回 Default 而没人发现。
    #[test]
    fn sensevoice_gguf_has_punctuation() {
        let id = "sensevoice-small-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run(id, 3);
        assert!(!text.trim().is_empty(), "输出为空");
        assert!(
            text.chars().any(|c| "，。！？、".contains(c)),
            "SenseVoice 输出没有标点，itn 开关可能失效了: {text:?}"
        );
        // 特殊标签不该漏到最终文本里
        assert!(!text.contains("<|"), "输出残留特殊标签: {text:?}");
        unload();
    }

    /// Qwen3-ASR：自带标点，且输出不该带 `<asr_text>` 这类模板前缀
    /// （sherpa 的 ONNX 导出会带，需要额外清洗；ggml 这条路不需要）。
    fn assert_qwen3_output(id: &str) {
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run(id, 3);
        // 打出来便于人眼比对不同量化档的输出质量（Q4_K_M 这种激进量化最容易
        // 在这里露出马脚：错字、漏字、标点乱）
        eprintln!("[text] {id}: {text}");
        assert!(!text.trim().is_empty(), "{id} 输出为空");
        assert!(
            !text.contains("<asr_text>") && !text.contains("<|"),
            "{id} 输出带模板前缀/特殊标签: {text:?}"
        );
        assert!(
            text.chars().any(|c| "，。！？、".contains(c)),
            "{id} 输出没有标点: {text:?}"
        );
        unload();
    }

    #[test]
    fn qwen3_06b_gguf_is_clean_and_punctuated() {
        assert_qwen3_output("qwen3-asr-0.6b-gguf");
    }

    /// 1.7B 与 0.6B 同族同契约，只是更大更准更慢，行为断言完全一样。
    #[test]
    fn qwen3_17b_gguf_is_clean_and_punctuated() {
        assert_qwen3_output("qwen3-asr-1.7b-gguf");
    }

    /// 1.7B 的 Q4_K_M 档。量化更狠，但契约不变 —— 这条守的是"换量化档不该改变
    /// 输出形态"（比如更低的量化位宽让模型开始吐特殊标签或丢标点）。
    #[test]
    fn qwen3_17b_q4_gguf_is_clean_and_punctuated() {
        assert_qwen3_output("qwen3-asr-1.7b-q4-gguf");
    }

    /// Parakeet Unified EN：英文专用。标点、大小写、数字规范化都是模型固有行为
    /// （ITN/PNC 开关它都报 unsupported），所以这里断言的是"默认就该有"。
    ///
    /// 同时钉住 `language="en"` 这条路：parakeet 自报的语种码是裸 `en`，
    /// `resolve_language` 应当精确命中、原样传过去。
    #[test]
    fn parakeet_en_gguf_is_punctuated_and_capitalized() {
        let id = "parakeet-unified-en-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run_with(id, 1, read_test_en_wav(), "en");
        eprintln!("[text] {id}: {text}");
        assert!(!text.trim().is_empty(), "{id} 输出为空");
        assert!(!text.contains("<|") && !text.contains('<'), "残留特殊标签: {text:?}");
        assert!(
            text.contains('.') || text.contains(','),
            "{id} 英文输出没有标点: {text:?}"
        );
        assert!(
            text.chars().any(|c| c.is_ascii_uppercase()),
            "{id} 输出没有大写字母，capitalization 失效？: {text:?}"
        );
        unload();
    }

    /// Nemotron 3.5：本目录里第一个只认**带地区 locale** 的模型。
    ///
    /// 这条测试的重点不是转写质量，而是 `language="en"` 不会炸 —— 界面上的
    /// `localAsr.language` 只有 auto/zh/en/ja/ko，不经 `resolve_language` 映射成
    /// `en-US` 就会得到 `unsupported language (status 10)`，用户选「英语」后
    /// 每次口述都失败。断言"有输出"就足以证明映射生效了。
    #[test]
    fn nemotron_gguf_accepts_a_bare_language_code() {
        let id = "nemotron-asr-streaming-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run_with(id, 1, read_test_en_wav(), "en");
        eprintln!("[text] {id} (language=en): {text}");
        assert!(
            !text.trim().is_empty(),
            "{id} 在 language=en 下输出为空 —— locale 映射可能失效了"
        );
        // auto 检测模式会在原始 token 流里插 <en-US> 这类标签，库默认会清掉。
        // 漏到最终文本里就会被当成用户说的话插进目标程序。
        assert!(!text.contains('<') && !text.contains('>'), "残留语种标签: {text:?}");
        unload();
    }

    /// 多语种模型选到它不支持的语种时不该报错。nemotron 支持 zh-CN，
    /// 所以这里顺便验证中文也能走通（它是目录里唯一同时覆盖中英的新模型）。
    #[test]
    fn nemotron_gguf_handles_chinese_via_locale_mapping() {
        let id = "nemotron-asr-streaming-0.6b-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run_with(id, 3, read_test_wav(), "zh");
        eprintln!("[text] {id} (language=zh): {text}");
        assert!(!text.trim().is_empty(), "{id} 在 language=zh 下输出为空");
        assert!(!text.contains('<') && !text.contains('>'), "残留语种标签: {text:?}");
        unload();
    }

    /// Fun-ASR Nano：和 SenseVoice 一样，标点挂在 ITN 开关上（探针里用
    /// `RunOptions::default()` 跑出来是**没有标点**的）。这条走生产路径，
    /// 断言 `run_options()` 的 itn 门控确实把标点开出来了。
    /// 它还是个 audio-LLM（带 chat template），所以顺带守住"别把模板前缀吐出来"。
    #[test]
    fn funasr_nano_gguf_is_clean_and_punctuated() {
        let id = "funasr-nano-2512-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        let text = run(id, 3);
        eprintln!("[text] {id}: {text}");
        assert!(!text.trim().is_empty(), "输出为空");
        assert!(
            text.chars().any(|c| "，。！？、".contains(c)),
            "Fun-ASR Nano 输出没有标点，itn 门控失效了？: {text:?}"
        );
        assert!(
            !text.contains("<|") && !text.contains("<asr_text>") && !text.contains("im_start"),
            "输出残留模板/特殊标签: {text:?}"
        );
        unload();
    }

    /// 不支持 ITN 的模型族不该被请求 ITN —— 否则库每次转写都打一条
    /// "does not support itn control" 的 WARN，把日志刷脏。
    #[test]
    fn itn_is_only_requested_when_the_family_supports_it() {
        let supported = run_options("auto", &[], true, false);
        assert_eq!(supported.itn, Itn::On);
        assert_eq!(supported.pnc, Pnc::Default);

        let unsupported = run_options("auto", &[], false, false);
        assert_eq!(unsupported.itn, Itn::Default);
        assert_eq!(unsupported.pnc, Pnc::Default);
    }

    /// 裸码族（SenseVoice / Fun-ASR / Qwen3-ASR）的清单，用于下面几条断言。
    fn bare_codes() -> Vec<String> {
        ["zh", "yue", "en", "ja", "ko"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    /// nemotron-3.5 的真实清单（截取，保留顺序 —— `en` 要解析成 `en-US` 而不是
    /// `en-GB`，靠的就是顺序）。
    fn nemotron_locales() -> Vec<String> {
        ["en-US", "en-GB", "de-DE", "ja-JP", "ko-KR", "zh-CN"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn auto_language_means_autodetect() {
        let langs = bare_codes();
        assert!(run_options("auto", &langs, false, false).language.is_none());
        assert!(run_options("", &langs, false, false).language.is_none());
        assert_eq!(
            run_options("zh", &langs, false, false).language.as_deref(),
            Some("zh")
        );
    }

    /// 裸码族的行为必须和加 `resolve_language` 之前完全一样，否则这个改动就把
    /// 已发布的三个模型搞坏了。
    #[test]
    fn bare_language_codes_pass_through_unchanged() {
        let langs = bare_codes();
        for code in ["zh", "en", "ja", "ko", "yue"] {
            assert_eq!(
                resolve_language(code, &langs).as_deref(),
                Some(code),
                "{code} 在裸码族上不该被改写"
            );
        }
    }

    /// nemotron-3.5 只认带地区的 locale，`en` 必须被解析成 `en-US`。
    /// 不做这层映射的话，用户在设置里选「英语」会得到
    /// `unsupported language (status 10)`，整次转写失败。
    #[test]
    fn bare_code_maps_to_the_models_regional_locale() {
        let langs = nemotron_locales();
        assert_eq!(resolve_language("en", &langs).as_deref(), Some("en-US"));
        assert_eq!(resolve_language("zh", &langs).as_deref(), Some("zh-CN"));
        assert_eq!(resolve_language("ja", &langs).as_deref(), Some("ja-JP"));
        assert_eq!(resolve_language("ko", &langs).as_deref(), Some("ko-KR"));
        // 大小写不该影响匹配
        assert_eq!(resolve_language("EN", &langs).as_deref(), Some("en-US"));
    }

    /// 模型没广告的语种回落到自动检测，而不是把原串硬塞过去让它报错。
    /// 例：给只有 `["en"]` 的 parakeet-unified-en 选中文。
    #[test]
    fn unsupported_language_falls_back_to_autodetect() {
        let english_only = vec!["en".to_string()];
        assert_eq!(resolve_language("en", &english_only).as_deref(), Some("en"));
        assert!(resolve_language("zh", &english_only).is_none());
        assert!(resolve_language("ko", &english_only).is_none());
    }

    /// 语种无关的模型（清单为空）没有可比对象，保持原样透传。
    #[test]
    fn empty_language_list_passes_the_request_through() {
        assert_eq!(resolve_language("zh", &[]).as_deref(), Some("zh"));
        assert!(resolve_language("auto", &[]).is_none());
    }

    // ── 后端注册必须保持懒加载（源码约束）──
    //
    // 为什么用源码扫描而不是行为测试：`init_backends` 是进程级 `Once`，同一个测试
    // 进程里别的测试可能已经注册过，所以运行时没法观测"启动路径有没有注册"。
    // 而这条约束一旦破了，症状是"云 API 用户又开始白占显存"——用户能看见，
    // 测试却全绿。仿照 main.rs 里 `configured_windows_do_not_override_webview2_browser_args`
    // 的同一套做法。

    /// 去掉行注释，避免注释里出现的函数名被当成真实调用。
    fn strip_line_comments(source: &str) -> String {
        source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 启动路径绝不能注册计算后端。加回去等于让云 API / 服务器模式的用户重新白付
    /// 一个 Vulkan 上下文（约 36 MB 共享显存 + 80~520 ms 启动阻塞），而他们一个
    /// 模型都不会加载。详见 `init_backends` 的文档注释。
    #[test]
    fn startup_path_does_not_register_compute_backends() {
        let main_rs = strip_line_comments(include_str!("../main.rs"));
        assert!(
            !main_rs.contains("init_backends"),
            "main.rs 又在启动路径上注册计算后端了。这会 dlopen ggml-vulkan.dll 并建出\n\
             Vulkan 上下文，云 API / 服务器模式的用户白付显存与启动时间。\n\
             注册应当只发生在 gguf_asr 的懒路径（ensure_loaded / describe_devices）。"
        );
    }

    /// 反向约束：懒路径必须真的自己注册。少了这一步，本地模式会在
    /// `Model::load_with` 直接报 TRANSCRIBE_ERR_BACKEND，诊断页的设备列表会空白。
    #[test]
    fn lazy_entry_points_register_compute_backends() {
        let source = strip_line_comments(include_str!("gguf_asr.rs"));
        for (entry, signature) in [
            (
                "ensure_loaded",
                "fn ensure_loaded(model_id: &str, accelerator: &str, gpu_device: &str)",
            ),
            ("describe_devices", "pub fn describe_devices()"),
        ] {
            let body_start = source
                .find(signature)
                .unwrap_or_else(|| panic!("{entry} 的签名变了，请同步更新这条测试"));
            // 只看函数开头这一小段：注册是前置动作，必须在任何实际工作之前发生。
            let head = &source[body_start..(body_start + 700).min(source.len())];
            assert!(
                head.contains("init_backends()"),
                "{entry} 没有先调用 init_backends()。启动路径上已经不注册了，\n\
                 这里少一步就会让本地模式报 TRANSCRIBE_ERR_BACKEND / 设备列表空白。"
            );
        }
    }

    /// 一台"集显 + 独显 + CPU"机器的设备清单，顺序照 ggml 的 registry
    /// （GPU 在前、CPU 最后，与本机实测 `[vulkan:Vulkan0, cpu:CPU]` 一致）。
    fn fake_devices() -> Vec<GgufDevice> {
        vec![
            GgufDevice {
                kind: "vulkan".into(),
                name: "Integrated Graphics".into(),
                memory_mb: 2048,
                id: "PCI:0000:00:02.0".into(),
                index: 0,
                is_gpu: true,
            },
            GgufDevice {
                kind: "vulkan".into(),
                name: "Discrete GPU".into(),
                memory_mb: 8192,
                id: "PCI:0000:01:00.0".into(),
                index: 1,
                is_gpu: true,
            },
            GgufDevice {
                kind: "cpu".into(),
                name: "CPU".into(),
                memory_mb: 32768,
                id: "cpu:CPU".into(),
                index: 2,
                is_gpu: false,
            },
        ]
    }

    /// 选第二张卡是这个功能的主用例（反馈里的原话：显卡 0 已经被别的模型占满，
    /// 想让 SayIt 用显卡 1）。必须解析成那张卡的 registry 索引。
    #[test]
    fn selecting_a_secondary_gpu_yields_its_registry_index() {
        assert_eq!(
            pick_gpu_device_index(&fake_devices(), "PCI:0000:01:00.0", "auto"),
            1
        );
        // 显式请求 GPU 后端时同样成立（上游会额外校验厂商一致，Vulkan 对 Vulkan 没问题）
        assert_eq!(
            pick_gpu_device_index(&fake_devices(), "PCI:0000:01:00.0", "gpu"),
            1
        );
    }

    /// 四条回落，每一条都必须落到 0（自动），绝不能把非法值传给上游 ——
    /// 上游对非法 `gpu_device` 是**直接报 INVALID_ARG 让整次加载失败**，
    /// 不是悄悄回落。用户换了张显卡就打不开本地识别是不可接受的。
    #[test]
    fn invalid_or_unavailable_selections_fall_back_to_automatic() {
        let devs = fake_devices();
        // 没设置 / 显式自动
        assert_eq!(pick_gpu_device_index(&devs, "", "auto"), 0);
        assert_eq!(pick_gpu_device_index(&devs, "auto", "auto"), 0);
        // 设置里记着一张已经不在机器上的卡（换卡、拔了 eGPU、驱动没起来）
        assert_eq!(pick_gpu_device_index(&devs, "PCI:0000:09:00.0", "auto"), 0);
        // 指向了 CPU：上游判 "is not a GPU device" → INVALID_ARG
        assert_eq!(pick_gpu_device_index(&devs, "cpu:CPU", "auto"), 0);
        // 后端选了 CPU 时任何非零值都是 INVALID_ARG（"no GPU to select"）
        assert_eq!(pick_gpu_device_index(&devs, "PCI:0000:01:00.0", "cpu"), 0);
    }

    /// registry 索引 0 是上游的"自动"哨兵，没有办法显式选中它。
    /// 这条钉住的是我们**知道**这个限制并按 0 传 —— 传 0 只是让库按探测顺序挑
    /// （独显优先），所以界面上必须靠 `current_device` 显示真实结果，
    /// 显卡被重置后库返回的两种错误（2026-10-19 sayit.log 原样）都要被认成后端错误，
    /// 否则不会回落到 CPU；模型没下载、语种不支持这类错误不能触发回落。
    #[test]
    fn device_lost_errors_trigger_cpu_fallback_and_others_do_not() {
        assert!(is_backend_error("Inference failed: backend error: run: backend error (status 8)"));
        assert!(is_backend_error(
            "Failed to load model (sensevoice-small-gguf): backend error: load C:\\x\\SenseVoiceSmall-Q8_0.gguf: backend error (status 8)"
        ));
        assert!(!is_backend_error("No .gguf file found in model directory"));
        assert!(!is_backend_error("Inference failed: unsupported language (status 10)"));
    }

    /// 不能假设"选了就是用了"。详见 `resolve_gpu_device` 的文档注释。
    #[test]
    fn registry_index_zero_is_the_automatic_sentinel() {
        assert_eq!(
            pick_gpu_device_index(&fake_devices(), "PCI:0000:00:02.0", "auto"),
            0
        );
    }

    /// 内嵌的预热音频必须能解析出足够的样本。这条防的是 include_bytes! 的路径
    /// 写错或资源文件被换掉 —— 那样预热会静默变成空操作，第一次口述又会慢回去。
    #[test]
    fn warmup_wav_yields_usable_pcm() {
        let n = WARMUP_WAV
            .get(44..)
            .unwrap_or(&[])
            .chunks_exact(2)
            .take(WARMUP_SEC * 16000)
            .count();
        assert!(
            n >= 16000,
            "预热音频只解析出 {n} 个样本（不足 1 秒），include_bytes! 路径或资源文件有问题"
        );
    }

    /// 加载完成后引擎必须已经预热过：紧接着的第一次转写不该再有 pipeline 编译
    /// 那种量级的额外开销。用"第一次 ≈ 第二次"来验证，比断言绝对耗时稳。
    #[test]
    fn first_transcribe_after_load_is_not_slower_than_the_second() {
        let id = "sensevoice-small-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        unload();
        let base = read_test_wav();

        // 这一次含加载 + 预热
        let t_load = std::time::Instant::now();
        let _ = transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
        let load_and_first = t_load.elapsed().as_secs_f64();

        let t1 = std::time::Instant::now();
        let _ = transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
        let first = t1.elapsed().as_secs_f64();

        let t2 = std::time::Instant::now();
        let _ = transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
        let second = t2.elapsed().as_secs_f64();

        eprintln!(
            "[perf] {id}: load+warmup+run={load_and_first:.3}s then {first:.3}s / {second:.3}s"
        );
        // 预热到位时两次稳定态解码应该接近；给 3 倍余量吸收调度噪声
        assert!(
            first < second * 3.0 + 0.3,
            "加载后的第一次解码 {first:.3}s 远慢于第二次 {second:.3}s，预热没生效？"
        );
        unload();
    }

    /// 走生产路径（accelerator="auto"）跑一遍，打印实际绑定的后端和 RTF。
    ///
    /// 不断言"必须是 vulkan" —— 没 GPU 的机器也得能过。断言的是一个宽松的 RTF
    /// 上限：正常情况下最慢的 1.7B 纯 CPU 也在 0.4 左右，超过 2.0 说明有东西
    /// 严重不对（回落到了病态路径、或者 n_threads 没生效之类）。
    #[test]
    fn report_backend_and_rtf() {
        let ids = ALL_MODELS;
        let base = read_test_wav();
        let repeats = 3;
        let audio_sec = (base.len() * repeats) as f64 / SR_U as f64;

        for id in ids {
            if !model_present(id) {
                eprintln!("skip: {id} 未下载");
                continue;
            }
            // 预热一次（首次含图构建/显存分配），再计时
            let _ = run(id, repeats);
            let t0 = std::time::Instant::now();
            let text = run(id, repeats);
            let secs = t0.elapsed().as_secs_f64();
            let rtf = secs / audio_sec;
            eprintln!(
                "[perf] {id}: backend={} {:.3}s rtf={:.3} audio={:.2}s text_len={}",
                current_backend().unwrap_or_else(|| "?".into()),
                secs,
                rtf,
                audio_sec,
                text.chars().count()
            );
            assert!(
                rtf < 2.0,
                "{id} 的 RTF {rtf:.3} 异常高（backend={:?}）",
                current_backend()
            );
            unload();
        }
    }

    /// `accelerator="cpu"` 必须真的绑到 CPU 上。
    ///
    /// 这是用户遇到 GPU 驱动问题时的逃生口：机器上有可用 Vulkan 设备、但设置里
    /// 选了 CPU，就不能悄悄还跑在 GPU 上。没 GPU 的机器上这条自然也成立。
    #[test]
    fn forcing_cpu_binds_cpu_even_when_a_gpu_exists() {
        let id = "sensevoice-small-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        init_backends();
        let has_gpu = transcribe_cpp::devices().iter().any(|d| d.kind != "cpu");
        eprintln!("[info] GPU 设备存在: {has_gpu}");

        let base = read_test_wav();
        let text = transcribe(id, "auto", "cpu", "", &base, SR_U).expect("转写失败");
        assert!(!text.trim().is_empty(), "强制 CPU 后输出为空");
        let backend = current_backend().unwrap_or_default();
        assert!(
            backend.to_lowercase().contains("cpu"),
            "设置要求 CPU，实际绑定到了 {backend:?}"
        );
        unload();
    }

    // ── 调优探针（默认 #[ignore]，手动跑）──
    //
    // 这两条不是回归测试，是"把库暴露的旋钮实测一遍"的实验台，结论记在
    // dev-docs/local-asr-ggml-migration.md。留在仓库里是因为下次换模型/换
    // transcribe.cpp 版本时还要再跑一遍，重写比留着贵。
    //
    //   cargo test --release footprint_report -- --ignored --nocapture --test-threads=1
    //   cargo test --release decode_knobs_report -- --ignored --nocapture --test-threads=1

    const ALL_MODELS: [&str; 5] = [
        "sensevoice-small-gguf",
        "funasr-nano-2512-gguf",
        "qwen3-asr-0.6b-gguf",
        "qwen3-asr-1.7b-q4-gguf",
        "qwen3-asr-1.7b-gguf",
    ];

    /// 每个模型加载后的真实内存占用。权重体积 ≠ 内存占用，catalog 里写给用户看的
    /// "内存占用 X" 应该照这里的实测值写。
    #[test]
    #[ignore]
    fn footprint_report() {
        init_backends();
        let base = read_test_wav();
        for id in ALL_MODELS {
            if !model_present(id) {
                eprintln!("skip: {id} 未下载");
                continue;
            }
            unload();
            std::thread::sleep(std::time::Duration::from_secs(2)); // 等工作集回落
            let before = process_memory_mb();
            transcribe(id, "auto", "auto", "", &base, SR_U).expect("转写失败");
            let after = process_memory_mb();
            let limits = CACHE
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|e| e.session.limits().ok());
            eprintln!(
                "[mem] {id}: {before} MB -> {after} MB (delta {} MB) limits={:?}",
                after.saturating_sub(before),
                limits
            );
        }
        unload();
    }

    /// 候选新模型族的落地探针：能力、输出形态、语言参数、速度。
    ///
    /// 加一个**新架构**（不只是新量化档）之前必须先过这一关 —— 尤其 audio-LLM
    /// 类的族带 chat template，很可能把模板前缀吐进文本里（上一代 ONNX 的
    /// funasr-nano 就需要额外清洗）。权重放到
    /// `%LOCALAPPDATA%\com.sayit.app\models\<dir>\` 下即可，不必先进 catalog。
    #[test]
    #[ignore]
    fn new_family_probe() {
        init_backends();
        let base = read_test_wav();
        let mut pcm = Vec::new();
        for _ in 0..3 {
            pcm.extend_from_slice(&base);
        }
        let audio_sec = pcm.len() as f64 / SR_U as f64;

        for dir in ["funasr-nano-2512-gguf"] {
            let path = match find_gguf(&model_dir(dir)) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("skip: {dir} ({e})");
                    continue;
                }
            };
            let t_load = std::time::Instant::now();
            let model = Model::load_with(
                &path,
                &ModelOptions {
                    backend: Backend::Auto,
                    gpu_device: 0,
                },
            )
            .expect("加载失败");
            let load_ms = t_load.elapsed().as_millis();
            let caps = model.capabilities();
            eprintln!(
                "[probe] {dir}: arch={} variant={} backend={} load={load_ms}ms itn={} pnc={} \
                 lang_detect={} n_langs={} max_ts={:?} max_audio={:.1}min",
                model.arch(),
                model.variant(),
                model.backend(),
                model.supports(Feature::Itn),
                model.supports(Feature::Pnc),
                caps.supports_language_detect,
                caps.languages.len(),
                caps.max_timestamp_kind,
                caps.max_audio_ms as f64 / 60_000.0,
            );

            let mut s = model.session().expect("session 失败");
            // lang_detect=false 的族传 None（自动）会怎样？和显式 "zh" 对照。
            for lang in [None, Some("zh")] {
                let opts = RunOptions {
                    language: lang.map(str::to_string),
                    ..Default::default()
                };
                let _ = s.run(&pcm, &opts); // 预热
                let mem = process_memory_mb();
                let t = std::time::Instant::now();
                match s.run(&pcm, &opts) {
                    Ok(tr) => eprintln!(
                        "[probe] {dir} lang={lang:?}: rtf={:.3} mem={mem}MB detected={:?} text={}",
                        t.elapsed().as_secs_f64() / audio_sec,
                        tr.language,
                        tr.text.trim()
                    ),
                    Err(e) => eprintln!("[probe] {dir} lang={lang:?}: 失败 {e}"),
                }
            }
        }
    }

    /// 语言自动检测的稳定性探针：qwen3 在**短音频 + auto** 下会不会误判语种
    /// （用户报告：识别测试里 1.7B 把 3 秒普通话测试音频判成了粤语）。
    /// 三组对照：冷启动直跑 / 预热后跑（复刻生产路径）/ 显式 zh。
    #[test]
    #[ignore]
    fn language_detect_report() {
        init_backends();
        // 单遍、不重复 —— 和识别测试 run_asr_benchmark 用的时长一致
        let base = read_test_wav();
        eprintln!("[lang] clip = {:.2}s", base.len() as f64 / SR_U as f64);
        for id in ["qwen3-asr-0.6b-gguf", "qwen3-asr-1.7b-q4-gguf", "qwen3-asr-1.7b-gguf"] {
            if !model_present(id) {
                eprintln!("skip: {id} 未下载");
                continue;
            }
            let path = find_gguf(&model_dir(id)).unwrap();
            let model = Model::load_with(
                &path,
                &ModelOptions {
                    backend: Backend::Auto,
                    gpu_device: 0,
                },
            )
            .expect("加载失败");
            let mut s = model.session().expect("session 失败");
            for i in 0..3 {
                let tr = s.run(&base, &RunOptions::default()).expect("推理失败");
                eprintln!(
                    "[lang] {id} auto#{i}: detected={:?} text={}",
                    tr.language,
                    tr.text.trim()
                );
            }
            // 复刻生产路径：先用前 2 秒预热，再跑整段
            let warm: Vec<f32> = base.iter().copied().take(2 * SR_U).collect();
            let _ = s.run(&warm, &RunOptions::default());
            let tr = s.run(&base, &RunOptions::default()).expect("推理失败");
            eprintln!(
                "[lang] {id} after-warmup: detected={:?} text={}",
                tr.language,
                tr.text.trim()
            );
            let tr = s
                .run(
                    &base,
                    &RunOptions {
                        language: Some("zh".into()),
                        ..Default::default()
                    },
                )
                .expect("推理失败");
            eprintln!(
                "[lang] {id} lang=zh: detected={:?} text={}",
                tr.language,
                tr.text.trim()
            );
        }
    }

    /// 解码旋钮扫描：投机解码的 draft 长度、解码上下文上限、时间戳粒度。
    /// 只扫最慢的两个自回归模型 —— 它们才有可观的解码开销可省。
    #[test]
    #[ignore]
    fn decode_knobs_report() {
        init_backends();
        let base = read_test_wav();
        let mut pcm = Vec::new();
        for _ in 0..3 {
            pcm.extend_from_slice(&base);
        }
        let audio_sec = pcm.len() as f64 / SR_U as f64;

        for id in ["qwen3-asr-0.6b-gguf", "qwen3-asr-1.7b-gguf"] {
            if !model_present(id) {
                eprintln!("skip: {id} 未下载");
                continue;
            }
            let path = find_gguf(&model_dir(id)).unwrap();
            let model = Model::load_with(
                &path,
                &ModelOptions {
                    backend: Backend::Auto,
                    gpu_device: 0,
                },
            )
            .expect("加载失败");
            let caps = model.capabilities();
            eprintln!(
                "[caps] {id}: backend={} spec_decode={} streaming={} max_ts={:?} max_audio_ms={}",
                model.backend(),
                caps.supports_spec_decode,
                caps.supports_streaming,
                caps.max_timestamp_kind,
                caps.max_audio_ms
            );

            // (1) n_ctx：0 = 模型上限。关心三件事：max_kv_bytes、实际内存、以及
            // **能吃多长音频**（n_ctx 同时决定 effective_max_audio_ms，砍太小会让
            // 长口述被迫分段）。顺序故意来回走，用来排除"先跑的那个偏慢"这种
            // 升频/缓存导致的假象。
            for n_ctx in [0, 8192, 2048, 8192, 0] {
                let mut s = model
                    .session_with(&SessionOptions {
                        n_ctx,
                        ..Default::default()
                    })
                    .expect("session 失败");
                let limits = s.limits().unwrap();
                let opts = RunOptions::default();
                let _ = s.run(&pcm, &opts); // 预热
                let mem = process_memory_mb();
                let t = std::time::Instant::now();
                let _ = s.run(&pcm, &opts).expect("推理失败");
                eprintln!(
                    "[n_ctx] {id} n_ctx={n_ctx}: eff={} max_audio={:.1}min max_kv={:.0}MB mem={mem}MB rtf={:.3}",
                    limits.effective_n_ctx,
                    limits.effective_max_audio_ms as f64 / 60_000.0,
                    limits.max_kv_bytes as f64 / (1024.0 * 1024.0),
                    t.elapsed().as_secs_f64() / audio_sec
                );
            }

            // (2) spec_k_drafts：-1 = 族默认，0 = 关，正数 = 每步猜几个 token。
            let mut s = model.session().expect("session 失败");
            for k in [-1, 0, 2, 4, 8] {
                let opts = RunOptions {
                    spec_k_drafts: k,
                    ..Default::default()
                };
                let _ = s.run(&pcm, &opts); // 预热该配置
                let t = std::time::Instant::now();
                let out = s.run(&pcm, &opts);
                match out {
                    Ok(tr) => eprintln!(
                        "[spec] {id} k={k}: rtf={:.3} text_len={}",
                        t.elapsed().as_secs_f64() / audio_sec,
                        tr.text.chars().count()
                    ),
                    Err(e) => eprintln!("[spec] {id} k={k}: 失败 {e}"),
                }
            }

            // (3) 时间戳粒度：我们从不用时间戳，Auto 会让库产出"模型支持的最细"。
            for ts in [TimestampKind::Auto, TimestampKind::None] {
                let opts = RunOptions {
                    timestamps: ts,
                    ..Default::default()
                };
                let _ = s.run(&pcm, &opts);
                let t = std::time::Instant::now();
                let _ = s.run(&pcm, &opts).expect("推理失败");
                eprintln!(
                    "[ts] {id} {:?}: rtf={:.3}",
                    ts,
                    t.elapsed().as_secs_f64() / audio_sec
                );
            }
        }
    }

    /// 超过模型音频上限时要能自动分段，而不是报错或截断。
    /// SenseVoice 的上限只有 30 s，拿它做这条最省时间。
    #[test]
    fn audio_over_model_limit_is_chunked() {
        let id = "sensevoice-small-gguf";
        if !model_present(id) {
            eprintln!("skip: {id} 未下载");
            return;
        }
        // test_zh.wav 约 3.05 s，重复 12 遍 ≈ 36.6 s > 30 s 上限
        let text = run(id, 12);
        assert!(!text.trim().is_empty(), "长音频输出为空");
        // 12 段内容相同，至少应该比单段长得多，说明后面的段没被丢掉
        let single = run(id, 1);
        assert!(
            text.chars().count() > single.chars().count() * 3,
            "长音频疑似被截断: len={} single={}",
            text.chars().count(),
            single.chars().count()
        );
        unload();
    }

}
