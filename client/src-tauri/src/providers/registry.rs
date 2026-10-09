// 供应商注册表 — Tauri commands 入口

use super::types::*;
use super::{
    ai_ollama, ai_openai_compat, asr_doubao, asr_doubao_stream, asr_gemini, asr_gemini_live,
    asr_groq, asr_mimo, asr_openai_chat_audio, asr_openai_compat, asr_openai_realtime,
    asr_openrouter, asr_qwen, asr_qwen_audio_stream, asr_qwen_omni,
};
use crate::error_protocol;

/// 云端 AI 校对（Tauri command）
#[tauri::command]
pub async fn cloud_polish(request: CloudPolishRequest) -> Result<AiResult, String> {
    let config = &request.ai_config;
    match config.provider.as_str() {
        // Groq 与智谱都是标准的 OpenAI 兼容 chat/completions，直接复用通用实现，
        // 不需要单独的文件（base_url 已带版本段 /v1、/v4，normalize_base_url 会原样保留）。
        //
        // ⚠️ 这个清单是白名单：前端 AI_PROVIDERS 里新增一家却漏了这里，用户会拿到
        // 「Unknown AI provider: xxx」，而那句话看不出问题在路由层。两处必须一起改。
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" | "groq" | "zhipu" => {
            ai_openai_compat::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
                request.text_context.as_ref(),
            )
            .await
        }
        "ollama" => {
            ai_ollama::polish(
                &request.text,
                config,
                request.system_prompt.as_deref(),
                request.text_context.as_ref(),
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

/// 测试 AI 连接（Tauri command）
#[tauri::command]
pub async fn test_ai_connection(config: AiProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        // 与 cloud_polish 的清单必须一致：只加一处会出现「测试通了但校对报未知供应商」
        // 或者反过来，两种都很难从错误信息看出是路由问题。
        "openai_compat" | "deepseek" | "doubao" | "qwen" | "mimo" | "groq" | "zhipu" => {
            Ok(ai_openai_compat::test_connection(&config).await)
        }
        "ollama" => Ok(ai_ollama::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

/// 云端 ASR 转写（Tauri command）
#[tauri::command]
pub async fn cloud_transcribe(request: CloudTranscribeRequest) -> Result<AsrResult, String> {
    let config = &request.asr_config;
    match config.provider.as_str() {
        "doubao" => {
            asr_doubao::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "doubao_v2" => {
            asr_doubao_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen" | "aliyun" | "qwen_realtime" => {
            asr_qwen::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Qwen-Audio-ASR-Flash 流式（3.0 / 3.1 共用，具体哪代看 extra.model）：
        // 关掉实时字幕、以及设置页的识别测试都走这条一次性路径。
        // 用的仍是同一个 duplex 协议，只是整段音频推完再收结果。
        "qwen_audio_stream" => {
            asr_qwen_audio_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen_omni" => {
            asr_qwen_omni::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "mimo" => {
            asr_mimo::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Groq 与 OpenAI 官方共用一份 /audio/transcriptions 实现，
        // 具体打哪个域名、用哪个默认模型由 asr_groq::endpoint_for 按 provider 分。
        //
        // openai_live_transcribe 也走这里：那是它**关掉实时字幕**时的路径。
        // 流式模型（gpt-live-transcribe）在文件端点上不存在，所以 endpoint_for 给它
        // 单独一档，把模型换成 gpt-transcribe —— 用 WebSocket 传一段已经录完的音频
        // 没有任何好处，一次 HTTP 更简单也更快。
        //
        // openai_compat_transcribe 是同一套协议、地址由用户填的那一档
        // （自建 whisper.cpp / faster-whisper / FunASR、聚合网关）。
        "groq_whisper" | "openai_transcribe" | "openai_live_transcribe"
        | "openai_compat_transcribe" => {
            asr_groq::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // 「OpenAI 兼容」那张卡：协议由 asr_openai_compat 探测后再分发到上下两组之一。
        // 用户在设置里手动指定过协议时它直接照办，不探测。
        "openai_compat" => {
            asr_openai_compat::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // chat/completions + input_audio 那一套。**与上面那组不是同一个协议**，
        // 别看着都叫「OpenAI 兼容」就并过去（地址、请求体、响应形状全不一样）。
        // qwen_chat_audio 地址内置为百炼（qwen3.8-omni-flash 走这条）；
        // openai_chat_audio 是 asr_openai_compat 分发下来的内部 key。
        "qwen_chat_audio" | "openai_chat_audio" | "openai_chat_audio_standard" => {
            asr_openai_chat_audio::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Gemini 同理：流式那张卡关掉字幕就走文件转写，模型换回 gemini-3.5-transcribe。
        "gemini_transcribe" | "gemini_live_transcribe" => {
            asr_gemini::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // OpenRouter 是路由层：一把 key 通往多家 STT 模型，具体哪家由模型 slug 决定。
        // 它自己的 JSON 形态（input_audio + base64），不是 multipart —— 别并进上面
        // asr_groq 那一组，理由见 asr_openrouter.rs 的文件头。
        "openrouter_transcribe" => {
            asr_openrouter::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}

/// 上面那个 `cloud_transcribe` 的 match 认识的全部 key，**从它的源码里读出来**。
///
/// 存在的理由是给 `capabilities.rs` 的测试当对照：热词能力声明必须覆盖每一个分发
/// key，漏一个就会把「我们没声明」显示成「这家不支持热词」。
///
/// ## 为什么不是一份手写清单
///
/// 原来这里是手抄的 `&["doubao", "doubao_v2", …]`。那样写的问题是**它和真实分发之间
/// 没有任何关系**：改 `cloud_transcribe` 的 match 而不动这份清单，「声明与分发一致」
/// 那条测试照样全绿 —— 它比对的是两份手写副本，测的是"我抄得一致吗"，
/// 不是"声明覆盖了真实分发吗"。新增和删除分支都漏得掉。
///
/// 所以改成扫源码。Rust 没有反射，但 `include_str!` 拿得到本文件的内容，而 match 臂
/// 的形状在 rustfmt 下是稳定的（臂头 trim 后以 `"` 开头，续行以 `|` 开头）。
///
/// ## 它坏掉的时候不会静默
///
/// 扫描器的任何失效都会让 key 集合变得不对（多抓、少抓、空集），而调用方做的是
/// **集合相等**断言 —— 一律当场红。这是选它而不是选"宏生成 match"的原因：
/// 后者要把这段带大量注释的 match 塞进宏，可读性代价远大于收益。
#[cfg(test)]
pub fn dispatch_keys_for_test() -> Vec<&'static str> {
    let keys = match_arm_keys(fn_body(include_str!("registry.rs"), CLOUD_TRANSCRIBE_SIGNATURE));
    // 扫描器自己活着的信号。真实 match 有十几条臂，抓到个位数只可能是扫描逻辑坏了
    // （比如 rustfmt 换了臂头缩进风格），这时要修的是扫描器，不是声明清单。
    assert!(
        keys.len() >= 10,
        "从 cloud_transcribe 源码里只抓到 {} 个分发 key，扫描逻辑多半已经失效：{:?}",
        keys.len(),
        keys,
    );
    keys
}

/// 刻意用 `concat!` 拼出来而不是写成一整个字面量：`fn_body` 找的是**第一次**出现，
/// 而这行常量定义本身也在同一个文件里。写全了就等于在源码里埋下第二个匹配点，
/// 哪天这行挪到 `cloud_transcribe` 上面去，截出来的就是这行所在的位置。
#[cfg(test)]
const CLOUD_TRANSCRIBE_SIGNATURE: &str = concat!("pub async fn ", "cloud_transcribe");

/// 截出某个顶层函数的源码片段。
///
/// 结束判据是**顶格的 `}`**（`"\n}"`），不是花括号配对计数：顶层 `fn` 的收尾花括号
/// 在第 0 列，而函数体内部的每一个 `}` 都有缩进。计数法会被字符串字面量里的花括号
/// （这个函数体里就有 `format!("… \"{}\" …")`）带偏，判据反而更脆。
#[cfg(test)]
fn fn_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("在源码里找不到 `{signature}`，签名被改过？"));
    let rest = &source[start..];
    let end = rest.find("\n}").map(|at| at + 1).unwrap_or(rest.len());
    &rest[..end]
}

/// 从一段源码里提取 match 臂上的字符串字面量 key。
///
/// 只认「trim 后以 `"` 或 `|` 开头、直到出现 `=>`」的行序列，所以：
///   · `"qwen" | "aliyun" | "qwen_realtime" => {` —— 一行抓三个；
///   · 臂头换行写的（`"groq_whisper" | …` 换行后 `| "openai_compat_transcribe" => {`）
///     靠累积缓冲抓全；
///   · `other => Err(…)` 那条兜底臂不以引号开头，不会被抓（它不是一个分发 key）；
///   · 臂体里恰好顶行写着字符串的（`"connect_failed",`）会进缓冲，但它后面那行不以
///     引号或 `|` 开头，缓冲随即清空，不会被误算成 key。
#[cfg(test)]
fn match_arm_keys<'a>(source: &'a str) -> Vec<&'a str> {
    let mut keys: Vec<&'a str> = Vec::new();
    // 攒的是行切片而不是拼接 String：这样提取出来的 key 天然借着原文的生命周期，
    // 不需要为了还原它再回原文查一次。
    let mut head: Vec<&'a str> = Vec::new();
    for raw in source.lines() {
        // 剥行注释：注释里提到别家 provider 名是常事（这个 match 的注释里就有），
        // 不剥会误抓。代价是函数体里不能有含 `//` 的字符串字面量（目前没有），
        // 真有的话结果是少抓一个 key —— 调用方的集合相等断言会红，不会静默。
        let line = match raw.find("//") {
            Some(at) => &raw[..at],
            None => raw,
        };
        let line = line.trim();
        // 空行（含被剥空的纯注释行）既不累积也不打断：臂头中间插一行注释仍能抓全。
        if line.is_empty() {
            continue;
        }
        if !(line.starts_with('"') || line.starts_with('|')) {
            head.clear();
            continue;
        }
        // `=>` 之前的部分才是臂头，之后是臂体（`"key" => Ok(…)` 那种单行臂）。
        let (fragment, complete) = match line.find("=>") {
            Some(at) => (&line[..at], true),
            None => (line, false),
        };
        head.push(fragment);
        if complete {
            for part in head.drain(..) {
                keys.extend(quoted_literals(part));
            }
        }
    }
    keys
}

/// 取出一段文本里所有双引号包住的内容。
#[cfg(test)]
fn quoted_literals<'a>(text: &'a str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        rest = &rest[open + 1..];
        let Some(close) = rest.find('"') else { break };
        if close > 0 {
            out.push(&rest[..close]);
        }
        rest = &rest[close + 1..];
    }
    out
}

/// 测试 ASR 连接（Tauri command）
#[tauri::command]
pub async fn test_asr_connection(config: AsrProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "doubao" => Ok(asr_doubao::test_connection(&config).await),
        "doubao_v2" => Ok(asr_doubao_stream::test_connection(&config).await),
        "qwen" | "aliyun" | "qwen_realtime" => Ok(asr_qwen::test_connection(&config).await),
        "qwen_audio_stream" => Ok(asr_qwen_audio_stream::test_connection(&config).await),
        "qwen_omni" => Ok(asr_qwen_omni::test_connection(&config).await),
        "mimo" => Ok(asr_mimo::test_connection(&config).await),
        "groq_whisper" | "openai_transcribe" | "openai_compat_transcribe" => {
            Ok(asr_groq::test_connection(&config).await)
        }
        "qwen_chat_audio" | "openai_chat_audio" | "openai_chat_audio_standard" => {
            Ok(asr_openai_chat_audio::test_connection(&config).await)
        }
        "openai_compat" => Ok(asr_openai_compat::test_connection(&config).await),
        "gemini_transcribe" => Ok(asr_gemini::test_connection(&config).await),
        "openrouter_transcribe" => Ok(asr_openrouter::test_connection(&config).await),
        // 流式那两家的连通性测试打的是**流式那条连接**（而不是它们回落用的 HTTP）：
        // 这个命令要回答的是"这份配置能不能用"，而它们平时用的就是 WebSocket。
        // HTTP 那条路由设置页的识别测试覆盖（见 cloud_transcribe 的分支）。
        "openai_live_transcribe" => Ok(asr_openai_realtime::test_connection(&config).await),
        "gemini_live_transcribe" => Ok(asr_gemini_live::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一段人造的分发函数，形状覆盖真实 match 里出现过的每一种臂。
    ///
    /// 用人造源码而不是真实源码来验扫描器本身：真实源码会变，而"删一条臂就该少一个
    /// key"这件事必须在一个可控的输入上断言，否则测试会跟着业务改动一起漂。
    const FAKE_DISPATCH: &str = r#"pub async fn fake_dispatch(x: &str) -> Result<(), String> {
    match x {
        "alpha" => Ok(()),
        // 注释里提到 "ghost" 是常事，不能被当成分发 key
        "beta" | "gamma" => Ok(()),
        "delta"
        | "epsilon" => Ok(()),
        other => Err(encode(
            "connect_failed",
            format!("no {}", other),
        )),
    }
}
"#;

    fn fake_keys(source: &str) -> Vec<&str> {
        match_arm_keys(fn_body(source, "pub async fn fake_dispatch"))
    }

    /// 扫描器要认得真实 match 里出现过的全部臂形状，并且只认臂头。
    #[test]
    fn the_scanner_handles_every_arm_shape_and_nothing_else() {
        assert_eq!(
            fake_keys(FAKE_DISPATCH),
            vec!["alpha", "beta", "gamma", "delta", "epsilon"],
        );
    }

    /// 注释里的 provider 名不能被抓走。
    ///
    /// 这不是假想：`cloud_transcribe` 的注释里就写着别家的 key（"openai_compat_transcribe
    /// 是同一套协议…"）。不剥注释的话对照集合会凭空多出几个，而多出来的那几个
    /// 会让「声明清单」被迫去声明不存在的分发分支。
    #[test]
    fn the_scanner_ignores_provider_names_inside_comments() {
        assert!(!fake_keys(FAKE_DISPATCH).contains(&"ghost"));
    }

    /// 兜底臂和臂体里的字符串都不是分发 key。
    #[test]
    fn the_scanner_skips_the_fallback_arm_and_arm_bodies() {
        // `other => Err(…)` 不是一个 provider
        assert!(!fake_keys(FAKE_DISPATCH).contains(&"other"));
        // `"connect_failed"` 顶行写在臂体里，形状上很像臂头
        assert!(!fake_keys(FAKE_DISPATCH).contains(&"connect_failed"));
    }

    /// **删掉一条分发分支，对照集合必须立刻少掉那些 key。**
    ///
    /// 这是审核指出的那个洞：原来的对照是另一份手写清单，删掉真实分支而保留清单，
    /// 「声明与分发一致」那条测试照样绿。现在对照来自源码，删除是可见的。
    #[test]
    fn removing_a_dispatch_branch_shrinks_the_reference_set() {
        let without = FAKE_DISPATCH.replace("        \"beta\" | \"gamma\" => Ok(()),\n", "");
        assert_ne!(without, FAKE_DISPATCH, "替换没生效，测试自己失效了");

        let keys = fake_keys(&without);
        assert!(!keys.contains(&"beta"));
        assert!(!keys.contains(&"gamma"));
        assert_eq!(keys, vec!["alpha", "delta", "epsilon"]);
    }

    /// **新增一条分发分支，对照集合必须立刻多出那个 key。**
    ///
    /// 配合 `capabilities.rs` 的集合相等断言，效果是：加一家 provider 只改
    /// `cloud_transcribe` 而忘了声明热词行为，测试当场红。
    #[test]
    fn adding_a_dispatch_branch_grows_the_reference_set() {
        let with = FAKE_DISPATCH.replace(
            "        \"alpha\" => Ok(()),\n",
            "        \"alpha\" => Ok(()),\n        \"zeta\" => Ok(()),\n",
        );
        assert_ne!(with, FAKE_DISPATCH, "替换没生效，测试自己失效了");
        assert!(fake_keys(&with).contains(&"zeta"));
    }

    /// 真实源码上的行为锚点。
    ///
    /// 刻意**不写成"等于某份清单"** —— 那就又变成手抄副本了。这里只钉三件
    /// 扫描器容易做错的事：跨行臂头要抓全、单 key 臂要抓到、臂体里的字符串不能混进来。
    #[test]
    fn the_real_dispatch_table_is_read_from_source() {
        let keys = dispatch_keys_for_test();
        // 跨行臂头：这个 key 写在 `| "openai_compat_transcribe" => {` 那行的续行上
        assert!(
            keys.contains(&"openai_compat_transcribe"),
            "跨行写的臂头没抓全：{keys:?}",
        );
        // 单 key 臂
        assert!(keys.contains(&"openai_compat"), "{keys:?}");
        // 臂体里的字符串不是分发 key
        assert!(!keys.contains(&"connect_failed"), "{keys:?}");
        // 同一个 key 不该被抓两次（集合相等断言会因为重复项失败，先在这里定性）
        let mut sorted = keys.clone();
        sorted.sort_unstable();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len(), "抓到了重复的分发 key：{keys:?}");
    }
}
