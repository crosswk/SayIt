// DeepSeek 语音识别（2026-11-13 随「全家桶应用 API」一起开放）。
//
// POST https://api.deepseek.com/v1/tools/asr，multipart 只有一个 `file` 字段，Bearer 鉴权，
// 和 DeepSeek 文本接口是同一把 API Key。响应 `{"request_id","text","duration_ms"}`。
//
// 实测（dev-scripts/probe_deepseek_asr.py 打真实接口）：
//   · 16 kHz 单声道 16-bit WAV 直接收；中文自带全角标点，英文的数字、人名都对；
//   · 3 秒音频约 0.7 秒返回，110 秒约 3.1 秒：固定开销大，随时长增长很慢；
//   · 静音、底噪返回空串，不会凭空编字；
//   · 多带 model / prompt / language 字段它照收不报错，但这里一个都不发：
//     文档里没有这些字段，收下不等于生效。
//
// 协议本身决定了这张卡的几个「不」：
//   · **没有热词字段**，也没有 prompt（capabilities.rs 声明为 ProtocolHasNoSlot）；
//   · **没有语种参数**，21 种语言自动识别，设置里选的识别语言对它不起作用；
//   · **不支持流式**，只有录完一次性这一条路；
//   · **单次最长 120 秒**、8 MiB。125 秒实测 400：
//     `Invalid audio: audio duration 125000 ms exceeds 120 s`。
//     SayIt 的录音上限是 5 分钟，所以超长的要切段，见 `plan_long_recording`。
//
// 为什么不并进 asr_groq.rs：那份是 OpenAI 的 `/audio/transcriptions`，靠 model、prompt
// （中文标点全靠它）、language 三个字段干活，地址是「base + /audio/transcriptions」。
// DeepSeek 一个都没有（`/v1/audio/transcriptions` 实测 404），而这里真正有内容的部分
// ——长录音切段——那边也没有。并进去等于给 Endpoint 再加三个开关，只为共用二十行 multipart。

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use crate::models::local_vad;
use futures_util::{StreamExt, TryStreamExt};
use std::ops::Range;
use std::time::{Duration, Instant};

const SCOPE: &str = "deepseek/asr";
const ENDPOINT: &str = "https://api.deepseek.com/v1/tools/asr";

/// 不超过这个长度就整段发一次。接口上限是 120 秒，留 2 秒给「我们算的时长」和
/// 「它从 WAV 头里算的时长」之间的出入。
const SINGLE_REQUEST_MAX_SEC: usize = 118;
/// 切段时每段的长短。上限离 120 秒再留 10 秒；下限决定挑停顿的窗口有多宽，
/// 60~110 秒这 50 秒里几乎总能找到一个句间停顿。5 分钟的录音切成 3~5 段。
const CHUNK_MIN_SEC: usize = 60;
const CHUNK_MAX_SEC: usize = 110;
/// 同时在飞的请求数。DeepSeek 账号级上限是 50 个并发；四段一起发，
/// 总耗时就接近单段耗时（110 秒一段实测约 3 秒）。
const MAX_PARALLEL: usize = 4;
const TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 单次请求的超时，按这一段的音频长度给。
///
/// 正常情况下十几秒的音频 1.5 秒左右、110 秒的一段 3 秒左右回来。10 秒起步、每秒音频
/// 再加 0.1 秒，比正常耗时宽五倍以上；超过了就放弃这次、重发一遍（见 `Failure::Transport`）。
/// 不能照 asr_groq 一律 60 秒：前端给短录音的处理时限只有 30 秒出头
/// （recorder/helpers.ts 的 computeProcessingTimeoutMs），等满 60 秒再重发，
/// 结果回来时前端早就放弃了。
fn request_timeout(audio_sec: f64) -> Duration {
    Duration::from_millis(10_000 + (audio_sec.max(0.0) * 100.0) as u64)
}

/// 一次请求失败的两种性质，决定要不要重发。
enum Failure {
    /// 没拿到完整响应：连接被重置、TLS 中断、超时。ASR 请求是幂等的，重发一次。
    ///
    /// 实测（2026-11-14，接口开放第二天）：同一段 12 秒的录音两次在 15~19 秒后被断开连接，
    /// 第三次 1.4 秒正常返回；原样、重建 WAV 头、改增益、切半都正常 —— 和音频内容无关。
    /// 切段之后一次录音要发好几个请求，碰上一次的概率跟着翻倍，所以这里兜一下。
    Transport(String),
    /// 服务端明确拒绝（密钥、余额、参数），或者响应形状不对。重发结果一样，直接报。
    Rejected(String),
}

impl Failure {
    fn into_message(self) -> String {
        match self {
            Failure::Transport(message) | Failure::Rejected(message) => message,
        }
    }
}

/// 把 16-bit 单声道 PCM 封成 WAV。接口按文件内容判断格式，裸 PCM 它认不出来。
///
/// 和 asr_groq.rs / asr_mimo.rs 各留一份是那两个文件定下的惯例：抽成公共函数后，
/// 任何一家改采样格式都会牵动另外几家，而它们本来毫无关系。
fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_len = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// 这段录音要不要切。按采样数判断，不按字节：字节数和采样率一起才说得清时长。
fn needs_split(total_samples: usize, sample_rate: usize) -> bool {
    total_samples > SINGLE_REQUEST_MAX_SEC * sample_rate
}

/// 超长录音的切法：先用细粒度 VAD 找停顿，再在每段的 60~110 秒窗口里挑最长的停顿切。
///
/// 返回的区间是**采样下标**，首尾相接覆盖整段录音（切口只落在停顿上，不丢音频，
/// 理由见 `local_vad::plan_contiguous_chunks`）。第二个值说明切口是怎么找的，进日志。
///
/// VAD 失败不算失败：退成「每一刀都找最安静的 100 ms」照样能切。这里的 VAD 只决定
/// 切在哪，不决定发不发 —— 和本地识别那边「VAD 失败就不识别」的硬约束不是一回事，
/// 那边防的是生成式模型对静音编字，而这家对静音返回的是空串（实测）。
fn plan_long_recording(pcm: &[u8], sample_rate: usize) -> (Vec<Range<usize>>, &'static str) {
    let samples: Vec<f32> = pcm
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();
    let (segments, how) = match local_vad::detect_speech_for_cuts(&samples, sample_rate) {
        Ok(segments) => (segments, "pause"),
        Err(e) => {
            diag::log(
                SCOPE,
                "vad_failed",
                &format!("falling back to quietest-point cuts: {}", diag::truncate(&e, 200)),
            );
            (Vec::new(), "quietest")
        }
    };
    let chunks = local_vad::plan_contiguous_chunks(
        &samples,
        sample_rate,
        &segments,
        CHUNK_MIN_SEC * sample_rate,
        CHUNK_MAX_SEC * sample_rate,
    );
    (chunks, how)
}

/// 把各段的识别结果按时间顺序接起来。
///
/// 中文、日文不用空格分词，接口两边只要有一边是汉字、假名或全角标点就直接接上；
/// 两边都不是（英文、数字、韩文）才补一个空格，免得前一段的最后一个词和后一段的
/// 第一个词粘在一起。
///
/// 不用 gguf_asr::append_segment_text：那份按「前一段有没有以标点收尾」决定补不补空格，
/// 切口落在一句中文的中间时会在两个汉字之间插一个空格。
fn join_chunk_texts(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts {
        let piece = part.trim();
        if piece.is_empty() {
            continue;
        }
        if let (Some(prev), Some(next)) = (out.chars().last(), piece.chars().next()) {
            if !is_unspaced_script(prev) && !is_unspaced_script(next) {
                out.push(' ');
            }
        }
        out.push_str(piece);
    }
    out
}

/// 不用空格分词的文字：汉字、假名、CJK 标点和全角符号。
fn is_unspaced_script(c: char) -> bool {
    matches!(
        c as u32,
        0x3000..=0x303F     // CJK 标点：。、「」
            | 0x3040..=0x30FF // 平假名、片假名
            | 0x3400..=0x4DBF // 汉字扩展 A
            | 0x4E00..=0x9FFF // 基本汉字
            | 0xF900..=0xFAFF // 兼容汉字
            | 0xFF00..=0xFFEF // 全角形式：，！？
    )
}

/// 「第几段」的说明，只在切了段时才有字，免得单段录音的报错里多出一句「1/1」。
fn part_label(index: usize, count: usize) -> String {
    if count > 1 {
        format!(" (part {}/{})", index + 1, count)
    } else {
        String::new()
    }
}

/// 发一段音频，返回这一段的识别文本。
///
/// 200 但响应里没有 `text` 字段算失败，不当成「没说话」：协议没跑完却走成功路径，
/// 前端只会显示「未检测到有效声音」，用户会去查麦克风（pitfalls #15）。
async fn send_wav(
    api_key: &str,
    wav: &[u8],
    label: &str,
    scope: &str,
    timeout: Duration,
) -> Result<String, Failure> {
    let part = reqwest::multipart::Part::bytes(wav.to_vec())
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| {
            Failure::Rejected(diag::fail(
                scope,
                "build_form",
                format!("Failed to build the audio part: {}", e),
            ))
        })?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let started = Instant::now();
    let resp = super::http_client::shared()
        .post(ENDPOINT)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            Failure::Transport(diag::fail(scope, "http_send", format!("Request failed{}: {}", label, e)))
        })?;

    let status = resp.status();
    let summary = diag::http_summary(status, resp.headers());
    let body = resp.text().await.map_err(|e| {
        Failure::Transport(diag::fail(
            scope,
            "read_body",
            format!("Failed to read response{}: {}", label, e),
        ))
    })?;
    if !status.is_success() {
        return Err(Failure::Rejected(diag::fail(
            scope,
            "http_status",
            format!(
                "Transcription error {}{} [{}]: {}",
                status,
                label,
                summary,
                diag::truncate(&body, 300)
            ),
        )));
    }

    let data: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        Failure::Rejected(diag::fail(
            scope,
            "parse_json",
            format!(
                "Failed to parse response{}: {} [{}] response excerpt: {}",
                label,
                e,
                summary,
                diag::truncate(&body, 200)
            ),
        ))
    })?;
    let Some(text) = data.get("text").and_then(|t| t.as_str()) else {
        return Err(Failure::Rejected(diag::fail(
            scope,
            "parse_json",
            format!(
                "Response has no text field{} [{}] {}",
                label,
                summary,
                diag::describe_json(&body)
            ),
        )));
    };
    let text = text.trim().to_string();
    if !label.is_empty() {
        // 切了段才逐段记：排查「长录音哪一段丢了字」时，这一行说明每段回来多少字、
        // 服务端按多长计费（duration_ms），而不记任何内容。
        diag::log(
            scope,
            "part",
            &format!(
                "{} elapsed={}ms chars={} duration_ms={} [{}]",
                label.trim(),
                started.elapsed().as_millis(),
                text.chars().count(),
                data.get("duration_ms")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                summary
            ),
        );
    }
    Ok(text)
}

/// 发一段音频；连接层面的失败重发一次（理由见 `Failure::Transport`）。
/// 第一次失败已经由 send_wav 记进日志，这里再记一行「重发了」，排查时两行连着看。
async fn send_with_retry(
    api_key: &str,
    wav: &[u8],
    label: &str,
    timeout: Duration,
) -> Result<String, String> {
    match send_wav(api_key, wav, label, SCOPE, timeout).await {
        Ok(text) => Ok(text),
        Err(Failure::Transport(_)) => {
            diag::log(SCOPE, "retry", &format!("transport failure{}, sending once more", label));
            send_wav(api_key, wav, label, SCOPE, timeout)
                .await
                .map_err(Failure::into_message)
        }
        Err(rejected) => Err(rejected.into_message()),
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    // 这家协议没有放热词的地方。留这行是为了日志里查得到「配了热词但没发」，
    // 否则用户只会觉得识别得不太准（同 asr_groq.rs 的 hotwords_ignored）。
    if !hotwords.is_empty() {
        diag::log(
            SCOPE,
            "hotwords_ignored",
            &format!("count={} reason=protocol_has_no_slot", hotwords.len()),
        );
    }
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|e| diag::fail(SCOPE, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;
    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult { text: String::new(), elapsed_ms: 0 });
    }

    let rate = sample_rate.max(1);
    let rate_usize = rate as usize;
    let total_samples = pcm.len() / 2;
    let audio_sec = total_samples as f64 / rate as f64;
    let start = Instant::now();

    // VAD 是纯 CPU 活，5 分钟录音也要跑一会儿，别占着异步运行时的线程
    let (pcm, chunks, how) = if needs_split(total_samples, rate_usize) {
        tokio::task::spawn_blocking(move || {
            let (chunks, how) = plan_long_recording(&pcm, rate_usize);
            (pcm, chunks, how)
        })
        .await
        .map_err(|e| diag::fail(SCOPE, "plan", format!("Failed to split the recording: {}", e)))?
    } else {
        (pcm, vec![0..total_samples], "single")
    };

    // 切成几段、切在哪，一行写清。长录音丢字或报错时先看这一行。
    let cuts: Vec<String> = chunks
        .iter()
        .map(|c| format!("{:.1}-{:.1}", c.start as f64 / rate as f64, c.end as f64 / rate as f64))
        .collect();
    diag::log(
        SCOPE,
        "start",
        &format!(
            "audio_sec={:.1} rate={} requests={} split={} plan_ms={} cuts=[{}]",
            audio_sec,
            rate,
            chunks.len(),
            how,
            start.elapsed().as_millis(),
            cuts.join(",")
        ),
    );

    // 并发发、按顺序收（buffered 保序）。任何一段失败整次失败：拼一份缺了一段的
    // 文本插进用户的文档，比报错糟得多 —— 他不会发现中间少了一分钟的话。
    let count = chunks.len();
    let api_key = config.api_key.as_str();
    let pcm_ref = &pcm;
    let parts: Vec<String> = futures_util::stream::iter(chunks.iter().cloned().enumerate())
        .map(|(index, range)| {
            let wav = pcm_to_wav(&pcm_ref[range.start * 2..range.end * 2], rate);
            let label = part_label(index, count);
            let timeout = request_timeout((range.end - range.start) as f64 / rate as f64);
            async move { send_with_retry(api_key, &wav, &label, timeout).await }
        })
        .buffered(MAX_PARALLEL)
        .try_collect()
        .await?;

    let text = join_chunk_texts(&parts);
    let elapsed_ms = start.elapsed().as_millis() as u64;
    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!(
                "Response contained no transcript audio_sec={:.1} requests={} elapsed={}ms",
                audio_sec, count, elapsed_ms
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    // 0.5 秒静音：实测返回 200 + 空串，足以验证密钥、余额和网络，不产生内容。
    let wav = pcm_to_wav(&[0u8; 16000], 16000);
    let scope = format!("{}-test", SCOPE);
    let start = Instant::now();
    // 测试连接不重发：用户点按钮要的是此刻通不通的准话
    let result = send_wav(&config.api_key, &wav, "", &scope, TEST_TIMEOUT)
        .await
        .map_err(Failure::into_message);
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(_) => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: String::new(),
        },
        Err(message) => TestResult {
            ok: false,
            message,
            elapsed_ms,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 16_000;

    #[test]
    fn recordings_within_the_limit_are_sent_whole() {
        assert!(!needs_split(SR * 3, SR));
        assert!(!needs_split(SR * SINGLE_REQUEST_MAX_SEC, SR));
        assert!(needs_split(SR * SINGLE_REQUEST_MAX_SEC + 1, SR));
        // 5 分钟上限的录音一定要切
        assert!(needs_split(SR * 300, SR));
    }

    /// 切段的上限必须留在接口的 120 秒以内，否则切出来的段照样被 400 拒掉。
    #[test]
    fn chunk_limits_stay_under_the_api_limit() {
        assert!(SINGLE_REQUEST_MAX_SEC < 120);
        assert!(CHUNK_MAX_SEC < SINGLE_REQUEST_MAX_SEC);
        assert!(CHUNK_MIN_SEC < CHUNK_MAX_SEC);
    }

    /// 一段 5 分钟的录音走完整条切段路径：每段不超长、首尾相接。
    /// 合成的持续音没有停顿，VAD 给不出切口，走的是最安静点那条退路。
    #[test]
    fn a_five_minute_recording_is_planned_into_valid_requests() {
        let pcm: Vec<u8> = (0..SR * 300)
            .flat_map(|i| (((i % 400) as i16 - 200) * 40).to_le_bytes())
            .collect();
        let (chunks, _) = plan_long_recording(&pcm, SR);
        assert!(chunks.len() >= 3, "{chunks:?}");
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, SR * 300);
        for pair in chunks.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "{chunks:?}");
        }
        for c in &chunks {
            assert!(c.end - c.start <= CHUNK_MAX_SEC * SR, "{c:?}");
        }
    }

    #[test]
    fn chinese_parts_are_joined_without_spaces() {
        let parts = vec!["今天下午开会。".to_string(), "记得带电脑。".to_string()];
        assert_eq!(join_chunk_texts(&parts), "今天下午开会。记得带电脑。");
        // 切口落在一句话中间、前一段没有标点收尾，也不能在两个汉字之间插空格
        let parts = vec!["我们明天".to_string(), "再讨论".to_string()];
        assert_eq!(join_chunk_texts(&parts), "我们明天再讨论");
    }

    #[test]
    fn latin_parts_get_a_space_between_them() {
        let parts = vec!["Hello world.".to_string(), "Next sentence.".to_string()];
        assert_eq!(join_chunk_texts(&parts), "Hello world. Next sentence.");
        let parts = vec!["the quick".to_string(), "brown fox".to_string()];
        assert_eq!(join_chunk_texts(&parts), "the quick brown fox");
        // 韩文按空格分词
        let parts = vec!["안녕하세요.".to_string(), "반갑습니다.".to_string()];
        assert_eq!(join_chunk_texts(&parts), "안녕하세요. 반갑습니다.");
    }

    #[test]
    fn mixed_and_empty_parts_join_cleanly() {
        let parts = vec!["配置 SayIt".to_string(), "很简单".to_string()];
        assert_eq!(join_chunk_texts(&parts), "配置 SayIt很简单");
        let parts = vec!["".to_string(), "  ".to_string(), " 只有一段 ".to_string()];
        assert_eq!(join_chunk_texts(&parts), "只有一段");
    }

    /// 超时要短到「超时一次再重发」还落在前端的处理时限里（短录音约 30 秒），
    /// 又要比正常耗时宽得多（110 秒的一段实测约 3 秒）。
    #[test]
    fn request_timeout_leaves_room_for_one_retry() {
        assert_eq!(request_timeout(5.0), Duration::from_millis(10_500));
        assert_eq!(request_timeout(CHUNK_MAX_SEC as f64), Duration::from_millis(21_000));
        assert!(request_timeout(5.0) + Duration::from_secs(3) < Duration::from_secs(30));
        assert!(request_timeout(CHUNK_MAX_SEC as f64) > Duration::from_secs(15));
    }

    #[test]
    fn part_labels_only_appear_when_split() {
        assert_eq!(part_label(0, 1), "");
        assert_eq!(part_label(1, 3), " (part 2/3)");
    }

    #[test]
    fn wav_header_matches_the_data() {
        let pcm = vec![0u8; 320];
        let wav = pcm_to_wav(&pcm, 16000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 16000);
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]) as usize, pcm.len());
    }

    /// 打真实接口的手动测试，默认不跑（要密钥、要网络、会计费）。
    ///
    /// `SAYIT_DEEPSEEK_KEY` 给密钥，`SAYIT_DEEPSEEK_WAV` 给一个或几个 16 kHz 单声道 WAV
    /// （分号分隔），然后：
    /// `cargo test --bins deepseek_live -- --ignored --nocapture`
    /// 每个文件打印一行：路径、耗时、识别文本。长录音会走切段，日志里有 `cuts=[…]`。
    #[tokio::test]
    #[ignore]
    async fn deepseek_live_transcribe_from_env() {
        use base64::Engine;
        let key = std::env::var("SAYIT_DEEPSEEK_KEY").expect("set SAYIT_DEEPSEEK_KEY");
        let paths = std::env::var("SAYIT_DEEPSEEK_WAV").expect("set SAYIT_DEEPSEEK_WAV");
        let config = AsrProviderConfig {
            provider: "deepseek_asr".to_string(),
            api_key: key,
            app_id: String::new(),
            extra: serde_json::Value::Null,
        };
        for path in paths.split(';').map(str::trim).filter(|p| !p.is_empty()) {
            let bytes = std::fs::read(path).expect("read wav");
            let data_at = bytes
                .windows(4)
                .position(|w| w == b"data")
                .expect("no data chunk")
                + 8;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes[data_at..]);
            match transcribe(&b64, 16000, &config, &[]).await {
                Ok(r) => println!("LIVE\t{}\t{}ms\t{}", path, r.elapsed_ms, r.text),
                Err(e) => println!("LIVE\t{}\tERROR\t{}", path, e),
            }
        }
    }
}
