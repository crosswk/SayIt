// 「随便问」：把一句口述的问题交给用户自配的模型回答，可选联网搜索。
//
// 联网有两条路，按「模型自带优先」排：
//   1. 模型服务自带搜索（DeepSeek 的 deepseek_web_search 工具、千问的 enable_search、
//      智谱的 web_search 工具、OpenRouter 的 web 插件）。搜索在服务端完成，我们只多带
//      几个请求参数。
//   2. 不支持自带搜索的模型，先调 DeepSeek 的独立搜索接口（/v1/tools/search）拿结果，
//      再把结果放进 user 消息交给模型。这条路和用哪家模型无关。
//
// 自带搜索参数被端点拒掉（模型不支持工具、中转站不认这个字段）时去掉参数重试一次，
// 有搜索密钥就顺带改走第 2 条 —— 不能因为联网失败就整次不回答。
//
// 日志口径与 diag.rs 一致：只记长度、模型、搜索走了哪条路，不记问题、选区和回答正文。

use super::ai_openai_compat::{self as compat, ChatHttpError};
use super::diag;
use super::prompt::{clip_head, escape_xml};
use super::types::AiProviderConfig;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const SCOPE: &str = "ai/ask";
const SEARCH_SCOPE: &str = "ai/ask-search";
const DEEPSEEK_SEARCH_URL: &str = "https://api.deepseek.com/v1/tools/search";
/// DeepSeek 搜索接口的 query 与 ori_question 都限 1~128 个 Unicode 字符，超了直接 400。
const SEARCH_QUERY_LIMIT: usize = 128;
const SEARCH_RESULT_COUNT: u32 = 6;
/// 单条结果交给模型的摘要上限。接口返回的 summary 本身约 600~800 字，留一点余量。
const SEARCH_SUMMARY_LIMIT: usize = 900;
const SELECTED_TEXT_LIMIT: usize = 6000;
const MAX_SOURCES: usize = 8;
const CHAT_TIMEOUT: Duration = Duration::from_secs(60);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);

/// 系统提示词留空时的兜底。正常情况下前端总会传内置或用户改过的那份。
const FALLBACK_SYSTEM_PROMPT: &str = "You are a concise, reliable assistant. Answer the user's spoken question directly in the language the user used. Use plain text without Markdown headings, tables or bold markers.";

#[derive(Debug, Clone, Deserialize)]
pub struct AskRequest {
    pub question: String,
    pub ai_config: AiProviderConfig,
    #[serde(default)]
    pub system_prompt: String,
    /// 提问时选中的文字。只在这一次请求里用，不落盘、不进日志。
    #[serde(default)]
    pub selected_text: String,
    /// auto（模型自带优先，不支持就用搜索接口）| external（只用搜索接口）| off
    #[serde(default)]
    pub search_mode: String,
    /// DeepSeek 搜索接口的密钥。前端在用户没单独填、而当前模型就是 DeepSeek 时会带上它的密钥。
    #[serde(default)]
    pub search_api_key: String,
    /// 本机日期（YYYY-MM-DD）。模型不知道今天是哪天，问时效性问题时会按训练截止日期答。
    #[serde(default)]
    pub today: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AskSource {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AskResult {
    pub text: String,
    pub sources: Vec<AskSource>,
    /// 这次实际走的联网方式：builtin | external | none
    pub search: String,
    /// 想联网但没联上的原因码，正常为空串：
    /// no_search_key / no_search_available / search_failed / search_empty / builtin_rejected
    pub search_issue: String,
    pub elapsed_ms: u64,
}

/// 哪几家的 chat/completions 自带联网搜索，以及各自怎么开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinSearch {
    DeepSeek,
    Qwen,
    OpenRouter,
}

impl BuiltinSearch {
    pub fn id(self) -> &'static str {
        match self {
            BuiltinSearch::DeepSeek => "deepseek",
            BuiltinSearch::Qwen => "qwen",
            BuiltinSearch::OpenRouter => "openrouter",
        }
    }

    /// 合并进请求体的参数（顶层字段）。
    ///
    /// - DeepSeek：声明 deepseek_web_search 工具，非思考模式下由模型决定要不要搜
    ///   （api-docs.deepseek.com/guides/web_tools）。关思考的参数由
    ///   send_chat_with_thinking_fallback 统一加，这里不重复。2026-11 实测：来源在
    ///   message.server_tool_calls 和 annotations 里；问题不需要时它不搜。
    /// - 千问（百炼兼容模式）：enable_search。2026-11 实测 qwen3.6-flash 会把搜索结果当
    ///   「知识库」用，但兼容模式的响应里**没有来源列表**（enable_source 不生效），答案卡就不显示来源。
    /// - OpenRouter：web 插件，来源以 url_citation 注解返回（文档写法，未实测）。
    ///
    /// **智谱不在这里**：2026-11 实测 GLM-5.3-Flash 带 web_search 工具（search_std / search_pro /
    /// search_prime 都试过）照样回答「无法联网」。列进来等于在设置页承诺一件做不到的事，
    /// 还会让 auto 模式跳过本来能用的搜索接口。智谱用户走 DeepSeek 搜索接口。
    fn params(self) -> serde_json::Value {
        match self {
            BuiltinSearch::DeepSeek => serde_json::json!({
                "tools": [{ "type": "deepseek_web_search" }],
            }),
            BuiltinSearch::Qwen => serde_json::json!({
                "enable_search": true,
                "search_options": { "enable_source": true },
            }),
            BuiltinSearch::OpenRouter => serde_json::json!({
                "plugins": [{ "id": "web" }],
            }),
        }
    }
}

/// 认这份配置能不能用自带搜索。内置卡按 provider 认，「OpenAI 兼容」卡填了官方地址的按域名认。
pub fn builtin_search_for(config: &AiProviderConfig) -> Option<BuiltinSearch> {
    match config.provider.as_str() {
        "ollama" => return None,
        "deepseek" => return Some(BuiltinSearch::DeepSeek),
        "qwen" => return Some(BuiltinSearch::Qwen),
        "openrouter" => return Some(BuiltinSearch::OpenRouter),
        _ => {}
    }
    let host = compat::host_of(&config.api_url)?;
    if host == "api.deepseek.com" {
        Some(BuiltinSearch::DeepSeek)
    } else if host.ends_with("dashscope.aliyuncs.com") || host.ends_with("dashscope-intl.aliyuncs.com") {
        Some(BuiltinSearch::Qwen)
    } else if host == "openrouter.ai" {
        Some(BuiltinSearch::OpenRouter)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SearchPlan {
    Builtin(BuiltinSearch),
    External,
    /// 不联网；带原因码（off 时为空串，那是用户自己选的，不算问题）
    None(&'static str),
}

fn plan_search(mode: &str, builtin: Option<BuiltinSearch>, has_search_key: bool) -> SearchPlan {
    match mode {
        "off" => SearchPlan::None(""),
        "external" => {
            if has_search_key {
                SearchPlan::External
            } else {
                SearchPlan::None("no_search_key")
            }
        }
        // auto 以及任何未知取值
        _ => match builtin {
            Some(kind) => SearchPlan::Builtin(kind),
            None if has_search_key => SearchPlan::External,
            None => SearchPlan::None("no_search_available"),
        },
    }
}

#[derive(Debug, Clone, PartialEq)]
struct SearchHit {
    title: String,
    url: String,
    summary: String,
    date: String,
}

fn is_http_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn parse_search_hits(data: &serde_json::Value) -> Vec<SearchHit> {
    let Some(items) = data.get("results").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let url = item.get("url")?.as_str()?.trim().to_string();
            if !is_http_url(&url) {
                return None;
            }
            let text = |key: &str| item.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            let summary = {
                let long = text("summary");
                if long.is_empty() { text("snippet") } else { long }
            };
            Some(SearchHit {
                title: text("title"),
                url,
                summary,
                date: text("date"),
            })
        })
        .collect()
}

async fn deepseek_search(question: &str, api_key: &str, count: u32) -> Result<Vec<SearchHit>, String> {
    let query = clip_head(question.trim(), SEARCH_QUERY_LIMIT);
    let body = serde_json::json!({
        "query": query,
        "ori_question": query,
        "count": count,
    });
    let start = Instant::now();
    let resp = super::http_client::shared()
        .post(DEEPSEEK_SEARCH_URL)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            diag::fail(
                SEARCH_SCOPE,
                "http_send",
                format!("Search request failed: {}", compat::describe_reqwest_error(&e)),
            )
        })?;
    let status = resp.status();
    let summary = diag::http_summary(status, resp.headers());
    let text = resp
        .text()
        .await
        .map_err(|e| diag::fail(SEARCH_SCOPE, "read_body", format!("Failed to read search response: {}", e)))?;
    if !status.is_success() {
        return Err(diag::fail(
            SEARCH_SCOPE,
            "http_status",
            format!("Search API returned error {} [{}]: {}", status, summary, diag::truncate(&text, 200)),
        ));
    }
    let data: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        diag::fail(
            SEARCH_SCOPE,
            "parse_json",
            format!("Failed to parse search response: {} [{}] {}", e, summary, diag::truncate(&text, 200)),
        )
    })?;
    let hits = parse_search_hits(&data);
    diag::log(
        SEARCH_SCOPE,
        "ok",
        &format!("results={} elapsed_ms={}", hits.len(), start.elapsed().as_millis()),
    );
    Ok(hits)
}

/// user 消息。全部用中性标签包住，理由同 prompt.rs：问题本身常常就是祈使句，
/// 外壳再说一句「请回答」会和它连成一句指令。
fn build_user_content(question: &str, selected_text: &str, today: &str, hits: &[SearchHit]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !today.trim().is_empty() {
        parts.push(format!("<today>{}</today>", escape_xml(&clip_head(today.trim(), 32))));
    }
    let selected = selected_text.trim();
    if !selected.is_empty() {
        parts.push(format!(
            "<selected_text>\n{}\n</selected_text>",
            escape_xml(&clip_head(selected, SELECTED_TEXT_LIMIT))
        ));
    }
    if !hits.is_empty() {
        let mut block = String::from("<search_results>\n");
        for (index, hit) in hits.iter().enumerate() {
            block.push_str(&format!("[{}] {}\n", index + 1, escape_xml(&hit.title)));
            block.push_str(&format!("url: {}\n", escape_xml(&hit.url)));
            if !hit.date.is_empty() {
                block.push_str(&format!("date: {}\n", escape_xml(&hit.date)));
            }
            if !hit.summary.is_empty() {
                block.push_str(&escape_xml(&clip_head(&hit.summary, SEARCH_SUMMARY_LIMIT)));
                block.push('\n');
            }
            block.push('\n');
        }
        block.push_str("</search_results>");
        parts.push(block);
    }
    parts.push(format!("<question>\n{}\n</question>", escape_xml(question.trim())));
    parts.join("\n")
}

/// 从响应里收集来源链接。各家放的位置不同，全看一遍，按 URL 去重。
fn collect_sources(data: Option<&serde_json::Value>, hits: &[SearchHit]) -> Vec<AskSource> {
    let mut out: Vec<AskSource> = Vec::new();
    let mut push = |title: &str, url: &str| {
        let url = url.trim();
        if !is_http_url(url) || out.iter().any(|s| s.url == url) || out.len() >= MAX_SOURCES {
            return;
        }
        let title = title.trim();
        out.push(AskSource {
            title: if title.is_empty() { url.to_string() } else { title.to_string() },
            url: url.to_string(),
        });
    };
    let str_of = |v: &serde_json::Value, key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();

    if let Some(data) = data {
        let message = data.pointer("/choices/0/message");
        // OpenAI 形状的 url_citation 注解：DeepSeek、OpenRouter
        if let Some(items) = message.and_then(|m| m.get("annotations")).and_then(|v| v.as_array()) {
            for item in items {
                if let Some(c) = item.get("url_citation") {
                    push(&str_of(c, "title"), &str_of(c, "url"));
                }
            }
        }
        // DeepSeek：message.server_tool_calls[].calls[].sources[]
        if let Some(steps) = message.and_then(|m| m.get("server_tool_calls")).and_then(|v| v.as_array()) {
            for step in steps {
                for call in step.get("calls").and_then(|v| v.as_array()).into_iter().flatten() {
                    for source in call.get("sources").and_then(|v| v.as_array()).into_iter().flatten() {
                        push(&str_of(source, "title"), &str_of(source, "url"));
                    }
                }
            }
        }
        // 千问 DashScope 原生协议的位置：顶层 search_info.search_results[]（兼容模式实测不返回，留着无害）
        if let Some(items) = data.pointer("/search_info/search_results").and_then(|v| v.as_array()) {
            for item in items {
                push(&str_of(item, "title"), &str_of(item, "url"));
            }
        }
    }
    for hit in hits {
        push(&hit.title, &hit.url);
    }
    out
}

/// 去掉模型常带的 Markdown 装饰。答案卡是纯文本渲染，`**` 和 `#` 会原样露出来。
fn plain_text_answer(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            let heading = trimmed.trim_start_matches('#');
            let line = if heading.len() != trimmed.len() && heading.starts_with(' ') {
                heading.trim_start().to_string()
            } else {
                line.to_string()
            };
            line.replace("**", "").replace("__", "")
        })
        .collect();
    lines.join("\n").trim().to_string()
}

enum ChatOutcome {
    Ok { text: String, data: serde_json::Value },
    /// 带了搜索参数时端点按请求格式拒绝（4xx）。只有这一种值得去掉参数重试。
    Rejected { status: u16 },
    Failed(String),
}

async fn chat_once(
    config: &AiProviderConfig,
    system_prompt: &str,
    user_content: &str,
    extra: Option<&serde_json::Value>,
) -> ChatOutcome {
    let url = format!("{}/chat/completions", compat::normalize_base_url(&config.api_url));
    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0.3,
        "max_tokens": 2048,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content },
        ],
    });
    if let (Some(target), Some(source)) = (body.as_object_mut(), extra.and_then(|e| e.as_object())) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }

    let resp = match compat::send_chat_with_thinking_fallback(&url, config, &body, CHAT_TIMEOUT, SCOPE).await {
        Ok(resp) => resp,
        Err(ChatHttpError::Send(e)) => {
            return ChatOutcome::Failed(diag::fail(
                SCOPE,
                "http_send",
                format!("HTTP request failed: {}", compat::describe_reqwest_error(&e)),
            ))
        }
        Err(ChatHttpError::ReadBody(e)) => {
            return ChatOutcome::Failed(diag::fail(SCOPE, "read_body", format!("Failed to read response: {}", e)))
        }
    };

    if !resp.status.is_success() {
        let status = resp.status.as_u16();
        if extra.is_some() && matches!(status, 400 | 404 | 422) {
            diag::log(
                SCOPE,
                "search_params_rejected",
                &format!("status={} model={} [{}] {}", status, config.model, resp.summary, diag::truncate(&resp.body, 200)),
            );
            return ChatOutcome::Rejected { status };
        }
        return ChatOutcome::Failed(diag::fail(
            SCOPE,
            "http_status",
            format!("API returned error {} [{}]: {}", resp.status, resp.summary, diag::truncate(&resp.body, 200)),
        ));
    }

    let data: serde_json::Value = match serde_json::from_str(&resp.body) {
        Ok(data) => data,
        Err(e) => {
            return ChatOutcome::Failed(diag::fail(
                SCOPE,
                "parse_json",
                format!("Failed to parse response: {} [{}] {}", e, resp.summary, diag::truncate(&resp.body, 200)),
            ))
        }
    };
    // DeepSeek 的联网工具在生成中途出错时状态码仍是 200，错误放在 body.error 里。
    if data.get("error").is_some() && data.get("choices").is_none() {
        return ChatOutcome::Failed(diag::fail(
            SCOPE,
            "body_error",
            format!("API returned an error: {}", diag::truncate(&resp.body, 200)),
        ));
    }
    let text = compat::extract_chat_completion_text(&data)
        .map(|t| plain_text_answer(&compat::strip_thinking(&t)))
        .unwrap_or_default();
    if text.is_empty() {
        diag::empty_result(SCOPE, &format!("model={} [{}] {}", config.model, resp.summary, diag::describe_json(&resp.body)));
        return ChatOutcome::Failed(diag::fail(SCOPE, "empty_output", "The model returned an empty answer".to_string()));
    }
    ChatOutcome::Ok { text, data }
}

async fn ollama_generate(config: &AiProviderConfig, system_prompt: &str, user_content: &str) -> Result<String, String> {
    let url = super::ai_ollama::normalize_url(&config.api_url);
    let model = if config.model.is_empty() { "qwen2.5:7b" } else { config.model.as_str() };
    // /api/generate 只有一个 prompt 字符串，和 ai_ollama::polish 一样手动拼。
    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "prompt": format!("{}\n\n{}", system_prompt, user_content),
    });
    let resp = super::http_client::shared()
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "http_send", format!("Ollama request failed: {}", e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| diag::fail(SCOPE, "read_body", format!("Failed to read response: {}", e)))?;
    if !status.is_success() {
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!("Ollama returned error {}: {}", status, diag::truncate(&text, 200)),
        ));
    }
    let data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| diag::fail(SCOPE, "parse_json", format!("Failed to parse Ollama response: {}", e)))?;
    let answer = plain_text_answer(&compat::strip_thinking(
        data.get("response").and_then(|v| v.as_str()).unwrap_or(""),
    ));
    if answer.is_empty() {
        diag::empty_result(SCOPE, &format!("model={} {}", model, diag::describe_json(&text)));
        return Err(diag::fail(SCOPE, "empty_output", "The model returned an empty answer".to_string()));
    }
    Ok(answer)
}

/// 搜一次；失败或没结果只记原因，不让整次提问失败。
async fn try_external_search(question: &str, api_key: &str) -> (Vec<SearchHit>, &'static str) {
    match deepseek_search(question, api_key, SEARCH_RESULT_COUNT).await {
        Ok(hits) if !hits.is_empty() => (hits, ""),
        Ok(_) => (Vec::new(), "search_empty"),
        Err(_) => (Vec::new(), "search_failed"),
    }
}

pub async fn ask(request: AskRequest) -> Result<AskResult, String> {
    let question = request.question.trim();
    if question.is_empty() {
        return Err(diag::fail(SCOPE, "empty_question", "The question is empty".to_string()));
    }
    let config = &request.ai_config;
    let system_prompt = if request.system_prompt.trim().is_empty() {
        FALLBACK_SYSTEM_PROMPT
    } else {
        request.system_prompt.as_str()
    };
    let search_key = request.search_api_key.trim();
    let builtin = builtin_search_for(config);
    let plan = plan_search(request.search_mode.as_str(), builtin, !search_key.is_empty());
    let start = Instant::now();

    diag::log(
        SCOPE,
        "start",
        &format!(
            "provider={} model={} question_chars={} selected_chars={} search_mode={} plan={:?}",
            config.provider,
            config.model,
            question.chars().count(),
            request.selected_text.trim().chars().count(),
            if request.search_mode.is_empty() { "auto" } else { request.search_mode.as_str() },
            plan,
        ),
    );

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut search_used = "none";
    let mut issue: &'static str = "";
    let mut builtin_kind: Option<BuiltinSearch> = None;
    match plan {
        SearchPlan::External => {
            let (found, why) = try_external_search(question, search_key).await;
            if !found.is_empty() {
                search_used = "external";
            }
            hits = found;
            issue = why;
        }
        // Ollama 不会走到这里（builtin_search_for 对它返回 None）
        SearchPlan::Builtin(kind) => builtin_kind = Some(kind),
        SearchPlan::None(why) => issue = why,
    }

    let (text, data) = if config.provider == "ollama" {
        let user = build_user_content(question, &request.selected_text, &request.today, &hits);
        (ollama_generate(config, system_prompt, &user).await?, None)
    } else {
        let user = build_user_content(question, &request.selected_text, &request.today, &hits);
        let params = builtin_kind.map(BuiltinSearch::params);
        match chat_once(config, system_prompt, &user, params.as_ref()).await {
            ChatOutcome::Ok { text, data } => {
                if builtin_kind.is_some() {
                    search_used = "builtin";
                }
                (text, Some(data))
            }
            ChatOutcome::Failed(message) => return Err(message),
            ChatOutcome::Rejected { status } => {
                // 自带搜索参数被拒：去掉参数重答。有搜索密钥就先用搜索接口补上联网。
                issue = "builtin_rejected";
                diag::log(
                    SCOPE,
                    "builtin_search_fallback",
                    &format!("status={} kind={} has_search_key={}", status, builtin_kind.map(|k| k.id()).unwrap_or(""), !search_key.is_empty()),
                );
                if !search_key.is_empty() {
                    let (found, why) = try_external_search(question, search_key).await;
                    if !found.is_empty() {
                        search_used = "external";
                        issue = "";
                    } else {
                        issue = why;
                    }
                    hits = found;
                }
                let user = build_user_content(question, &request.selected_text, &request.today, &hits);
                match chat_once(config, system_prompt, &user, None).await {
                    ChatOutcome::Ok { text, data } => (text, Some(data)),
                    ChatOutcome::Failed(message) => return Err(message),
                    ChatOutcome::Rejected { status } => {
                        return Err(diag::fail(SCOPE, "http_status", format!("API returned error {}", status)))
                    }
                }
            }
        }
    };

    let sources = collect_sources(data.as_ref(), &hits);
    let elapsed_ms = start.elapsed().as_millis() as u64;
    diag::log(
        SCOPE,
        "ok",
        &format!(
            "elapsed_ms={} answer_chars={} search={} issue={} sources={}",
            elapsed_ms,
            text.chars().count(),
            search_used,
            if issue.is_empty() { "-" } else { issue },
            sources.len(),
        ),
    );
    Ok(AskResult {
        text,
        sources,
        search: search_used.to_string(),
        search_issue: issue.to_string(),
        elapsed_ms,
    })
}

/// 设置页用：这份配置能不能用自带搜索。返回 deepseek / qwen / zhipu / openrouter，不能则空串。
pub fn builtin_search_id(config: &AiProviderConfig) -> String {
    builtin_search_for(config).map(|k| k.id().to_string()).unwrap_or_default()
}

/// 设置页的「测试」按钮：用这把密钥搜一次。
pub async fn test_search(api_key: &str) -> Result<usize, String> {
    if api_key.trim().is_empty() {
        return Err(diag::fail(SEARCH_SCOPE, "no_key", "Search API key is empty".to_string()));
    }
    deepseek_search("SayIt voice input", api_key, 1).await.map(|hits| hits.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str, api_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: provider.to_string(),
            api_url: api_url.to_string(),
            api_key: "sk-test".to_string(),
            model: "m".to_string(),
            extra: serde_json::Value::Null,
        }
    }

    #[test]
    fn builtin_search_is_recognized_by_card_and_by_official_host() {
        assert_eq!(builtin_search_for(&config("deepseek", "https://relay.example/v1")), Some(BuiltinSearch::DeepSeek));
        assert_eq!(builtin_search_for(&config("openai_compat", "https://api.deepseek.com")), Some(BuiltinSearch::DeepSeek));
        assert_eq!(
            builtin_search_for(&config("openai_compat", "https://dashscope.aliyuncs.com/compatible-mode/v1")),
            Some(BuiltinSearch::Qwen)
        );
        assert_eq!(builtin_search_for(&config("openai_compat", "https://openrouter.ai/api/v1")), Some(BuiltinSearch::OpenRouter));
        // 智谱实测搜不了（见 BuiltinSearch::params 的说明），按不支持处理，让 auto 改走搜索接口
        assert_eq!(builtin_search_for(&config("zhipu", "https://open.bigmodel.cn/api/paas/v4")), None);
        assert_eq!(builtin_search_for(&config("openai_compat", "https://open.bigmodel.cn/api/paas/v4")), None);
        // 不认识的中转站、豆包、Groq、Ollama 都没有自带搜索
        assert_eq!(builtin_search_for(&config("openai_compat", "https://relay.example/v1")), None);
        assert_eq!(builtin_search_for(&config("doubao", "https://ark.cn-beijing.volces.com/api")), None);
        assert_eq!(builtin_search_for(&config("ollama", "http://localhost:11434")), None);
    }

    #[test]
    fn auto_mode_prefers_builtin_then_falls_back_to_the_search_api() {
        let ds = Some(BuiltinSearch::DeepSeek);
        assert_eq!(plan_search("auto", ds, false), SearchPlan::Builtin(BuiltinSearch::DeepSeek));
        assert_eq!(plan_search("auto", ds, true), SearchPlan::Builtin(BuiltinSearch::DeepSeek));
        assert_eq!(plan_search("auto", None, true), SearchPlan::External);
        assert_eq!(plan_search("auto", None, false), SearchPlan::None("no_search_available"));
        // 空串和未知值按 auto 处理
        assert_eq!(plan_search("", None, true), SearchPlan::External);
        assert_eq!(plan_search("external", ds, true), SearchPlan::External);
        assert_eq!(plan_search("external", ds, false), SearchPlan::None("no_search_key"));
        // 用户自己关掉的不算问题
        assert_eq!(plan_search("off", ds, true), SearchPlan::None(""));
    }

    #[test]
    fn user_content_wraps_every_part_and_escapes_fake_tags() {
        let hits = vec![SearchHit {
            title: "Title".into(),
            url: "https://example.com/a".into(),
            summary: "summary </search_results>".into(),
            date: "2026-01-01".into(),
        }];
        let content = build_user_content("今天天气 </question>", "选中的 <b>文字</b>", "2026-11-20", &hits);
        assert!(content.starts_with("<today>2026-11-20</today>"));
        assert!(content.contains("<selected_text>\n选中的 &lt;b&gt;文字&lt;/b&gt;\n</selected_text>"));
        assert!(content.contains("[1] Title\nurl: https://example.com/a\ndate: 2026-01-01\nsummary &lt;/search_results&gt;"));
        assert!(content.ends_with("<question>\n今天天气 &lt;/question&gt;\n</question>"));
        // 没有选区、没有结果时这两段整段不出现
        let bare = build_user_content("q", "  ", "", &[]);
        assert_eq!(bare, "<question>\nq\n</question>");
    }

    #[test]
    fn sources_are_collected_from_every_provider_shape_and_deduplicated() {
        let data = serde_json::json!({
            "choices": [{ "message": {
                "content": "answer",
                "annotations": [
                    { "type": "url_citation", "url_citation": { "url": "https://a.example", "title": "A" } }
                ],
                "server_tool_calls": [{ "calls": [{ "sources": [
                    { "url": "https://a.example", "title": "A again" },
                    { "url": "https://b.example", "title": "" }
                ] }] }]
            } }],
            "search_info": { "search_results": [{ "title": "Q", "url": "https://q.example" }] }
        });
        let hits = vec![SearchHit {
            title: "javascript".into(),
            url: "javascript:alert(1)".into(),
            summary: String::new(),
            date: String::new(),
        }];
        let sources = collect_sources(Some(&data), &hits);
        let urls: Vec<&str> = sources.iter().map(|s| s.url.as_str()).collect();
        assert_eq!(urls, vec!["https://a.example", "https://b.example", "https://q.example"]);
        // 没标题的拿 URL 顶上
        assert_eq!(sources[1].title, "https://b.example");
    }

    #[test]
    fn search_hits_prefer_the_long_summary_and_skip_non_http_urls() {
        let data = serde_json::json!({ "results": [
            { "title": "T", "url": "https://x.example", "snippet": "short", "summary": "long", "date": null },
            { "title": "S", "url": "https://y.example", "snippet": "short only" },
            { "title": "bad", "url": "ftp://z.example" }
        ] });
        let hits = parse_search_hits(&data);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].summary, "long");
        assert_eq!(hits[1].summary, "short only");
        assert_eq!(hits[0].date, "");
    }

    #[test]
    fn markdown_decoration_is_removed_from_answers() {
        assert_eq!(plain_text_answer("## 结论\n这是 **重点**。\n#hashtag 保留"), "结论\n这是 重点。\n#hashtag 保留");
    }
}
