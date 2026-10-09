// 「这家 ASR 拿用户的热词做什么」的唯一声明处。
//
// ## 为什么需要这个文件
//
// 起因是 issue #67：FunASR 上游维护者核对源码后指出，经「OpenAI 兼容」的
// multipart 协议接入时，用户配的热词**根本没有进请求** —— `asr_groq.rs` 的参数当时
// 写作 `_hotwords`，而唯一能放词表的 `prompt` 字段被拿去做中文标点引导了。
//
// 但真正该修的不是那一家。「哪些家会用热词」这份知识当时存在两个地方：实现在各
// provider 里（用不用 hotwords 由每个文件自己决定），声明在前端一张手写的表格里
// （Dictionary.tsx 硬编码 7 行，漏了 6 家云服务）。两者之间没有任何机制关联 ——
// 加一家 provider 时不会有东西提醒你更新那张表，改一处实现时也不会有东西告诉你
// 文案已经过期。所以漂移是必然的。
//
// 让它能长期存在的是**漂移的静默性**：热词没参与，转写照样成功，用户只觉得
// "识别得不太准"。这和 `dev-docs/critique-语音引擎页-2026-08-03.md` 记的那条同型 ——
// 「测试连接显示 ASR=on 会让用户合理地认为配置生效了，而它没有」。
//
// ## 为什么声明集中在这里，而热词的加工留在各 provider
//
// 判据是**这份知识属于谁**：
//   · 「某家协议长什么样」（`parameters.vocabulary` 是 {词: 权重}、`corpus.context`
//     是一个字符串、`transcription.keywords` 是数组）—— 留在那家的文件里。抽成公共
//     函数会把协议知识搬离协议实现，provider 反而被掏空，加一家要改两处。
//   · 「哪些家有这个能力」—— 集中到一处。分散就会漂移，这次的 bug 就是它。
//
// 所以这里只有枚举和 match，不碰任何请求体。
//
// ## ⚠️ 加一家 ASR 时必须同时改的两处
//
// 这个文件的 match 和 `registry.rs::cloud_transcribe` 的 match **key 列表必须一致**。
// 两个文件刻意相邻，但相邻只是习惯、不是机制 —— 真正拦住漏声明的是
// `ALL_ASR_PROVIDERS` 那份清单加下面的测试：漏了就报 `UnknownProvider`，测试当场红。
//
// 而那条一致性测试的对照**是从 `cloud_transcribe` 的源码里扫出来的**
// （`registry.rs::dispatch_keys_for_test`），不是另一份手抄清单。这个区别要紧：
// 手抄副本只能证明"我抄得一致"，改了真实分发而不动副本照样全绿，新增和删除分支
// 都漏得掉。扫源码之后，动 match 就必然反映到对照集合上。
//
// **`UnknownProvider` 绝不能回落成「不传热词」**。那样删掉一条声明测试照样绿，
// 而界面会平静地告诉用户「这家不用热词」—— 把"我们没声明"说成"它不支持"。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 热词能到达协议的哪一层。
///
/// 刻意不用「支持 / 不支持」：**没有哪一档是精确命中的**。
/// `asr_openai_realtime.rs` 里 `KEYWORD_LIMIT` 的注释自己写着「keywords 是提示不是
/// 强制，给太多反而会稀释每一个的作用」；`dict.caveat` 那句「热词只提高命中概率」
/// 才是对全部档位都成立的说法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotwordDelivery {
    /// 协议有专门的热词字段，可带权重或条数约束。
    /// 千问 Audio 3.0 的 `parameters.vocabulary`、OpenAI Realtime 的 `keywords`。
    Vocabulary,
    /// 作为识别上下文捎带（软偏置）。豆包的 `corpus.context`、千问的 `corpus.text`。
    /// 注意这一档会被**回显**进识别结果，所以 `asr_qwen.rs` 有 `strip_hotword_echo`。
    Context,
    /// 拼进给模型的自然语言指令。最弱的一档，模型可能把词表当成内容处理。
    Instruction,
    /// 这条协议本身没有放热词的位置。
    /// 与下面那档分开是为了让「将来能不能接」这个问题有答案 ——
    /// 这一档接不了，`NotWiredUp` 那档是我们还没接。
    ProtocolHasNoSlot,
    /// 协议有位置，但当前实现没有把热词放进去。
    /// `asr_groq.rs` 是典型：`prompt` 字段被中文标点引导占用了（见它的
    /// `PUNCTUATION_PROMPT`，缺了它中文短句一个标点都没有）。
    NotWiredUp,
    /// 「OpenAI 兼容」的 auto 档：协议要探测出来才知道，探到 `chat` 有、
    /// `transcriptions` 没有。探测结果缓存在 `asr_openai_compat.rs` 的 PROTOCOL_CACHE。
    UndecidedProtocol,
    /// 这个 provider 不在声明清单里。**这是一个 bug 信号，不是一种能力。**
    UnknownProvider,
}

impl HotwordDelivery {
    /// 热词这一次到底进没进 ASR 请求。
    ///
    /// 界面只需要这个布尔值：前三档对用户的行动没有区别（都是"配了有帮助、
    /// 不保证命中"），只有不进请求那几档需要他去做别的事。
    pub fn reaches_asr(self) -> bool {
        matches!(
            self,
            HotwordDelivery::Vocabulary | HotwordDelivery::Context | HotwordDelivery::Instruction
        )
    }
}

/// 一份配置在两条执行路径上的热词行为，以及客户端自己加的条数上限。
///
/// **两条路径必须分开回答，这不是锦上添花**：同一个 provider 在两条路上的行为可以
/// 相反 —— `openai_live_transcribe` 流式走 `asr_openai_realtime`（keywords）、回落走
/// `asr_groq`（忽略）；`gemini_live_transcribe` 正好反过来，流式走 `asr_gemini_live`
/// （忽略）、回落走 `asr_gemini`（拼进 prompt）。只按 provider 给一个答案，
/// 这两家里必有一家被说错。
///
/// 而且走哪条是**运行时**才定的：没开实时字幕、这家没有流式实现、配置没就绪
/// （千问 realtime 缺业务空间 ID）、或者建连失败，都会回落到一次性路径
/// （见 `CloudAPIProvider.ts::tryStartRealtimeStream`）。所以设置页只能展示
/// 「配置预期」，本次真正走了哪条要看日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrHotwordCapability {
    /// 走流式路径（`*_stream_open`）时的行为。
    /// 这家没有流式实现时等于 `buffered`，免得前端还要判断该看哪个字段。
    pub streaming: HotwordDelivery,
    /// 走一次性路径（`registry.rs::cloud_transcribe`）时的行为，
    /// 也是流式不可用或建连失败回落后的实际行为。
    pub buffered: HotwordDelivery,
    /// 这家有没有流式实现。为假时上面两个字段必然相同。
    pub has_streaming_path: bool,
    /// **SayIt 自己设的**最多发送条数，不是服务端限制。走流式路径时的那份。
    ///
    /// 三家都是 100，三处注释都写明了是客户端保护：千问的文档「只对超级热词明确了
    /// 50 的上限，普通热词没给数字」，OpenAI 的是怕整条 `session.update` 被拒，
    /// Gemini 的是怕 prompt 被撑长、每个词的作用被稀释。
    /// 界面上必须说成"SayIt 最多发送 N 条"，不能说成"这家协议只吃 N 条"。
    pub streaming_client_cap: Option<usize>,
    /// 同上，走一次性路径（含流式回落）时的那份。
    ///
    /// **必须和 delivery 一起按路径分开给，一个字段不够。** 现场证据是
    /// `openai_live_transcribe`：流式的 `keywords` 有 100 条上限，关掉实时字幕后
    /// 回落到文件端点则一条都不发。只给一个字段的话，前端在关字幕时会同时显示
    /// 「不发送」和「最多发送 100 个，其余不发出」—— 两句话互相矛盾。
    /// 反方向同理：`gemini_live_transcribe` 的上限只存在于回落那条路上。
    pub buffered_client_cap: Option<usize>,
}

/// 全部 ASR 分发 key。**必须与 `registry.rs::cloud_transcribe` 的 match 一致。**
///
/// 含三类：
///   · 前端目录里选得到的（`asrProviderCatalog.ts` 各模型的 `provider`）
///   · 内部 key（`openai_compat_transcribe` / `openai_chat_audio`，由
///     `asr_openai_compat` 探测后分发）
///   · 存量配置里的旧 key（`doubao` / `aliyun`），迁移后仍可能出现在设置里
pub const ALL_ASR_PROVIDERS: &[&str] = &[
    "doubao",
    "doubao_v2",
    "qwen",
    "aliyun",
    "qwen_realtime",
    "qwen_audio_stream",
    "qwen_omni",
    "qwen_chat_audio",
    "mimo",
    "groq_whisper",
    "openai_transcribe",
    "openai_live_transcribe",
    "openai_compat",
    "openai_compat_transcribe",
    "openai_chat_audio",
    "openai_chat_audio_standard",
    "gemini_transcribe",
    "gemini_live_transcribe",
    "openrouter_transcribe",
];

/// 千问 Audio 3.0 与 OpenAI Realtime 各自的客户端条数上限。
///
/// 刻意在这里重复一遍而不是从那两个模块 `pub` 出来：那两个常量是**请求构造的参数**
/// （改它会改发出去的内容），这里是**给用户看的说明**。让说明去 import 请求参数，
/// 会让「改上限」这个动作悄悄改掉界面文案，反过来也一样。两边各留一份、由下面的
/// 测试钉住一致性，比耦合起来安全。
const QWEN_VOCABULARY_CAP: usize = 100;
const OPENAI_KEYWORD_CAP: usize = 100;
/// Gemini 文件转写把热词拼进 prompt，同样有 100 条的客户端截断
/// （`asr_gemini.rs::build_prompt` 的 `.take(HOTWORD_LIMIT)`）。
///
/// 漏声明这一条的代价是**完全静默**：配 150 个词只发 100 个，而热词页既不显示上限
/// （没声明就没有那行字），又够不到 `HOTWORD_SOFT_LIMIT`（200）那条通用提醒。
/// Gemini Live 关掉实时字幕回落到文件转写时是同一条路。
const GEMINI_PROMPT_CAP: usize = 100;

/// 一次性路径（`registry.rs::cloud_transcribe`）上的热词行为。
///
/// 每一条都对应 registry 里的一个分支，注释里写的是那家实现的落点。
fn buffered_delivery(provider: &str, extra: &Value) -> HotwordDelivery {
    match provider {
        // asr_doubao / asr_doubao_stream → doubao_protocol::build_hotword_context
        // → request.corpus.context
        "doubao" | "doubao_v2" => HotwordDelivery::Context,
        // asr_qwen::build_hotword_context_text → 上下文文本（带 strip_hotword_echo）
        "qwen" | "aliyun" | "qwen_realtime" => HotwordDelivery::Context,
        // asr_qwen_audio_stream::build_vocabulary → parameters.vocabulary（词 → 权重 4）。
        // 声明按 provider key 而不是模型名，所以 Qwen-Audio 3.0 与 3.1 共用这一档 ——
        // 两代都实测接受这个字段（见那份实现的文件头）。注意 Vocabulary 这一档的口径
        // 始终是「进了请求」，不是「一定命中」。
        "qwen_audio_stream" => HotwordDelivery::Vocabulary,
        // asr_qwen_omni → 追加到 system instructions
        "qwen_omni" => HotwordDelivery::Instruction,
        // asr_openai_chat_audio → 复用 asr_qwen 的上下文文本，追加到 instruction
        "qwen_chat_audio" | "openai_chat_audio" | "openai_chat_audio_standard" => HotwordDelivery::Instruction,
        // asr_gemini::build_prompt → 拼一段 vocabulary 提示
        "gemini_transcribe" | "gemini_live_transcribe" => HotwordDelivery::Instruction,
        // asr_mimo：OpenAI chat/completions 兼容，协议有 instruction 位置
        //（asr_openai_chat_audio 就是这么做的），只是这份实现没接。
        "mimo" => HotwordDelivery::NotWiredUp,
        // asr_groq：`/audio/transcriptions` 的 `prompt` 字段是热词的天然位置
        //（OpenAI 的 prompting 指南把专有名词和标点列在一起），但我们拿它换了中文
        // 标点。组合两者尚未验证 —— 验证工具是现成的
        //（dev-scripts 里那两个 groq-asr-*-probe.mjs 打真实接口）。
        "groq_whisper" | "openai_transcribe" | "openai_compat_transcribe" => {
            HotwordDelivery::NotWiredUp
        }
        // openai_live_transcribe 关掉实时字幕时走 asr_groq 的文件端点（模型换成
        // gpt-transcribe，见 asr_groq.rs 的 OPENAI_FILE_FALLBACK），所以和上面同档。
        "openai_live_transcribe" => HotwordDelivery::NotWiredUp,
        // asr_openrouter：文件头写明它的两种形态都没有 prompt 通道
        //（multipart 那条「接受后忽略」，原生 JSON 的参数表里也没有）。
        // 依据是官方文档 + `build_body` 里确实没有可用字段；**这家整体没有真接口验证过**
        // （见 asr_openrouter.rs 文件头「未经真实接口验证」，我们没有 OpenRouter key）。
        "openrouter_transcribe" => HotwordDelivery::ProtocolHasNoSlot,
        // 「OpenAI 兼容」那张卡：协议决定有没有热词。用户显式指定过就能确定，
        // auto 要等探测（结果在 asr_openai_compat 的 PROTOCOL_CACHE 里）。
        "openai_compat" => match extra.get("protocol").and_then(Value::as_str) {
            // → asr_openai_chat_audio，走 instruction
            Some("chat") | Some("chat_standard") => HotwordDelivery::Instruction,
            // → asr_groq，prompt 被标点占用
            Some("transcriptions") => HotwordDelivery::NotWiredUp,
            // auto：探过就给准话，没探过才说"未确定"。
            // 复用真实转写留下的缓存，而不是只认「测试连接」—— 用户可能直接开始口述。
            // 换了地址或模型，缓存键就不命中，自然退回"未确定"。
            _ => match super::asr_openai_compat::detected_protocol(extra) {
                Some(inner) => buffered_delivery(inner, extra),
                None => HotwordDelivery::UndecidedProtocol,
            },
        },
        _ => HotwordDelivery::UnknownProvider,
    }
}

/// 流式路径（前端 `STREAM_COMMANDS` 那组 `*_stream_open`）上的热词行为。
///
/// 返回 `None` 表示这家没有流式实现 —— 它只会走一次性路径。
/// 这份清单必须与 `CloudAPIProvider.ts` 的 `STREAM_COMMANDS` 一致。
fn streaming_delivery(provider: &str) -> Option<HotwordDelivery> {
    match provider {
        // asr_doubao_stream（流式 2.0）→ corpus.context
        "doubao_v2" => Some(HotwordDelivery::Context),
        // asr_qwen_realtime → session.input_audio_transcription.corpus.text
        "qwen_realtime" => Some(HotwordDelivery::Context),
        // asr_qwen_audio_stream → parameters.vocabulary
        "qwen_audio_stream" => Some(HotwordDelivery::Vocabulary),
        // asr_openai_realtime::build_keywords → transcription.keywords
        "openai_live_transcribe" => Some(HotwordDelivery::Vocabulary),
        // asr_gemini_live：Live API 没有**专门的**热词字段（见 gemini_live_open 的注释，
        // 它收下参数只为和其他 open 签名一致，并记一行 hotwords_ignored）。
        //
        // ⚠️ 这一档**不是"查证过接不了"，是"没有专门字段且借道未验证"**。Live API 的
        // setup 消息支持 `systemInstruction`（我们现在只发 model / generationConfig /
        // inputAudioTranscription），而 asr_gemini 的文件转写正是把热词拼进 prompt 的，
        // 照同样做法拼进 systemInstruction 在形式上是可能的。
        // 没那么做也没改成 NotWiredUp，是因为有一个真实的不确定性：
        // `inputAudioTranscription` 是独立于对话生成的通道，systemInstruction 未必参与
        // 它的解码。要改分类**必须先用真实 key 实测**，不能照着"字段存在"就推断。
        "gemini_live_transcribe" => Some(HotwordDelivery::ProtocolHasNoSlot),
        _ => None,
    }
}

/// 客户端自设的条数上限（不是服务端限制）。
///
/// `path_delivery` 是**这一条路径**上的档位，不是这家的概括 —— 上限只在热词真的进了
/// 请求时才有意义。热词不进请求那条路上报一个上限，界面会同时说出「不发送」和
/// 「最多发送 100 个」。所以调用方必须为两条路径各调一次，见 `hotword_capability`。
fn client_cap(provider: &str, path_delivery: HotwordDelivery) -> Option<usize> {
    if !path_delivery.reaches_asr() {
        return None;
    }
    match provider {
        "qwen_audio_stream" => Some(QWEN_VOCABULARY_CAP),
        "openai_live_transcribe" => Some(OPENAI_KEYWORD_CAP),
        // asr_gemini::build_prompt 的 .take(HOTWORD_LIMIT)。两个 key 都要写：
        // gemini_live_transcribe 关掉实时字幕就走这份文件转写实现（见 registry.rs
        // 里它和 gemini_transcribe 并在同一个分支）。它流式那条路是
        // ProtocolHasNoSlot，上面的 reaches_asr 守卫会自己把上限挡掉。
        "gemini_transcribe" | "gemini_live_transcribe" => Some(GEMINI_PROMPT_CAP),
        _ => None,
    }
}

/// 这份配置在两条路径上分别怎么对待热词。
///
/// `extra` 目前只用到 `protocol`（「OpenAI 兼容」那张卡）。签名收整个 Value 是留给
/// 以后的能力位 —— 语种码粒度、标点自带与否都会依赖配置，见 pitfalls #17。
pub fn hotword_capability(provider: &str, extra: &Value) -> AsrHotwordCapability {
    let buffered = buffered_delivery(provider, extra);
    let declared_streaming = streaming_delivery(provider);
    // 没有流式实现时把两条路径填成同一个答案，免得前端还要判断该看哪个字段。
    let streaming = declared_streaming.unwrap_or(buffered);
    AsrHotwordCapability {
        // 两条路径各算一次。**不能只按其中一条算**：openai_live 的上限只存在于流式，
        // gemini_live 的只存在于回落，取错一条就会和 delivery 自相矛盾。
        streaming_client_cap: client_cap(provider, streaming),
        buffered_client_cap: client_cap(provider, buffered),
        streaming,
        buffered,
        has_streaming_path: declared_streaming.is_some(),
    }
}

/// 供前端查询的能力接口。
///
/// 前端不再自己维护一份「哪家支持热词」的表 —— 那正是 issue #67 的成因。
#[tauri::command]
pub fn asr_hotword_capability(provider: String, extra: Option<Value>) -> AsrHotwordCapability {
    hotword_capability(&provider, &extra.unwrap_or(Value::Null))
}

/// 全部分发 key 的热词行为，给「各服务对热词的支持」那张对照表用。
///
/// ## 为什么要有这个，而不是在界面里写一张表
///
/// 界面本来就有一张手写的 7 行表（热词页的 ⓘ 里），它漏了 6 家云服务、还把「不支持」
/// 说成只是本地模型的问题 —— issue #67 就是撞在这上面。删掉它之后又缺了「完整对照」
/// 这个真实需求（选型时要比较），而文档在应用之外、用户点不到。
///
/// 所以表还要有，但**必须是实现的投影而不是另一份手写清单**：这个命令把
/// `ALL_ASR_PROVIDERS` 整个过一遍 `hotword_capability`，前端只负责把 key 翻成
/// 用户看得懂的名字（那部分要 i18n，本来就该留在前端）。
/// 这样「改了实现但忘了改表」在结构上不可能发生。
///
/// 返回 map 而不是数组：显示顺序由前端目录决定（它才知道推荐顺序和平台分组），
/// 这里只提供事实，不掺和排版。
///
/// ⚠️ `openai_compat` 在这里必然是 `UndecidedProtocol` —— 对照表没有具体配置，
/// 而它的答案取决于探测出的协议。这是正确的：通用参考表就该说"取决于协议"，
/// 用户当前那份配置的准话由 `asr_hotword_capability` 带 extra 查。
#[tauri::command]
pub fn asr_hotword_capability_matrix() -> std::collections::HashMap<String, AsrHotwordCapability> {
    ALL_ASR_PROVIDERS
        .iter()
        .map(|provider| {
            (
                (*provider).to_string(),
                hotword_capability(provider, &Value::Null),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cap(provider: &str) -> AsrHotwordCapability {
        hotword_capability(provider, &Value::Null)
    }

    /// 每个分发 key 都要有明确声明。
    ///
    /// 这条是防漂移的主力：加一家 provider 忘了在这里声明，它会落到
    /// `UnknownProvider`，测试当场红。**判据刻意不是「不等于某个具体档位」**，
    /// 而是「不是 UnknownProvider」——`_ =>` 回落成 NotWiredUp 的话，删掉一条
    /// 声明测试照样会绿，那种测试等于没写。
    #[test]
    fn every_dispatch_key_declares_its_hotword_behaviour() {
        for provider in ALL_ASR_PROVIDERS {
            let c = cap(provider);
            assert_ne!(
                c.buffered,
                HotwordDelivery::UnknownProvider,
                "{} 没有声明一次性路径的热词行为",
                provider,
            );
            assert_ne!(
                c.streaming,
                HotwordDelivery::UnknownProvider,
                "{} 没有声明流式路径的热词行为",
                provider,
            );
        }
    }

    /// 不认识的 provider 必须和「明确声明不传热词」区分开。
    ///
    /// 混在一起的后果是把"我们漏了声明"显示成"这家不支持热词"——
    /// 用错误的确定性覆盖掉一个 bug。
    #[test]
    fn an_unknown_provider_is_not_silently_reported_as_unsupported() {
        let unknown = cap("some_provider_we_never_heard_of");
        assert_eq!(unknown.buffered, HotwordDelivery::UnknownProvider);
        assert_ne!(unknown.buffered, HotwordDelivery::NotWiredUp);
        assert_ne!(unknown.buffered, HotwordDelivery::ProtocolHasNoSlot);
        // 也不能被 reaches_asr 说成"会传"
        assert!(!unknown.buffered.reaches_asr());
    }

    /// issue #67 那条路径：multipart 不传热词。
    #[test]
    fn the_multipart_transcriptions_path_does_not_carry_hotwords() {
        for provider in [
            "groq_whisper",
            "openai_transcribe",
            "openai_compat_transcribe",
        ] {
            let c = cap(provider);
            assert_eq!(c.buffered, HotwordDelivery::NotWiredUp, "{}", provider);
            assert!(!c.buffered.reaches_asr(), "{}", provider);
        }
    }

    /// 两家 live 供应商的热词行为在两条路径上是**相反**的。
    ///
    /// 这是「能力必须按执行路径判断、不能按 provider 一概而论」的现场证据：
    /// 只按 provider 声明，这两家里必有一家被说错。
    #[test]
    fn the_two_live_providers_are_inverted_between_paths() {
        let openai = cap("openai_live_transcribe");
        assert_eq!(openai.streaming, HotwordDelivery::Vocabulary);
        assert_eq!(openai.buffered, HotwordDelivery::NotWiredUp);
        assert!(openai.streaming.reaches_asr() && !openai.buffered.reaches_asr());

        let gemini = cap("gemini_live_transcribe");
        assert_eq!(gemini.streaming, HotwordDelivery::ProtocolHasNoSlot);
        assert_eq!(gemini.buffered, HotwordDelivery::Instruction);
        assert!(!gemini.streaming.reaches_asr() && gemini.buffered.reaches_asr());
    }

    /// 没有流式实现的那些家，两个字段要给同一个答案。
    #[test]
    fn providers_without_a_streaming_path_report_the_same_answer_twice() {
        for provider in ["qwen", "mimo", "groq_whisper", "openrouter_transcribe"] {
            let c = cap(provider);
            assert!(!c.has_streaming_path, "{}", provider);
            assert_eq!(c.streaming, c.buffered, "{}", provider);
        }
    }

    /// 「协议没位置」和「我们没接」不能混：前者回答"将来能不能接"是不能，后者是能。
    #[test]
    fn a_missing_protocol_slot_is_distinct_from_an_unwired_one() {
        // OpenRouter 两种形态都没有 prompt 通道
        assert_eq!(
            cap("openrouter_transcribe").buffered,
            HotwordDelivery::ProtocolHasNoSlot,
        );
        // asr_groq 有 prompt 字段，只是被标点引导占用了
        assert_eq!(
            cap("openai_transcribe").buffered,
            HotwordDelivery::NotWiredUp,
        );
    }

    /// 「OpenAI 兼容」的三种协议设置各对应一个确定答案，auto 不能假装知道。
    #[test]
    fn the_compat_card_follows_the_protocol_setting() {
        let auto = hotword_capability("openai_compat", &json!({ "protocol": "auto" }));
        assert_eq!(auto.buffered, HotwordDelivery::UndecidedProtocol);
        assert!(!auto.buffered.reaches_asr());
        // 缺省等于 auto
        assert_eq!(
            hotword_capability("openai_compat", &Value::Null).buffered,
            HotwordDelivery::UndecidedProtocol,
        );

        assert_eq!(
            hotword_capability("openai_compat", &json!({ "protocol": "chat" })).buffered,
            HotwordDelivery::Instruction,
        );
        assert_eq!(
            hotword_capability("openai_compat", &json!({ "protocol": "chat_standard" })).buffered,
            HotwordDelivery::Instruction,
        );
        assert_eq!(
            hotword_capability("openai_compat", &json!({ "protocol": "transcriptions" })).buffered,
            HotwordDelivery::NotWiredUp,
        );
    }

    /// 条数上限只在热词真的会进请求时才有意义。
    #[test]
    fn the_client_cap_is_only_reported_where_it_actually_applies() {
        let qwen = cap("qwen_audio_stream");
        assert_eq!(qwen.streaming_client_cap, Some(100));
        assert_eq!(qwen.buffered_client_cap, Some(100));
        // 豆包走 corpus.context，没有客户端截断
        assert_eq!(cap("doubao_v2").buffered_client_cap, None);
        // 不进请求的那几家不该显示上限（"最多发 100 条"对一条都不发的路径是误导）
        assert_eq!(cap("groq_whisper").buffered_client_cap, None);
        assert_eq!(cap("openrouter_transcribe").buffered_client_cap, None);
    }

    /// 上限必须跟着**路径**走，不能按 provider 给一个数。
    ///
    /// 只给一个字段时的现场症状：`openai_live_transcribe` 关掉实时字幕，界面同时
    /// 显示「当前识别服务不使用热词」和「最多发送 100 个，其余不会发出」。
    /// 这两家方向相反，任何"按 provider 取一个上限"的写法必有一家说错。
    #[test]
    fn the_cap_follows_the_execution_path_not_the_provider() {
        // 流式有 keywords（100 条），回落到文件端点一条都不发 → 回落那条不该有上限
        let openai = cap("openai_live_transcribe");
        assert_eq!(openai.streaming_client_cap, Some(100));
        assert_eq!(
            openai.buffered_client_cap, None,
            "回落路径一条热词都不发，却报了发送上限",
        );

        // Gemini live 反向：流式没有热词字段，回落到文件转写才有 100 条截断
        let gemini_live = cap("gemini_live_transcribe");
        assert_eq!(
            gemini_live.streaming_client_cap, None,
            "Live API 没有热词字段，却报了发送上限",
        );
        assert_eq!(gemini_live.buffered_client_cap, Some(100));
    }

    /// Gemini 文件转写的 100 条截断必须被声明出来。
    ///
    /// 漏了它是**完全静默**的一条：`asr_gemini.rs::build_prompt` 照样 `.take(100)`，
    /// 而热词页既不显示上限（没声明就没有那行字），又够不到 `HOTWORD_SOFT_LIMIT`
    /// （200）那条通用提醒 —— 配 150 个词的用户看不到后 50 个被丢掉了。
    #[test]
    fn gemini_file_transcription_declares_its_truncation() {
        let gemini = cap("gemini_transcribe");
        assert_eq!(gemini.buffered, HotwordDelivery::Instruction);
        assert_eq!(gemini.buffered_client_cap, Some(100));
        // 没有流式实现的那家，两个字段给同一个答案
        assert!(!gemini.has_streaming_path);
        assert_eq!(gemini.streaming_client_cap, gemini.buffered_client_cap);
    }

    /// 凡是声明了上限的路径，档位必须是"热词真的进了请求"那三档。
    ///
    /// 反过来说：`reaches_asr()` 为假却带着上限，就是一次自相矛盾的输出。
    /// 遍历全清单，新加 provider 时自动纳入。
    #[test]
    fn no_path_reports_a_cap_without_actually_sending_hotwords() {
        for provider in ALL_ASR_PROVIDERS {
            let c = cap(provider);
            if !c.streaming.reaches_asr() {
                assert_eq!(
                    c.streaming_client_cap, None,
                    "{} 的流式路径不发热词，却报了发送上限",
                    provider,
                );
            }
            if !c.buffered.reaches_asr() {
                assert_eq!(
                    c.buffered_client_cap, None,
                    "{} 的一次性路径不发热词，却报了发送上限",
                    provider,
                );
            }
        }
    }

    /// 这里的上限值必须和真正构造请求的那两个常量一致。
    ///
    /// 两边各留一份是刻意的（见 QWEN_VOCABULARY_CAP 的注释），代价是要这条测试
    /// 盯着。改了 asr_qwen_audio_stream.rs 的 HOTWORD_LIMIT 就会在这里红。
    #[test]
    fn the_documented_caps_match_the_request_builders() {
        assert_eq!(
            QWEN_VOCABULARY_CAP,
            crate::providers::asr_qwen_audio_stream::hotword_limit_for_docs(),
        );
        assert_eq!(
            OPENAI_KEYWORD_CAP,
            crate::providers::asr_openai_realtime::keyword_limit_for_docs(),
        );
        assert_eq!(
            GEMINI_PROMPT_CAP,
            crate::providers::asr_gemini::hotword_limit_for_docs(),
        );
    }

    /// 这份清单和 `registry.rs::cloud_transcribe` 实际认识的 key 必须是同一个集合。
    ///
    /// 两个文件相邻只是习惯，不是机制 —— 真正拦住漂移的是这条。少一个：新 provider
    /// 的热词说明会是 UnknownProvider；多一个：清单里留着已经删掉的 key，
    /// 上面那条遍历测试会替一个不存在的 provider 站岗，给人虚假的安全感。
    ///
    /// **对照来自源码，不是手抄副本。** `dispatch_keys_for_test` 扫的是
    /// `cloud_transcribe` 的 match 臂（见那个函数的注释）。这条是整套机制的落点：
    /// 对照本身若还是手写的，那就只能测出"两份副本抄得一致"，改真实分发照样全绿。
    #[test]
    fn the_declaration_list_matches_the_dispatch_table() {
        let mut declared: Vec<&str> = ALL_ASR_PROVIDERS.to_vec();
        let mut dispatched: Vec<&str> = crate::providers::registry::dispatch_keys_for_test();
        declared.sort_unstable();
        dispatched.sort_unstable();
        assert_eq!(
            declared, dispatched,
            "capabilities.rs 的声明清单和 registry.rs 的分发 key 不一致",
        );
    }

    /// 序列化出去的字段名要是前端认的 camelCase / snake_case。
    #[test]
    fn it_serializes_in_the_shape_the_frontend_expects() {
        let json = serde_json::to_value(cap("qwen_audio_stream")).unwrap();
        assert_eq!(json["streaming"], "vocabulary");
        assert_eq!(json["buffered"], "vocabulary");
        assert_eq!(json["hasStreamingPath"], true);
        assert_eq!(json["streamingClientCap"], 100);
        assert_eq!(json["bufferedClientCap"], 100);

        let groq = serde_json::to_value(cap("groq_whisper")).unwrap();
        assert_eq!(groq["buffered"], "not_wired_up");
        assert_eq!(groq["bufferedClientCap"], Value::Null);

        // 两条路径上限不同的那家，序列化出去必须是两个不同的值
        let openai = serde_json::to_value(cap("openai_live_transcribe")).unwrap();
        assert_eq!(openai["streamingClientCap"], 100);
        assert_eq!(openai["bufferedClientCap"], Value::Null);
    }

    /// 对照表覆盖每一个分发 key，且没有一行是 `UnknownProvider`。
    ///
    /// 这是「表格是实现的投影」这件事的落点：表不是手写的，所以不可能漏一家。
    /// 上面那条 `every_dispatch_key_...` 保的是声明完整，这条保的是**导出**完整 ——
    /// 两者分开，因为矩阵是另一条代码路径（漏掉某个 key 不会让前一条红）。
    #[test]
    fn the_reference_matrix_covers_every_provider() {
        let matrix = asr_hotword_capability_matrix();
        assert_eq!(matrix.len(), ALL_ASR_PROVIDERS.len());
        for provider in ALL_ASR_PROVIDERS {
            let row = matrix
                .get(*provider)
                .unwrap_or_else(|| panic!("对照表缺了 {}", provider));
            assert_ne!(row.buffered, HotwordDelivery::UnknownProvider, "{}", provider);
            assert_ne!(row.streaming, HotwordDelivery::UnknownProvider, "{}", provider);
        }
    }

    /// 对照表里的 `openai_compat` 必须是「取决于协议」。
    ///
    /// 它没有具体配置可依，只能这么说。这条钉的是**不要图省事给它填一个具体答案** ——
    /// 填 `NotWiredUp`（多数自建服务确实走 transcriptions）会让接百炼那类走 chat 的
    /// 用户在表里读到错的结论。
    #[test]
    fn the_matrix_leaves_the_compat_card_undecided() {
        let matrix = asr_hotword_capability_matrix();
        assert_eq!(
            matrix["openai_compat"].buffered,
            HotwordDelivery::UndecidedProtocol,
        );
    }
}
