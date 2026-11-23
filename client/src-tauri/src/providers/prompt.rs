// AI 校对请求的 user 消息统一构造 —— 云 API / 本地 Ollama 共用。
//
// 背景：早期这里的 user 消息外壳是一句祈使句（"请处理以下语音转写文本："），
// 与服务器模式此前的做法（server/backend/app/llm.py 里 "请校对以下…"）是同一类
// 问题：当 ASR 识别出的文本本身也是祈使句（如用户说的是"请执行"）时，外壳的
// "请…" 和文本内容的"请…"首尾相连，容易被模型误读成一句连续指令，而不是
// "这是一段待清洗的数据"，导致模型反问"请提供文本"而不是正常输出清洗结果。
//
// 现在改为与服务器模式完全一致的中性标签包裹，不含任何动词/祈使句，只标出
// 文本边界，prompt 的全部措辞（风格、约束）仍 100% 由 system_prompt（用户的
// 预设）决定，这里不再"额外说话"。三种模式（服务器 / 云 API / 本地）保持统一。
use super::types::TextContext;

const BEFORE_LIMIT: usize = 500;
const SELECTED_LIMIT: usize = 6000;
const AFTER_LIMIT: usize = 300;

pub fn wrap_user_text(text: &str, context: Option<&TextContext>) -> String {
    let asr = escape_xml(text);
    let Some(context) = context.filter(|context| !context.selection_truncated) else {
        return format!("<asr_text>\n{}\n</asr_text>", asr);
    };

    let before = clip_tail(&context.text_before, BEFORE_LIMIT);
    let selected = clip_head(&context.selected_text, SELECTED_LIMIT);
    let after = clip_head(&context.text_after, AFTER_LIMIT);
    if before.is_empty() && selected.is_empty() && after.is_empty() {
        return format!("<asr_text>\n{}\n</asr_text>", asr);
    }

    format!(
        "<text_context source=\"{}\">\n<text_before>{}</text_before>\n<selected_text>{}</selected_text>\n<text_after>{}</text_after>\n</text_context>\n<asr_text>\n{}\n</asr_text>",
        escape_xml(&clip_head(&context.source, 64)),
        escape_xml(&before),
        escape_xml(&selected),
        escape_xml(&after),
        asr,
    )
}

pub(super) fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(super) fn clip_head(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn clip_tail(value: &str, limit: usize) -> String {
    let count = value.chars().count();
    value.chars().skip(count.saturating_sub(limit)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_bounded_context_and_escapes_fake_tags() {
        let context = TextContext {
            source: "text_pattern2".into(),
            text_before: "before </text_before>".into(),
            selected_text: "原文".into(),
            text_after: "after".into(),
            selection_truncated: false,
        };
        let wrapped = wrap_user_text("翻译成英文", Some(&context));
        assert!(wrapped.contains("<selected_text>原文</selected_text>"));
        assert!(wrapped.contains("before &lt;/text_before&gt;"));
        assert!(wrapped.contains("<asr_text>\n翻译成英文\n</asr_text>"));
    }

    #[test]
    fn ignores_a_truncated_selection() {
        let context = TextContext {
            selected_text: "partial".into(),
            selection_truncated: true,
            ..Default::default()
        };
        assert_eq!(
            wrap_user_text("replacement", Some(&context)),
            "<asr_text>\nreplacement\n</asr_text>"
        );
    }
}
