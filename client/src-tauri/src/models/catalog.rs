// Model catalog

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadSource {
    pub source: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    /// 展示名，不带 GGUF/量化档等术语（那些进 `quant`，前端排进小字参数行）
    pub name: String,
    /// 一句话定位（"速度极快，日常首选"），不再混内存/语种——那些有各自的字段
    pub description: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub languages: Vec<String>,
    pub sources: Vec<DownloadSource>,
    #[serde(default)]
    pub archive_url: Option<String>,
    /// 速度评级 0–10（可带小数，10 最快）
    #[serde(default)]
    pub speed: f32,
    /// 准确度评级 0–10（可带小数，10 最准）
    #[serde(default)]
    pub accuracy: f32,
    /// 是否为推荐（默认）模型
    #[serde(default)]
    pub recommended: bool,
    /// 加载后的常驻内存（MB，**实测工作集**，不是权重体积推算——权重之外还有
    /// KV cache、计算缓冲，Qwen3 这类自回归模型多出 700 MB ~ 1 GB。实测方法见
    /// gguf_asr.rs 的 `footprint_report`）。
    #[serde(default)]
    pub memory_mb: u64,
    /// 语种的展示文案（"中英日韩粤" / "30+ 语种"）。`languages` 留给逻辑用，
    /// 展示不从 code 拼：Qwen3 支持 30 种，逐个列 code 没有意义。
    #[serde(default)]
    pub languages_label: String,
    /// 量化档（"Q8_0" / "Q4_K_M"…）。列表 UI 不再展示（普通用户看不懂），
    /// 留作数据：离线下载指引的文件名里有它，将来放 Tooltip 也用得上。
    #[serde(default)]
    pub quant: String,
    /// 是否直接展示在模型列表里。恰好三个：小（最快）/ 中（均衡）/ 大（最准），
    /// 其余折叠进「更多」——五个平铺用户反而不知道选哪个。
    #[serde(default)]
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub path: String,
    pub complete: bool,
}

fn hf(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{}/resolve/main/{}", repo, file)
}

fn hf_mirror(repo: &str, file: &str) -> String {
    format!("https://hf-mirror.com/{}/resolve/main/{}", repo, file)
}

/// 一份 GGUF 权重的坐标（仓库 / 文件名 / 字节数 / sha256）。
///
/// 抽成一个结构体是为了让体积和校验和**只写一遍**：每个模型要在镜像源和官方源
/// 各出现一次、`total_size_bytes` 还要再写一次。手写三遍的话，换量化档时漏改
/// 其中一处会变成"只有走某个源的用户下载失败"——这种只发生在一半用户身上的
/// 问题最难被发现。
struct GgufWeight {
    repo: &'static str,
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

impl GgufWeight {
    /// 镜像优先、官方兜底。**顺序有意义**：`localAsr.downloadSource` 的值对不上
    /// 任何一个 `source` 时，registry::download_model 会静默回落到第一个源。
    fn sources(&self) -> Vec<DownloadSource> {
        vec![
            self.at("HuggingFace Mirror", hf_mirror(self.repo, self.file)),
            self.at("HuggingFace", hf(self.repo, self.file)),
        ]
    }

    fn at(&self, source: &str, url: String) -> DownloadSource {
        DownloadSource {
            source: source.into(),
            files: vec![ModelFile {
                name: self.file.into(),
                url,
                size_bytes: self.size,
                sha256: Some(self.sha256.into()),
            }],
        }
    }
}

/// 本地可用模型。全部是 GGUF（ggml / transcribe.cpp）——上一代 ONNX 模型
/// 已随 sherpa-onnx 一并移除，旧目录由 local_asr::reclaim_legacy_models 回收。
///
/// 列表顺序 = UI 展示顺序（前端不排序）。按**从快到准**排：越往下越准、越慢、
/// 下载越大，用户从上往下扫一遍就能理解这几项的关系。
pub fn get_available_models() -> Vec<ModelInfo> {
    vec![
        // ── Parakeet Unified EN 0.6B GGUF（NVIDIA，parakeet 族）──
        // 英文专用，但在英文上**同时**是本目录里最快和最准的一档：
        // 上游 WER（LibriSpeech test-clean）Q4_K_M = 1.62%，比 Qwen3-ASR 1.7B 的
        // 高精度档（1.65%）还略好，而本机实测 RTF 0.056（CPU）/ 0.023（Vulkan），
        // 比 SenseVoice 的 0.063 还快。也就是说它严格支配所有其它条目 —— 前提是
        // 只说英文。中文音频会输出**空字符串**（实测），所以它不能当通用默认。
        // 标点和大小写是模型固有行为，不挂 ITN/PNC 开关（两个都报 unsupported，
        // 见 gguf_asr.rs 的 run_options）；数字会规范化（"2026" 而不是拼读）。
        ModelInfo {
            id: "parakeet-unified-en-0.6b-gguf".into(),
            name: "Parakeet Unified EN".into(),
            description: "英文最快也最准，仅支持英文".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: PARAKEET_UNIFIED_EN_Q4.size,
            speed: 9.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 900,
            featured: false,
            languages_label: "英语".into(),
            quant: "Q4_K_M".into(),
            languages: vec!["en".into()],
            sources: PARAKEET_UNIFIED_EN_Q4.sources(),
            archive_url: None,
        },
        // ── SenseVoice Small GGUF（ggml 引擎）──
        // 标点靠 RunOptions 的 itn=on 打开（默认是 <|woitn|> 分支、无标点），
        // 实测 9s 音频纯 CPU RTF 0.063，与 sherpa 版同一量级。
        ModelInfo {
            id: "sensevoice-small-gguf".into(),
            name: "SenseVoice Small".into(),
            description: "速度极快，日常首选".into(),
            model_type: "sensevoice-gguf".into(),
            total_size_bytes: SENSEVOICE.size,
            speed: 8.5,
            accuracy: 7.0,
            recommended: true,
            memory_mb: 350,
            featured: true,
            languages_label: "中英日韩粤".into(),
            quant: "Q8_0".into(),
            languages: vec!["zh".into(), "en".into(), "ja".into(), "ko".into(), "yue".into()],
            sources: SENSEVOICE.sources(),
            archive_url: None,
        },
        // ── Nemotron 3.5 ASR Streaming 0.6B GGUF（NVIDIA，parakeet 族）──
        // 存在的意义是**语种覆盖面**：32 个 locale，含西/法/德/意/葡/荷/俄/阿/印地/
        // 土/越/乌 等 Qwen3 也没有或更慢的语种。上游标称原生标点与大小写（PnC），
        // 数字保持口语形式（训练文本就是 spoken form，不是缺陷）。
        // 准确度明显不如 parakeet：LibriSpeech test-clean Q4_K_M = 3.28% vs 1.62%，
        // 所以只说英文的话没有理由选它。实测 RTF 0.069（CPU）/ 0.032（Vulkan）。
        //
        // ⚠️ 这是本目录里第一个用**带地区 locale**（`en-US` / `zh-CN`）自报语种的
        //    模型，且只认这种形式。界面上的 `localAsr.language` 只有 auto/zh/en/ja/ko，
        //    直接透传会 `unsupported language (status 10)` —— 映射在
        //    gguf_asr.rs 的 `resolve_language`，别绕过它。
        ModelInfo {
            id: "nemotron-asr-streaming-0.6b-gguf".into(),
            name: "Nemotron 3.5 ASR".into(),
            description: "语种最全，适合多语言混用".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: NEMOTRON_STREAMING_Q4.size,
            speed: 8.0,
            accuracy: 7.5,
            recommended: false,
            memory_mb: 1050,
            featured: false,
            languages_label: "32 语种".into(),
            quant: "Q4_K_M".into(),
            languages: vec![
                "en".into(),
                "es".into(),
                "fr".into(),
                "de".into(),
                "it".into(),
                "pt".into(),
                "ru".into(),
                "zh".into(),
                "ja".into(),
                "ko".into(),
            ],
            sources: NEMOTRON_STREAMING_Q4.sources(),
            archive_url: None,
        },
        // ── Fun-ASR Nano 2512 GGUF（SenseVoice 编码器 + Qwen3 解码器）──
        // FunAudioLLM 出的，和 SenseVoice 同一个实验室，只做中/英/日三语。
        // 它在**速度和准确度上同时**优于 Qwen3-ASR 0.6B：
        //   上游 WER 1.79% vs 2.11%，参考机（Ryzen 4750U + Vulkan）10.5x 实时 vs 8.0x。
        // 本机实测 RTF 0.075（0.6B 是 0.094、1.7B Q5 是 0.153），内存 1.4 G。
        // 也就是说它拿到了接近 1.7B 的准确度（1.79 vs 1.65），但只花 1.7B 一半的时间、
        // 一半多点的内存。代价是语种少：只有 zh/en/ja，不像 Qwen3 有 30 种。
        // 注意 itn=true：标点和 SenseVoice 一样挂在 ITN 开关上，不开就没有标点。
        ModelInfo {
            id: "funasr-nano-2512-gguf".into(),
            name: "Fun-ASR Nano".into(),
            description: "又快又准，中文口述的性价比之选".into(),
            model_type: "funasr-nano-gguf".into(),
            total_size_bytes: FUNASR_NANO_Q8.size,
            speed: 7.5,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 1400,
            featured: true,
            languages_label: "中英日".into(),
            quant: "Q8_0".into(),
            languages: vec!["zh".into(), "en".into(), "ja".into()],
            sources: FUNASR_NANO_Q8.sources(),
            archive_url: None,
        },
        // ── Qwen3-ASR 0.6B GGUF（ggml 引擎，transcribe.cpp）──
        // GGUF 块量化 + ggml 推理：实测 9s 中文音频纯 CPU RTF 0.167（同一模型走
        // ONNX INT8 慢一个量级），且自带标点、输出无模板前缀。
        // 上游 WER（LibriSpeech test-clean）Q8_0 = 2.11%。
        ModelInfo {
            id: "qwen3-asr-0.6b-gguf".into(),
            name: "Qwen3-ASR 0.6B".into(),
            description: "较快，多语种的轻量之选".into(),
            model_type: "qwen3-asr-gguf".into(),
            total_size_bytes: QWEN3_06B_Q8.size,
            speed: 7.0,
            accuracy: 8.5,
            recommended: false,
            memory_mb: 1500,
            featured: false,
            languages_label: "30+ 语种".into(),
            quant: "Q8_0".into(),
            languages: vec!["zh".into(), "en".into(), "yue".into(), "ja".into(), "ko".into()],
            sources: QWEN3_06B_Q8.sources(),
            archive_url: None,
        },
        // ── Qwen3-ASR 1.7B GGUF Q4_K_M（1.7B 的轻量档）──
        // 存在的意义是让"想要 1.7B 的准确度但不想下 1.4 GB / 不想占 2 GB 内存"
        // 的人有得选。上游 WER 1.81%，仍明显好于 0.6B 的 Q8_0（2.11%），
        // 下载只比 0.6B 多 448 MB。
        // 比 Q5_K_M 小 188 MB、实测快 14~20%（少一成多显存带宽），代价是 WER 1.65 → 1.81。
        ModelInfo {
            id: "qwen3-asr-1.7b-q4-gguf".into(),
            name: "Qwen3-ASR 1.7B".into(),
            description: "很准，高精度档的提速版".into(),
            model_type: "qwen3-asr-gguf".into(),
            total_size_bytes: QWEN3_17B_Q4.size,
            speed: 4.5,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 2300,
            featured: false,
            languages_label: "30+ 语种".into(),
            quant: "Q4_K_M".into(),
            languages: vec!["zh".into(), "en".into(), "yue".into(), "ja".into(), "ko".into()],
            sources: QWEN3_17B_Q4.sources(),
            archive_url: None,
        },
        // ── Qwen3-ASR 1.7B GGUF Q5_K_M（精度上限）──
        // 上游 WER 1.65%（Q8_0 是 1.61%，但要下 2.19 GB，性价比不值）；Q5_K_M
        // 也是上游对 1.7B 的默认档。解码成本约 0.6B 的 2 倍。
        ModelInfo {
            id: "qwen3-asr-1.7b-gguf".into(),
            name: "Qwen3-ASR 1.7B 高精度".into(),
            description: "最准，但明显更慢".into(),
            model_type: "qwen3-asr-gguf".into(),
            total_size_bytes: QWEN3_17B_Q5.size,
            speed: 4.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 2600,
            featured: true,
            languages_label: "30+ 语种".into(),
            quant: "Q5_K_M".into(),
            languages: vec!["zh".into(), "en".into(), "yue".into(), "ja".into(), "ko".into()],
            sources: QWEN3_17B_Q5.sources(),
            archive_url: None,
        },
    ]
}

// GGUF 权重坐标（仓库 / 文件名 / 字节数 / sha256）。
// 这几份权重是自托管在 `cswk/sayit-asr-gguf`——从 handy-computer 那套
// **transcribe.cpp 兼容**的 GGUF 原样转存（字节完全一致，故体积 / sha256 不变），
// 目的是不再依赖第三方仓库（对方删库我们就抓瞎）。体积 / sha256 用每个文件的
// Git-LFS 指针核对过（`https://huggingface.co/<repo>/raw/main/<file>` 返回 oid+size）。
// 换量化档时改这里就够，模型条目里不再重复写体积和校验和。
// （`memory_mb` 是实测工作集，不是从这里的体积推算的——见 ModelInfo 字段注释。）
//
// ⚠️ 别随便换成"看起来同名"的其它 HF 仓库（如 FunAudioLLM 官方、mradermacher、
//    cstr 的 GGUF）：它们是给别的运行时（llama.cpp 系）转的，`general.architecture`
//    标成了 `sensevoice-small` / 其它，而我们的引擎 transcribe.cpp 只认 handy-computer
//    这套转换所用的架构标签（如 `sensevoice`）。换了会在加载时报
//    "unsupported architecture (status 5)"，下载/校验和都正常也没用。
//    要换源，只能转存"transcribe.cpp 兼容"的那一份（就像现在这样），而不是另找重转的。
//    size_bytes 会在下载前与服务器报告值核对；sha256 会在入库前校验完整文件，二者都必须准确。

const PARAKEET_UNIFIED_EN_Q4: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "parakeet-unified-en-0.6b-Q4_K_M.gguf",
    size: 477_274_496,
    sha256: "a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929",
};

const NEMOTRON_STREAMING_Q4: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "nemotron-3.5-asr-streaming-0.6b-Q4_K_M.gguf",
    size: 495_831_520,
    sha256: "41c99fa5fb6f3d35f68e79adc3e755eca2232a8d921178bd647b71194792b8fd",
};

const SENSEVOICE: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "SenseVoiceSmall-Q8_0.gguf",
    size: 252_684_608,
    sha256: "6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29",
};

const FUNASR_NANO_Q8: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Fun-ASR-Nano-2512-Q8_0.gguf",
    size: 891_270_912,
    sha256: "681caef6df15a2c0e153b40ca7fe4087fdf65751fa5e6fe605d8a75dff969e61",
};

const QWEN3_06B_Q8: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Qwen3-ASR-0.6B-Q8_0.gguf",
    size: 850_423_456,
    sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
};

const QWEN3_17B_Q4: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Qwen3-ASR-1.7B-Q4_K_M.gguf",
    size: 1_319_830_496,
    sha256: "b7afe3674f653fa84f712ed2440353c6e7cf7f93697fef76b05a26538b24844e",
};

const QWEN3_17B_Q5: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Qwen3-ASR-1.7B-Q5_K_M.gguf",
    size: 1_517_290_464,
    sha256: "034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0",
};

#[cfg(test)]
mod tests {
    use super::*;

    /// 目录的结构性不变量。跑得快、不碰网络，纯粹是防手写坐标时的低级错误。
    #[test]
    fn catalog_entries_are_internally_consistent() {
        let models = get_available_models();
        assert!(!models.is_empty());

        let mut ids = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for m in &models {
            assert!(ids.insert(m.id.clone()), "模型 id 重复: {}", m.id);
            // 展示名去掉量化档后缀后必须仍然互不相同（两个 1.7B 靠"高精度"区分），
            // 否则删除确认框、当前模型提示这些只显示 name 的地方会分不清
            assert!(names.insert(m.name.clone()), "模型展示名重复: {}", m.name);
            // id 决定权重的落盘目录，重名会让两个量化档下到同一个文件夹里
            assert!(m.id.ends_with("-gguf"), "{} 的 id 应以 -gguf 结尾", m.id);
            assert!(!m.sources.is_empty(), "{} 没有下载源", m.id);

            // 参数行三件套：加新模型时漏填其中一个，UI 上就是一截空白
            assert!(m.memory_mb > 0, "{} 缺 memory_mb（实测值，见字段注释）", m.id);
            assert!(!m.languages_label.is_empty(), "{} 缺 languages_label", m.id);
            assert!(!m.quant.is_empty(), "{} 缺 quant", m.id);
            // 展示名不该再带术语后缀（GGUF/量化档都在 quant 字段里）
            assert!(
                !m.name.contains("GGUF") && !m.name.contains("Q8") && !m.name.contains("Q4") && !m.name.contains("Q5"),
                "{} 的展示名还带着量化档术语: {}",
                m.id,
                m.name
            );

            for s in &m.sources {
                let sum: u64 = s.files.iter().map(|f| f.size_bytes).sum();
                assert_eq!(
                    sum, m.total_size_bytes,
                    "{} 的源 {} 文件体积合计 {} 与 total_size_bytes {} 不一致",
                    m.id, s.source, sum, m.total_size_bytes
                );
                for f in &s.files {
                    assert!(f.url.ends_with(&f.name), "{} 的 URL 与文件名不匹配: {}", m.id, f.url);
                    let sha = f.sha256.as_deref().unwrap_or("");
                    assert_eq!(sha.len(), 64, "{} 的 {} 缺少或非法 sha256", m.id, f.name);
                }
            }
        }

        // 恰好一个推荐模型：前端拿它当默认高亮，多个或零个都是配置错误
        assert_eq!(
            models.iter().filter(|m| m.recommended).count(),
            1,
            "推荐模型必须且只能有一个"
        );

        // 直接展示的模型恰好三个（小/中/大），其余折叠进「更多」；
        // 推荐模型必须在直接展示之列，不能藏在折叠里
        assert_eq!(
            models.iter().filter(|m| m.featured).count(),
            3,
            "featured 模型应恰好三个（小/中/大）"
        );
        assert!(
            models.iter().any(|m| m.recommended && m.featured),
            "推荐模型必须是 featured"
        );
    }

    /// 前端的下载源下拉框是拿 `models[0].sources` 生成的，然后把选中的名字用于
    /// **所有**模型的下载。所以每个模型都必须提供同一组源名，否则选了某个源之后
    /// 下载别的模型会静默回落到第一个源。
    #[test]
    fn every_model_offers_the_same_download_sources() {
        let models = get_available_models();
        let expected: Vec<&str> = models[0].sources.iter().map(|s| s.source.as_str()).collect();
        for m in &models {
            let got: Vec<&str> = m.sources.iter().map(|s| s.source.as_str()).collect();
            assert_eq!(got, expected, "{} 的下载源与第一个模型不一致", m.id);
        }
        // defaults.ts 里 localAsr.downloadSource 的默认值必须能对上其中一个
        assert!(expected.contains(&"HuggingFace Mirror"));
    }

    /// 排序契约：列表顺序就是 UI 顺序，按 speed 从高到低。写成测试是因为
    /// 以后加模型时很容易随手 append 到末尾，把这个顺序打乱。
    ///
    /// 只断言 speed 单调，**不断言 accuracy 反向单调**：Fun-ASR Nano 比
    /// Qwen3-ASR 0.6B 又快又准（严格支配它），所以"越往下越准"这个更强的
    /// 约定已经不成立了。留 0.6B 是因为它有 30 语种、Fun-ASR 只有 3 种。
    /// Parakeet Unified EN 把这一点推到了极端：它在英文上同时是最快和最准的
    /// （RTF 0.056 / WER 1.62%），排在最前却拿着最高的 accuracy。列表能这么排
    /// 是因为**语种**才是真正的取舍维度 —— 它只会英文。
    #[test]
    fn models_are_ordered_from_fast_to_slow() {
        let models = get_available_models();
        for w in models.windows(2) {
            assert!(
                w[0].speed >= w[1].speed,
                "{} 的 speed 应不低于其后的 {}",
                w[0].id,
                w[1].id
            );
        }
    }
}
