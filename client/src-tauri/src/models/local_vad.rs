//! 本地 ASR 前置语音检测。
//!
//! Qwen3-ASR 这类生成式模型遇到纯静音或环境底噪时，可能生成并不存在的文字。
//! 这里参考 Handy 的做法，用独立的 Silero VAD 在推理前确认音频里确实有人声。
//! 与 Handy 不同的是，我们只用 VAD 确定首尾边界，保留句子中间的停顿；历史记录
//! 保存的也仍然是未经裁剪的原始录音。

use std::ops::Range;

use silero_vad_crs::{
    get_timestamps_from_probs_with_config, SileroVad, TimestampConfig,
};

/// 与 Handy 一致使用较宽松的 0.3，优先避免漏掉轻声说话。
const SPEECH_THRESHOLD: f32 = 0.3;
/// 过滤总时长不足约 60ms 的候选语音段，抑制短促点击声和提示音。
/// 这与 Handy 的“连续两帧起声”目标相同，但 Silero 时间戳算法带滞回，行为并非逐帧等价。
const MIN_SPEECH_MS: usize = 60;
/// 至少持续 450ms 的非语音才切分语音段，减少短暂停顿导致的误切分。
const MIN_SILENCE_MS: usize = 450;
/// 起止各留约 450ms，避免切掉辅音、轻声开头和句尾。
const SPEECH_PAD_MS: usize = 450;

/// 给云端长录音找切口时用的停顿与留白（见 `detect_speech_for_cuts`）。
const CUT_MIN_SILENCE_MS: usize = 250;
const CUT_SPEECH_PAD_MS: usize = 100;

/// 返回每一段人声（已含首尾留白），按时间排序、互不重叠。
///
/// 空列表明确表示没有检测到人声，调用方应跳过 ASR；`Err` 表示无法可靠判断是否
/// 有人声，为避免生成式模型对静音产生幻觉，调用方也必须停止本次 ASR。
/// 交给模型前再经 `plan_chunks` 拼块：短录音就是首段开头到末段结尾一整块。
pub fn detect_speech_segments(
    samples: &[f32],
    sample_rate: usize,
) -> Result<Vec<Range<usize>>, String> {
    let ranges = run_vad(samples, sample_rate, MIN_SILENCE_MS, SPEECH_PAD_MS)?;

    if let (Some(first), Some(last)) = (ranges.first(), ranges.last()) {
        log::debug!(
            "Silero VAD: {:.2}s -> {:.2}s, speech_segments={}",
            samples.len() as f64 / sample_rate as f64,
            (last.end - first.start) as f64 / sample_rate as f64,
            ranges.len(),
        );
    }
    Ok(ranges)
}

/// 同一个模型、同一个阈值，但停顿和留白放细，**只用来给长录音挑切口**。
///
/// `detect_speech_segments` 要回答的是「有没有人声、首尾在哪」，留白放得宽（0.45 s）：
/// 一秒以内的停顿两边各加 0.45 s 就并成一段了。而口述里句与句之间多半就停零点几秒，
/// 用那套参数几乎看不到停顿，切口只能退到「最安静的 100 ms」。
/// 这里 0.25 s 以上的停顿就分段、两边各留 0.1 s，句间停顿基本都能露出来。
///
/// 结果不用来判断有没有人声，所以没有那边「空列表 = 跳过识别」的含义。
pub fn detect_speech_for_cuts(
    samples: &[f32],
    sample_rate: usize,
) -> Result<Vec<Range<usize>>, String> {
    run_vad(samples, sample_rate, CUT_MIN_SILENCE_MS, CUT_SPEECH_PAD_MS)
}

fn run_vad(
    samples: &[f32],
    sample_rate: usize,
    min_silence_ms: usize,
    speech_pad_ms: usize,
) -> Result<Vec<Range<usize>>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut vad = SileroVad::with_sample_rate(sample_rate)
        .map_err(|e| format!("Failed to create Silero VAD: {e}"))?;
    let window_size_samples = vad.source_window_samples();
    let probabilities = vad
        .forward_audio(samples)
        .map_err(|e| format!("Silero VAD inference failed: {e}"))?;

    let segments = get_timestamps_from_probs_with_config(
        &probabilities,
        samples.len(),
        TimestampConfig {
            sampling_rate: sample_rate,
            threshold: SPEECH_THRESHOLD,
            min_speech_duration_ms: MIN_SPEECH_MS,
            min_silence_duration_ms: min_silence_ms,
            speech_pad_ms,
            window_size_samples,
            ..Default::default()
        },
    );

    Ok(normalize_segments(
        segments.iter().map(|s| s.start..s.end),
        samples.len(),
    ))
}

/// 截到音频长度以内、丢掉空段、按起点排序，并把重叠或首尾相接的段合并。
/// 加了留白之后相邻两段可能互相覆盖，后面切块要求段与段之间不重叠。
fn normalize_segments(
    segments: impl IntoIterator<Item = Range<usize>>,
    len: usize,
) -> Vec<Range<usize>> {
    let mut ranges: Vec<Range<usize>> = segments
        .into_iter()
        .map(|r| r.start.min(len)..r.end.min(len))
        .filter(|r| r.start < r.end)
        .collect();
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<Range<usize>> = Vec::with_capacity(ranges.len());
    for r in ranges {
        match merged.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => merged.push(r),
        }
    }
    merged
}

/// 把人声段拼成一块块不超过 `max_len` 个采样的识别块，切口落在停顿上。
///
/// 为什么要切：模型一次吃整段长录音，交给显卡的单个任务会随长度变长（Qwen3-ASR
/// 的注意力计算随长度平方增长，实测 1.7B 在集成显卡上 30 s 的录音 0.18 倍时长，
/// 102 s 就到了 0.29 倍）。一个任务超过 Windows 显卡看门狗的 2 秒，显卡就被重置
/// （LiveKernelEvent 141，Vulkan 报 DeviceLost），本次和之后的本地识别全部失败。
/// 2026-10-19 一条 220 秒的录音就是这样把显卡搞挂的。
///
/// 规则：
/// - 相邻人声段贪心地并进同一块，块内的短停顿原样保留（短录音结果与切块之前
///   只裁首尾时一致：总长不超过上限时只有一块，就是首段开头到末段结尾）；
/// - 两块之间的长停顿直接丢掉，那里本来就是静音；
/// - 单独一段话就超过上限（一口气说了很久、中间没有 0.45 s 以上的停顿）时，
///   在这一块的后三分之一里找最安静的 100 ms 切开，找不到更好的位置才硬切。
pub fn plan_chunks(samples: &[f32], segments: &[Range<usize>], max_len: usize) -> Vec<Range<usize>> {
    let segments = normalize_segments(segments.iter().cloned(), samples.len());
    if max_len == 0 {
        return segments;
    }
    let mut chunks: Vec<Range<usize>> = Vec::new();
    let mut current: Option<Range<usize>> = None;
    for seg in segments {
        current = match current {
            Some(cur) if seg.end - cur.start <= max_len => Some(cur.start..seg.end),
            Some(cur) => {
                chunks.push(cur);
                Some(seg)
            }
            None => Some(seg),
        };
    }
    if let Some(cur) = current {
        chunks.push(cur);
    }

    let mut out = Vec::with_capacity(chunks.len());
    for chunk in chunks {
        split_overlong(samples, chunk, max_len, &mut out);
    }
    out
}

/// 一段连续人声超过上限时，在 [上限的 2/3, 上限] 里找最安静的 100 ms 切开。
fn split_overlong(samples: &[f32], chunk: Range<usize>, max_len: usize, out: &mut Vec<Range<usize>>) {
    const FRAME: usize = 1600; // 16 kHz 下 100 ms
    let mut start = chunk.start;
    while chunk.end - start > max_len {
        let search_from = start + max_len * 2 / 3;
        let search_to = start + max_len;
        let mut best_cut = search_to;
        let mut best_level = f32::MAX;
        let mut frame_start = search_from;
        while frame_start + FRAME <= search_to {
            let frame = &samples[frame_start..frame_start + FRAME];
            let level = frame.iter().map(|s| s.abs()).sum::<f32>() / FRAME as f32;
            if level < best_level {
                best_level = level;
                best_cut = frame_start + FRAME / 2;
            }
            frame_start += FRAME;
        }
        out.push(start..best_cut);
        start = best_cut;
    }
    out.push(start..chunk.end);
}

/// 把整段录音切成首尾相接、每块不超过 `max_len` 个采样的几块，切口落在停顿正中。
///
/// 给单次时长有上限的云端接口用（DeepSeek 一次最长 120 秒）。和上面给本地识别用的
/// `plan_chunks` 有三处刻意的不同：
///
/// - **不丢音频**。`plan_chunks` 之前已经用 VAD 判过有人声，块之间的长停顿直接扔掉。
///   这里 VAD 只负责挑切口，块与块首尾相接、覆盖整段录音：VAD 漏判的轻声照样发出去，
///   不会因为它判错了就少几个字。
/// - **挑最长的停顿，不挑第一个装不下的停顿**。贪心拼块会切在「恰好超长之前的那个停顿」，
///   那很可能只是句中换气。这里在每块的 [`min_len`, `max_len`] 窗口里挑最长的那个，
///   它最可能在两句话之间；切在正中，两边各留半截静音。
/// - 窗口里一个停顿都没有（一口气说了一分多钟，或者背景太吵、VAD 分不出停顿），
///   才退到窗口里最安静的 100 ms，和 `split_overlong` 同一招。
///
/// `segments` 可以为空（VAD 失败时调用方就这么传），那就每一刀都找最安静的地方。
pub fn plan_contiguous_chunks(
    samples: &[f32],
    sample_rate: usize,
    segments: &[Range<usize>],
    min_len: usize,
    max_len: usize,
) -> Vec<Range<usize>> {
    let total = samples.len();
    if max_len == 0 || total <= max_len {
        return vec![0..total];
    }
    // 窗口至少要有一个采样宽，否则下面挑不出切口、也就没法保证每一刀都往前走
    let min_len = min_len.clamp(1, max_len - 1);
    let segments = normalize_segments(segments.iter().cloned(), total);
    let pauses: Vec<Range<usize>> = segments
        .windows(2)
        .map(|pair| pair[0].end..pair[1].start)
        .filter(|gap| gap.start < gap.end)
        .collect();

    let mut chunks = Vec::new();
    let mut start = 0;
    while total - start > max_len {
        let lo = start + min_len;
        let hi = start + max_len;
        let middle = |gap: &Range<usize>| gap.start + (gap.end - gap.start) / 2;
        // 一样长时 max_by_key 取最后一个，块就尽量长、总块数尽量少
        let longest = pauses
            .iter()
            .filter(|gap| (lo..=hi).contains(&middle(*gap)))
            .max_by_key(|gap| gap.end - gap.start);
        let cut = match longest {
            Some(gap) => middle(gap),
            None => quietest_point(samples, sample_rate, lo, hi),
        };
        chunks.push(start..cut);
        start = cut;
    }
    chunks.push(start..total);
    chunks
}

/// [lo, hi] 里最安静的 100 ms 的正中。
///
/// 步长 50 ms，比 `split_overlong` 的 100 ms 细一倍：这里的窗口有几十秒，多算一倍也只是
/// 几毫秒，换来的是切口更贴近真正的静音。全段一样响时取第一个，块最短也有 `min_len`。
fn quietest_point(samples: &[f32], sample_rate: usize, lo: usize, hi: usize) -> usize {
    let frame = (sample_rate / 10).max(1);
    let hop = (frame / 2).max(1);
    let end = hi.min(samples.len());
    let mut best_cut = hi;
    let mut best_level = f32::MAX;
    let mut frame_start = lo;
    while frame_start + frame <= end {
        let level = samples[frame_start..frame_start + frame]
            .iter()
            .map(|s| s.abs())
            .sum::<f32>()
            / frame as f32;
        if level < best_level {
            best_level = level;
            best_cut = frame_start + frame / 2;
        }
        frame_start += hop;
    }
    best_cut
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: usize = 16_000;

    fn read_test_speech() -> Vec<f32> {
        let bytes = include_bytes!("../../resources/test_zh.wav");
        bytes[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect()
    }

    #[test]
    fn pure_silence_is_rejected() {
        let audio = vec![0.0; SR * 3];
        assert!(detect_speech_segments(&audio, SR).unwrap().is_empty());
    }

    #[test]
    fn steady_background_noise_is_rejected() {
        let mut state = 0x1234_5678u32;
        let audio: Vec<f32> = (0..SR * 3)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / 16_777_215.0 - 0.5) * 0.02
            })
            .collect();
        assert!(detect_speech_segments(&audio, SR).unwrap().is_empty());
    }

    #[test]
    fn short_transient_noise_is_rejected() {
        let mut audio = vec![0.0; SR];
        // 模拟一次约 32ms 的敲击/提示音；不应满足持续人声条件。
        for (i, sample) in audio[SR / 2..SR / 2 + 512].iter_mut().enumerate() {
            let t = i as f32 / SR as f32;
            *sample = 0.4 * (2.0 * std::f32::consts::PI * 1_500.0 * t).sin();
        }
        assert!(detect_speech_segments(&audio, SR).unwrap().is_empty());
    }

    #[test]
    fn bundled_speech_is_detected() {
        let speech = read_test_speech();
        assert!(
            !detect_speech_segments(&speech, SR).unwrap().is_empty(),
            "真实中文语音不应被 VAD 拒绝",
        );
    }

    #[test]
    fn quiet_speech_is_detected() {
        let speech: Vec<f32> = read_test_speech().into_iter().map(|s| s * 0.2).collect();
        assert!(
            !detect_speech_segments(&speech, SR).unwrap().is_empty(),
            "降低约 14dB 的轻声语音不应被 VAD 拒绝",
        );
    }

    const S: usize = SR; // 一秒的采样数，读起来更直观

    #[test]
    fn short_audio_stays_one_chunk_with_its_pauses() {
        // 总跨度 20 s < 30 s：一块，从首段开头到末段结尾，中间的停顿保留
        let audio = vec![0.1; 25 * S];
        let segments = vec![S..5 * S, 8 * S..12 * S, 15 * S..21 * S];
        assert_eq!(plan_chunks(&audio, &segments, 30 * S), vec![S..21 * S]);
    }

    #[test]
    fn long_audio_is_cut_at_pauses_and_every_chunk_fits() {
        // 220 s：每 10 s 一段话、段间 2 s 停顿
        let audio = vec![0.1; 220 * S];
        let segments: Vec<_> = (0..18).map(|i| (i * 12) * S..(i * 12 + 10) * S).collect();
        let chunks = plan_chunks(&audio, &segments, 30 * S);
        assert!(chunks.len() >= 8, "220 s 应该切成多块，实际 {}", chunks.len());
        for c in &chunks {
            assert!(c.end - c.start <= 30 * S, "块超长：{:?}", c);
            // 切口都落在某段话的边界上，不会把话切成两半
            assert!(segments.iter().any(|s| s.start == c.start));
            assert!(segments.iter().any(|s| s.end == c.end));
        }
        // 所有人声都被覆盖，一段不漏
        for s in &segments {
            assert!(chunks.iter().any(|c| c.start <= s.start && s.end <= c.end));
        }
    }

    #[test]
    fn one_long_breathless_segment_is_split_at_its_quietest_point() {
        // 一口气说 70 s，中间 45~45.1 s 有一处很轻的地方，没到 VAD 认定的停顿
        let mut audio = vec![0.3; 70 * S];
        for s in &mut audio[45 * S..45 * S + 1600] {
            *s = 0.01;
        }
        let chunks = plan_chunks(&audio, &[0..70 * S], 30 * S);
        assert!(chunks.iter().all(|c| c.end - c.start <= 30 * S), "{chunks:?}");
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, 70 * S);
        // 首尾相接，没有丢音频
        for pair in chunks.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        // 搜索窗是每块的 [20 s, 30 s]。安静点落在搜索窗里时，必须正好切在那 100 ms 的中间
        let mut audio2 = vec![0.3; 50 * S];
        for s in &mut audio2[25 * S..25 * S + 1600] {
            *s = 0.01;
        }
        let chunks2 = plan_chunks(&audio2, &[0..50 * S], 30 * S);
        assert_eq!(chunks2[0].end, 25 * S + 800, "{chunks2:?}");
    }

    /// 首尾相接、一个采样都不丢、每块不超长。三条一起断言，任何一条坏了都是丢字或 400。
    fn assert_contiguous(chunks: &[Range<usize>], total: usize, max_len: usize) {
        assert_eq!(chunks.first().unwrap().start, 0, "{chunks:?}");
        assert_eq!(chunks.last().unwrap().end, total, "{chunks:?}");
        for pair in chunks.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "块之间有缝：{chunks:?}");
        }
        for c in chunks {
            assert!(c.end - c.start <= max_len, "块超长：{c:?}");
            assert!(c.start < c.end, "空块：{chunks:?}");
        }
    }

    #[test]
    fn contiguous_chunks_leave_audio_within_the_limit_whole() {
        let audio = vec![0.1; 100 * S];
        assert_eq!(
            plan_contiguous_chunks(&audio, SR, &[], 60 * S, 110 * S),
            vec![0..100 * S],
        );
    }

    /// 300 s：大部分句间停顿 0.5 s，95 s 和 205 s 处各有一个 2 s 的长停顿。
    /// 每一刀都要切在窗口 [60 s, 110 s] 里**最长**的那个停顿正中，而不是第一个停顿。
    #[test]
    fn contiguous_chunks_cut_in_the_middle_of_the_longest_pause() {
        let half = S / 2;
        let audio = vec![0.1; 300 * S];
        let segments = vec![
            0..30 * S,
            30 * S + half..60 * S,
            60 * S + half..95 * S,
            97 * S..130 * S,
            130 * S + half..160 * S,
            160 * S + half..205 * S,
            207 * S..240 * S,
            240 * S + half..270 * S,
            270 * S + half..300 * S,
        ];
        let chunks = plan_contiguous_chunks(&audio, SR, &segments, 60 * S, 110 * S);
        assert_eq!(chunks, vec![0..96 * S, 96 * S..206 * S, 206 * S..300 * S]);
        assert_contiguous(&chunks, audio.len(), 110 * S);
    }

    /// 一口气说 250 s、VAD 分不出停顿：退到窗口里最安静的 100 ms，切在它正中。
    #[test]
    fn contiguous_chunks_fall_back_to_the_quietest_point_without_pauses() {
        let mut audio = vec![0.3; 250 * S];
        for s in &mut audio[80 * S..80 * S + 1600] {
            *s = 0.01;
        }
        // 一整段人声，和 VAD 失败时传空列表，两种都没有停顿可挑
        for segments in [vec![0..250 * S], Vec::new()] {
            let chunks = plan_contiguous_chunks(&audio, SR, &segments, 60 * S, 110 * S);
            assert_eq!(chunks[0], 0..80 * S + 800, "{chunks:?}");
            assert_contiguous(&chunks, audio.len(), 110 * S);
        }
    }

    /// 走生产路径：真实语音中间插 1 秒静音，细粒度 VAD 要能把它认成停顿，
    /// 切口落在这 1 秒里，而不是切进说话的地方。
    #[test]
    fn real_speech_is_cut_inside_the_inserted_pause() {
        let speech = read_test_speech();
        // 一句话重复到 70 s 以上，每遍之间不留空，只有 64 s 处插一段 1 s 静音
        let mut audio = Vec::new();
        let mut pause = 0..0;
        while audio.len() < 130 * SR {
            if pause.is_empty() && audio.len() >= 64 * SR {
                let at = audio.len();
                audio.extend(std::iter::repeat(0.0).take(SR));
                pause = at..audio.len();
            }
            audio.extend_from_slice(&speech);
        }
        let segments = detect_speech_for_cuts(&audio, SR).unwrap();
        let chunks = plan_contiguous_chunks(&audio, SR, &segments, 60 * SR, 110 * SR);
        assert_contiguous(&chunks, audio.len(), 110 * SR);
        let first_cut = chunks[0].end;
        assert!(
            pause.contains(&first_cut),
            "切口 {first_cut} 没落在插入的静音 {pause:?} 里",
        );
    }

    #[test]
    fn overlapping_padded_segments_are_merged() {
        let audio = vec![0.1; 10 * S];
        let chunks = plan_chunks(&audio, &[3 * S..6 * S, S..4 * S, 9 * S..12 * S], 30 * S);
        // 截到音频长度、合并重叠，再并成一块
        assert_eq!(chunks, vec![S..10 * S]);
    }

    #[test]
    fn internal_pause_is_preserved() {
        let speech = read_test_speech();
        let half = speech.len() / 2;
        let mut audio = vec![0.0; SR];
        audio.extend_from_slice(&speech[..half]);
        let pause_start = audio.len();
        audio.extend(std::iter::repeat(0.0).take(SR * 2));
        let pause_end = audio.len();
        audio.extend_from_slice(&speech[half..]);
        audio.extend(std::iter::repeat(0.0).take(SR));

        // 走生产路径：分段 → 拼块。几秒的录音只有一块，句中 2 s 的停顿留在块里
        let segments = detect_speech_segments(&audio, SR).unwrap();
        assert!(!segments.is_empty(), "前后两段真实语音应被检测到");
        let chunks = plan_chunks(&audio, &segments, 30 * SR);
        assert_eq!(chunks.len(), 1, "短录音应只有一块：{chunks:?}");
        let span = chunks[0].clone();
        assert!(span.start < pause_start);
        assert!(span.end > pause_end);
        assert!(audio[span.clone()][pause_start - span.start..pause_end - span.start]
            .iter()
            .all(|sample| *sample == 0.0));
    }
}
