// OpenAI 兼容 AI 供应商
// 覆盖所有支持 /v1/chat/completions 的服务：DeepSeek、通义、豆包（火山方舟）等

use super::diag;
use super::prompt::wrap_user_text;
use super::types::{AiProviderConfig, AiResult, TestResult, TextContext};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const SCOPE: &str = "ai/openai-compat";

/// 共享客户端（带 User-Agent，缺了会被 nginx/WAF 网关拦成 403，见 `http_client`）
fn http() -> &'static reqwest::Client {
    super::http_client::shared()
}

/// 一份「通吃」的关闭思考参数。
///
/// 为什么是四个字段一起发，而不是按供应商挑一个：关闭思考的写法没有任何统一标准
/// （`enable_thinking` / `thinking.type` / `reasoning.effort` / 顶层 `reasoning_effort`），
/// 字段名、嵌套层级、取值各家都不同，而且新模型新格式一直在出。逐一适配意味着每出一家
/// 就要发一次版，永远追不完 —— 智谱现在只能靠硬编码官方域名识别就是这个成本的证据，
/// 用户换个反代域名那行就失效。
///
/// 而 OpenAI 兼容服务对**不认识的顶层字段基本是忽略**，所以一次全发、谁认哪个哪个生效，
/// 是覆盖面和维护成本都最划算的做法。少数严格的端点会因此返回 400，那条路由
/// `send_chat_with_thinking_fallback` 自动降级兜住。
fn disable_thinking_overrides() -> serde_json::Value {
    serde_json::json!({
        "enable_thinking": false,
        "thinking": { "type": "disabled" },
        "reasoning": { "effort": "none" },
        "reasoning_effort": "none",
    })
}

/// 决定这次请求该注入哪些关闭思考的字段。`None` = 一个字段都不发。
///
/// 三档，从窄到宽：
///   1. 已知供应商沿用各自**精确**的那一个字段。这些组合是实测通过的，不要顺手升级成
///      通吃集合 —— 多注入未知字段只会给本来好用的路径引入 400 风险。
///   2. OpenAI 官方与 Azure OpenAI **显式排除**。它们对未知顶层参数直接回 400
///      （`Unrecognized request argument supplied`），而且连自家 `reasoning_effort` 的合法
///      取值都依模型而异（老 GPT-5 认 `minimal`，新的只认 `none`，非推理模型两个都不认），
///      猜不准。这两家真需要控制思考强度时走用户自定义参数，不由我们替它猜。
///   3. 其余一切端点（自定义 OpenAI 兼容、聚合网关、豆包、Groq…）发通吃集合。
///      这一档才是这个函数存在的理由：在此之前它们一个字段都不发，用户接一个默认思考的
///      模型，我们没有任何手段让它别想 —— 语音输入场景下那几秒延迟是纯亏损。
fn thinking_overrides(config: &AiProviderConfig) -> Option<serde_json::Value> {
    // 通义千问 Qwen3 使用独立的开关。
    if config.provider == "qwen" {
        return Some(serde_json::json!({ "enable_thinking": false }));
    }

    // 已知「始终思考」的模型直接发最低强度那套，别先发一次注定被拒的 disabled。
    // 放在最前面：它是按**模型**判的，比下面那些按供应商判的更具体。
    if model_forces_thinking(&config.model) {
        return Some(forced_thinking_overrides());
    }

    // DeepSeek、小米 MiMo 和智谱 GLM 使用 thinking.type=disabled。
    // 智谱与 DeepSeek 两条都认：provider 是内置卡，域名判断留给「用 OpenAI 兼容自己填
    // 官方地址」的配置（这种存量配置不会因为有了内置卡而自动迁移）。
    //
    // DeepSeek 的 deepseek-flash **默认开思考**（2026-11 实测：不带参数时 64 个 token
    // 全花在思维链上，正文为空）。通吃那四个字段它今天也认，但 `reasoning_effort: "none"`
    // 不在它文档列出的取值里，哪天收紧校验就是 400、每次会话多一趟降级往返。
    // 它文档写明的开关只有 thinking.type 这一个。
    if config.provider == "deepseek"
        || config.provider == "mimo"
        || config.provider == "zhipu"
        || is_zhipu_api_url(&config.api_url)
        || is_deepseek_api_url(&config.api_url)
    {
        return Some(serde_json::json!({ "thinking": { "type": "disabled" } }));
    }

    if is_strict_openai_host(&config.api_url) {
        return None;
    }

    Some(disable_thinking_overrides())
}

fn host_of(api_url: &str) -> Option<String> {
    reqwest::Url::parse(api_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
}

fn is_zhipu_api_url(api_url: &str) -> bool {
    host_of(api_url).is_some_and(|host| host == "open.bigmodel.cn")
}

fn is_deepseek_api_url(api_url: &str) -> bool {
    host_of(api_url).is_some_and(|host| host == "api.deepseek.com")
}

/// OpenAI 官方 / Azure OpenAI —— 对未知请求字段一律 400 的那一类端点。
fn is_strict_openai_host(api_url: &str) -> bool {
    host_of(api_url).is_some_and(|host| {
        host == "api.openai.com"
            || host.ends_with(".openai.azure.com")
            || host.ends_with(".cognitiveservices.azure.com")
    })
}

/// 把 overrides 合并进请求体。顶层同名字段**整体覆盖**，不做深合并 —— 深合并会让
/// 两种风格的参数混出谁也说不清的结果。
fn merge_overrides(body: &mut serde_json::Value, overrides: &serde_json::Value) {
    let (Some(target), Some(source)) = (body.as_object_mut(), overrides.as_object()) else {
        return;
    };
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
}

/// 记住「这个端点该发哪套思考参数」的进程内结论。
///
/// 值是**降级后真正用的那套参数**，`None` 表示一个字段都别发。以前这里是
/// `HashSet<端点>`，语义只有「拒绝思考参数」一种 —— 而强制思考的模型需要的不是
/// 「什么都不发」，是「发一套更轻的」，一个布尔存不下这个区别
/// （见 `forced_thinking_overrides` 的说明）。
///
/// 只放内存、不落盘：一次进程生命周期内够用，而端点行为会随供应商升级变化，
/// 持久化反而会把一条过期结论永久钉住。key 带上模型名是因为这类拒绝是按模型判的，
/// 同一网关换个模型结论可能不同。
fn thinking_memo() -> &'static Mutex<HashMap<String, Option<serde_json::Value>>> {
    static MEMO: OnceLock<Mutex<HashMap<String, Option<serde_json::Value>>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn endpoint_key(config: &AiProviderConfig) -> String {
    let host = host_of(&config.api_url).unwrap_or_else(|| config.api_url.trim().to_string());
    format!("{}|{}", host, config.model)
}

/// 之前降级过吗？`Some(params)` 是那次成功的参数（内层 `None` = 一个字段都不发）。
fn remembered_thinking(config: &AiProviderConfig) -> Option<Option<serde_json::Value>> {
    thinking_memo()
        .lock()
        .ok()
        .and_then(|memo| memo.get(&endpoint_key(config)).cloned())
}

fn remember_thinking(config: &AiProviderConfig, overrides: Option<serde_json::Value>) {
    if let Ok(mut memo) = thinking_memo().lock() {
        memo.insert(endpoint_key(config), overrides);
    }
}

/// 「强制思考」模型该发的参数：思考开着，但用最低强度。
///
/// 为什么不能像别的端点那样直接把参数全去掉：这类模型**没有不思考这一档**，
/// 去掉参数等于用它的默认强度，而智谱 GLM-5.3 的默认是 `reasoning_effort=max`
/// （深度推理）—— 对语音输入来说那是最差的结果，比不降级还慢。官方给的迁移写法
/// 正是把 `disabled` 换成 `enabled` + `reasoning_effort: "low"`。
fn forced_thinking_overrides() -> serde_json::Value {
    serde_json::json!({
        "thinking": { "type": "enabled" },
        "reasoning_effort": "low"
    })
}

/// 模型名一眼能认出「始终思考」的那几个。
///
/// 只为省掉一次注定失败的往返（否则用户在设置页点「测试」会先吃一个 400）。
/// 这个名单一定会过期，所以它不是唯一防线 —— 真正兜底的是 `forced_thinking_error`
/// 那条按响应内容判定的路径，将来新出的强制思考模型走那条也能自愈。
fn model_forces_thinking(model: &str) -> bool {
    // glm-5.3 / glm-5.3-flash / glm-5.3-xxx 都算
    model.trim().to_ascii_lowercase().starts_with("glm-5.3")
}

/// 这个错误是不是在说「本模型不能关思考，请改用强度档位」。
///
/// 智谱的原文是纯中文 + 一个错误码：
/// `{"error":{"code":"1210","message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}}`
///
/// **`thinking` 这个词一次都没出现** —— 这正是旧判据（"响应体里有没有我们注入的键名"）
/// 对它完全失效的原因：判据没命中 → 降级不执行 → 400 原样报给用户，界面上就是
/// 「连接失败」。所以这里必须按语义匹配，不能只认字段名。
fn forced_thinking_error(body: &str) -> bool {
    // 智谱的错误码，最稳的一条
    if body.contains("\"1210\"") || body.contains("\"code\":1210") {
        return true;
    }
    // 中文原文（措辞可能随版本微调，取两个最稳的片段）
    if body.contains("始终思考") || body.contains("不支持关闭思考") {
        return true;
    }
    // 英文/其它网关的等价说法
    let lower = body.to_ascii_lowercase();
    lower.contains("does not support disabling thinking")
        || lower.contains("thinking cannot be disabled")
        || (lower.contains("reasoning_effort") && lower.contains("low"))
}

/// 这个 400 是不是我们注入的思考参数引起的 —— 返回被点名的那个字段名。
///
/// 判定刻意保守：**只有响应体里出现了我们实际注入的键名**才算。密钥错、模型不存在这些
/// 400 绝不能触发降级重试，否则每次请求都要白发两遍。
/// 供应商用自然语言描述、完全不提字段名的那一类，由 `forced_thinking_error` 单独认。
fn rejected_thinking_field(body: &str, overrides: &serde_json::Value) -> Option<String> {
    let object = overrides.as_object()?;
    object
        .keys()
        .find(|key| body.contains(key.as_str()))
        .cloned()
}

/// 一次 chat/completions 往返的结果。响应体在这里就读完，调用方不必再和 `resp` 的
/// 所有权打交道 —— 摘要必须在读 body 之前取（读 body 会消费掉 resp）。
struct ChatHttpResponse {
    status: reqwest::StatusCode,
    summary: String,
    body: String,
}

/// 发送失败和读响应体失败要分开报：前者是网络/DNS/TLS，后者是连接中途断了，
/// 归成同一条日志会让排查时分不清该查哪一边。
enum ChatHttpError {
    Send(reqwest::Error),
    ReadBody(reqwest::Error),
}

async fn send_chat_once(
    url: &str,
    config: &AiProviderConfig,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<ChatHttpResponse, ChatHttpError> {
    let mut req = http()
        .post(url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json");
    // 小米 MiMo 规范鉴权头为 api-key（同时兼容 Bearer），两个都带最稳妥
    if config.provider == "mimo" {
        req = req.header("api-key", config.api_key.clone());
    }

    let resp = req
        .json(body)
        .timeout(timeout)
        .send()
        .await
        .map_err(ChatHttpError::Send)?;

    let status = resp.status();
    let summary = diag::http_summary(status, resp.headers());
    let body = resp.text().await.map_err(ChatHttpError::ReadBody)?;

    Ok(ChatHttpResponse {
        status,
        summary,
        body,
    })
}

/// 带关闭思考参数发一次；被端点拒绝就去掉参数重试一次，并记住这个结论。
///
/// 为什么要自动降级而不是让用户去设置里勾一个开关：语音输入的立场是「越快越好」，
/// 模型偷偷思考带来的几秒延迟是纯亏损，本来就不该等用户自己发现再去翻设置。代价是
/// 严格端点首次会多一次往返（400 一般是网关层秒回，约多 0.3~1 秒），之后命中缓存不再发生。
///
/// 校对和「测试连接」共用这一条：用户在设置页点过测试，结论就已经缓存好了，
/// 正式校对时直接命中 —— 那次多出来的往返基本落在测试上，用户感知不到。
/// 顺带也保证了「测试通了」和「实际请求」用的是同一组参数。
async fn send_chat_with_thinking_fallback(
    url: &str,
    config: &AiProviderConfig,
    base_body: &serde_json::Value,
    timeout: Duration,
    scope: &str,
) -> Result<ChatHttpResponse, ChatHttpError> {
    // 之前降级过就直接用那次的结论，不再重复撞墙
    let overrides = match remembered_thinking(config) {
        Some(remembered) => remembered,
        None => thinking_overrides(config),
    };

    let Some(overrides) = overrides else {
        return send_chat_once(url, config, base_body, timeout).await;
    };

    let mut body = base_body.clone();
    merge_overrides(&mut body, &overrides);
    let resp = send_chat_once(url, config, &body, timeout).await?;

    if resp.status.is_success() {
        return Ok(resp);
    }

    // 不限定状态码：多数端点回 400，也见过网关把参数校验失败报成 500
    // （见 pitfalls「max_tokens 下限」那条）。真正的把关是下面这两句 —— 必须有一条
    // 明确信号指向思考参数，否则密钥错、模型不存在这些 400 会被白重试一遍。
    //
    // 两种信号分别对应两种降级目标：
    //   · 「这个模型不能关思考」→ 换成最低强度（去掉参数会落到 max，反而更慢）
    //   · 「不认识这个字段」    → 一个都不发
    let (fallback, reason) = if forced_thinking_error(&resp.body) {
        (Some(forced_thinking_overrides()), "forced_thinking".to_string())
    } else if let Some(field) = rejected_thinking_field(&resp.body, &overrides) {
        (None, format!("unknown_field={}", field))
    } else {
        return Ok(resp);
    };

    // 已经在发最低强度那套了还被拒，就别再原地重试同一份
    if fallback.as_ref() == Some(&overrides) {
        return Ok(resp);
    }

    diag::log(
        scope,
        "thinking_params_rejected",
        &format!(
            "Endpoint rejected our thinking parameters; retrying with fallback reason={} fallback={} status={} model={}",
            reason,
            if fallback.is_some() { "low_effort" } else { "none" },
            resp.status.as_u16(),
            config.model
        ),
    );

    let retried = match &fallback {
        Some(params) => {
            let mut body = base_body.clone();
            merge_overrides(&mut body, params);
            send_chat_once(url, config, &body, timeout).await?
        }
        None => send_chat_once(url, config, base_body, timeout).await?,
    };

    // 只在降级真的成功时才记住它。失败还记的话会把一条错结论钉在这个端点上，
    // 后面每次请求都按错的那套发（而真正的原因可能只是密钥错）。
    if retried.status.is_success() {
        remember_thinking(config, fallback);
    }

    Ok(retried)
}

/// 调用 OpenAI 兼容接口进行文本校对
pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
    text_context: Option<&TextContext>,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let sys_prompt = system_prompt.unwrap_or("你是语音转文本的校对助手。");
    let user_content = wrap_user_text(text, text_context);

    // 思考参数不写在这里：由 send_chat_with_thinking_fallback 合并进来，
    // 这样被端点拒绝时它手上还有一份「干净的 body」可以直接重试。
    let base_body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_content },
        ]
    });

    let start = Instant::now();

    // 只记长度和模型，不记待校对的文本本身
    diag::log(
        SCOPE,
        "start",
        &format!(
            "provider={} model={} chars={} url={}",
            config.provider,
            config.model,
            text.chars().count(),
            url
        ),
    );

    let resp = send_chat_with_thinking_fallback(
        &url,
        config,
        &base_body,
        Duration::from_secs(60),
        SCOPE,
    )
    .await
    .map_err(|e| match e {
        ChatHttpError::Send(e) => diag::fail(
            SCOPE,
            "http_send",
            format!("HTTP request failed: {}", describe_reqwest_error(&e)),
        ),
        ChatHttpError::ReadBody(e) => diag::fail(
            SCOPE,
            "read_body",
            format!("Failed to read response: {}", e),
        ),
    })?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let ChatHttpResponse {
        status,
        summary: http_summary,
        body: body_text,
    } = resp;

    if !status.is_success() {
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "API returned error {} [{}]: {}",
                status,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        ));
    }

    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            SCOPE,
            "parse_json",
            format!(
                "Failed to parse response: {} [{}] response excerpt: {}",
                e,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    // 取不到内容就回落成原文。这是**静默失败**：用户看到有字、以为校对生效了，
    // 实际上 AI 那一步等于没跑。必须留证，否则「AI 好像没起作用」永远查不下去。
    let result_text = match extract_chat_completion_text(&data) {
        Some(t) => t,
        None => {
            diag::log(
                SCOPE,
                "no_content_fallback_to_input",
                &format!(
                    "Response contained no usable content; returned the original text [{}] {}",
                    http_summary,
                    diag::describe_json(&body_text)
                ),
            );
            text.to_string()
        }
    };

    // 去除 <think>...</think> 标签（部分模型如 Qwen3 会输出思考过程）
    let cleaned = strip_thinking(&result_text);

    if cleaned.is_empty() {
        diag::log(
            SCOPE,
            "empty_after_strip_thinking",
            &format!(
                "Output was empty after removing the reasoning block; returned the original text model={} raw_chars={}",
                config.model,
                result_text.chars().count()
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, cleaned.chars().count());
    }

    Ok(AiResult {
        text: if cleaned.is_empty() {
            text.to_string()
        } else {
            cleaned
        },
        elapsed_ms,
    })
}

/// 测试 AI 连接 — 发送一个简短的聊天请求，验证地址、Key、模型是否都可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let base_url = normalize_base_url(&config.api_url);
    let url = format!("{}/chat/completions", base_url);

    let system_prompt = "Reply with OK only. Do not output anything else.";
    let user_prompt = "Connection test";

    // max_tokens 不能贴着 "OK" 两个字省：
    //   1) 有网关直接规定下限 —— 实测某内网 LiteLLM 网关上的 gpt-5 系模型给 10 会返回
    //      HTTP 500 `integer_below_min_value ... Expected a value >= 16`，看起来像服务坏了，
    //      其实是我们把上限压得太低；
    //   2) 推理型模型会先花掉一部分 output token 想事情，额度太小时 content 是空的，
    //      测试就会显示「连接成功，回复：(空)」，等于白测。
    // 曾经是 64。改成 512 是因为**强制思考的模型**（智谱 GLM-5.3 那一档）连最低强度
    // 也要先想一轮，64 个 token 基本全花在 reasoning 上、content 什么都不剩 ——
    // 那种「连上了但回复是空的」比报错更难判断。max_tokens 只是上限，不按它计费。
    let base_body = serde_json::json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 512,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });

    let start = Instant::now();

    // 走和校对完全相同的这一条：测试通了就意味着实际校对用的参数也通，
    // 而且「该端点接不接受思考参数」的结论在这里就缓存好了，校对时不必再撞一次。
    let result = send_chat_with_thinking_fallback(
        &url,
        config,
        &base_body,
        Duration::from_secs(30),
        "ai/openai-compat-test",
    )
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status.is_success() => {
            let data: serde_json::Value =
                serde_json::from_str(&resp.body).unwrap_or(serde_json::Value::Null);
            let raw_reply = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let reply = strip_thinking(&raw_reply);
            let detail = format!(
                "Elapsed: {}ms\nModel: {}\nSent: system=\"{}\" user=\"{}\"\nReply: {}",
                elapsed_ms,
                config.model,
                system_prompt,
                user_prompt,
                if reply.is_empty() { "(empty)" } else { &reply }
            );
            TestResult {
                ok: true,
                message: format!("Connection successful ({}ms)", elapsed_ms),
                elapsed_ms,
                detail,
            }
        }
        Ok(resp) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "http_status",
                format!(
                    "API returned {} [{}]: {}",
                    resp.status,
                    resp.summary,
                    diag::truncate(&resp.body, 100)
                ),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
        Err(ChatHttpError::Send(e)) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "http_send",
                format!("Connection failed: {}", describe_reqwest_error(&e)),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
        Err(ChatHttpError::ReadBody(e)) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "read_body",
                format!("Failed to read response: {}", e),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
    }
}

/// Convert reqwest errors into concise diagnostic details.
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let raw = format!("{}", e);
    if e.is_timeout() {
        return "Request timed out; check the network connection and API URL".to_string();
    }
    if e.is_connect() {
        // 尝试区分 DNS / TLS / 连接拒绝
        let lower = raw.to_lowercase();
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("getaddrinfo") {
            return format!(
                "DNS lookup failed; the host may not exist or the network may be unavailable: {}",
                raw
            );
        }
        if lower.contains("ssl")
            || lower.contains("tls")
            || lower.contains("certificate")
            || lower.contains("handshake")
            || lower.contains("schannel")
        {
            return format!("TLS/SSL handshake failed; check the certificate: {}", raw);
        }
        if lower.contains("refused") {
            return format!(
                "Connection refused; the service may not be running: {}",
                raw
            );
        }
        return format!("Could not connect to the server: {}", raw);
    }
    raw
}

/// 规范化 base URL
fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    // 用户把文档里的**完整端点**整条粘进来是最常见的填法 —— 各家文档（智谱、DeepSeek、
    // 硅基流动…）示例里给的都是 `.../chat/completions`，而这一栏要的是它前面那一截。
    // 不剥掉的话下面会再拼一次，得到 `.../chat/completions/v1/chat/completions` 然后 404，
    // 而 404 的响应体只说路径不存在，用户完全看不出是自己多填了一段。
    // ASR 那条路早就这么处理了（asr_openai_chat_audio.rs 的 chat_completions_url）。
    let trimmed = trimmed
        .strip_suffix("/chat/completions")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    let has_version_suffix = trimmed
        .rsplit('/')
        .next()
        .and_then(|segment| segment.strip_prefix('v'))
        .is_some_and(|version| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()));

    // 已经以 /v1、/v3、/v4 等版本路径结尾时直接使用
    if has_version_suffix {
        trimmed.to_string()
    } else if trimmed.ends_with("/api") {
        // 豆包等：https://ark.cn-beijing.volces.com/api → 加 /v3
        format!("{}/v3", trimmed)
    } else {
        format!("{}/v1", trimmed)
    }
}

/// 从 chat completion 响应中提取文本
fn extract_chat_completion_text(data: &serde_json::Value) -> Option<String> {
    let content = data
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;

    match content {
        serde_json::Value::String(s) => Some(s.trim().to_string()),
        serde_json::Value::Array(arr) => {
            let text: String = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            Some(text.trim().to_string())
        }
        _ => None,
    }
}

/// 去除 <think>...</think> 标签
fn strip_thinking(text: &str) -> String {
    let re = regex::Regex::new(r"(?is)<think>.*?</think>").unwrap_or_else(|_| {
        // fallback: 不做处理
        regex::Regex::new(r"^$").unwrap()
    });
    let cleaned = re.replace_all(text, "");
    let cleaned = cleaned.trim();

    // 如果有"最终答案"标记，取其后面的内容
    if let Some(pos) = cleaned.find("最终答案") {
        let after = &cleaned[pos + "最终答案".len()..];
        let after = after.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace());
        return after.trim().to_string();
    }

    cleaned.to_string()
}
#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str, api_url: &str, model: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: provider.to_string(),
            api_url: api_url.to_string(),
            api_key: "sk-test".to_string(),
            model: model.to_string(),
            extra: serde_json::Value::Null,
        }
    }

    fn keys(value: &serde_json::Value) -> Vec<String> {
        let mut out: Vec<String> = value
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        out.sort();
        out
    }

    #[test]
    fn known_providers_keep_their_exact_field() {
        // 这些组合是实测通过的，别顺手升级成通吃集合——多注入未知字段只会给
        // 本来好用的路径引入 400 风险。
        let qwen = thinking_overrides(&config(
            "qwen",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "qwen-plus",
        ))
        .expect("qwen should disable thinking");
        assert_eq!(keys(&qwen), vec!["enable_thinking"]);
        assert_eq!(qwen["enable_thinking"], serde_json::json!(false));

        for provider in ["deepseek", "mimo"] {
            let overrides = thinking_overrides(&config(provider, "https://example.com/v1", "m"))
                .expect("should disable thinking");
            assert_eq!(keys(&overrides), vec!["thinking"]);
            assert_eq!(overrides["thinking"]["type"], serde_json::json!("disabled"));
        }

        // 智谱走通用 provider，只能靠官方域名识别
        let zhipu = thinking_overrides(&config(
            "openai_compat",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-4",
        ))
        .expect("zhipu should disable thinking");
        assert_eq!(keys(&zhipu), vec!["thinking"]);
    }

    /// 用户手填地址的几种真实形态都要落到同一个端点上。
    ///
    /// 智谱那几条是照 B 站反馈复现的：用户填 `.../api/paas/v4` 曾经被补成 `/v4/v1`
    /// （已修），填 `.../api/paas` 会被补成 `/api/paas/v1`，而把文档里的完整端点
    /// 整条粘进来会被再拼一次。三种都返回 404，而 404 只说路径不存在。
    #[test]
    fn normalizes_user_typed_base_urls() {
        let cases = [
            // 智谱：版本段是 /v4，必须原样保留
            ("https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/paas/v4"),
            ("https://open.bigmodel.cn/api/paas/v4/", "https://open.bigmodel.cn/api/paas/v4"),
            // 文档里给的完整端点，整条粘进来
            (
                "https://open.bigmodel.cn/api/paas/v4/chat/completions",
                "https://open.bigmodel.cn/api/paas/v4",
            ),
            ("https://api.deepseek.com/v1/chat/completions", "https://api.deepseek.com/v1"),
            // 只给主机名 → 补 /v1（OpenAI 的形状）
            ("https://api.deepseek.com", "https://api.deepseek.com/v1"),
            // 豆包：以 /api 结尾的补 /v3
            (
                "https://ark.cn-beijing.volces.com/api",
                "https://ark.cn-beijing.volces.com/api/v3",
            ),
            // 已带 /v1 的原样保留（Groq、MiMo 的默认地址就是这个形状）
            ("https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_base_url(input), expected, "input={}", input);
        }
    }

    /// 智谱的 `thinking.type=disabled` 两条路都要认：内置卡靠 provider，
    /// 「OpenAI 兼容 + 自己填智谱地址」的存量配置靠域名（那种配置不会自动迁移）。
    #[test]
    fn zhipu_disables_thinking_via_provider_and_via_host() {
        let by_provider = thinking_overrides(&config(
            "zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-4.7-flash",
        ))
        .expect("zhipu card should disable thinking");
        assert_eq!(keys(&by_provider), vec!["thinking"]);
        assert_eq!(by_provider["thinking"]["type"], serde_json::json!("disabled"));

        // 存量配置：provider 还是 openai_compat，只能靠域名认出来
        let by_host = thinking_overrides(&config(
            "openai_compat",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-4.7-flash",
        ))
        .expect("legacy zhipu config should disable thinking");
        assert_eq!(keys(&by_host), vec!["thinking"]);

        // 内置卡即便被改成中转地址（域名对不上）也仍然按智谱的字段发
        let relayed = thinking_overrides(&config("zhipu", "https://relay.example/v4", "glm-4.7"))
            .expect("relayed zhipu card should still disable thinking");
        assert_eq!(keys(&relayed), vec!["thinking"]);
    }

    /// 「OpenAI 兼容」卡填 DeepSeek 官方地址时，发它文档写明的那一个字段，不发通吃集合。
    /// 中转站（域名不是 api.deepseek.com）不知道对面是谁，仍然走通吃集合。
    #[test]
    fn deepseek_host_on_the_compat_card_gets_its_exact_field() {
        for url in ["https://api.deepseek.com", "https://api.deepseek.com/v1"] {
            let overrides = thinking_overrides(&config("openai_compat", url, "deepseek-flash"))
                .expect("deepseek host should disable thinking");
            assert_eq!(keys(&overrides), vec!["thinking"], "{url}");
            assert_eq!(overrides["thinking"]["type"], serde_json::json!("disabled"));
        }
        let relay = thinking_overrides(&config(
            "openai_compat",
            "https://relay.example.com/v1",
            "deepseek-flash",
        ))
        .expect("relay should still get thinking params");
        assert_eq!(keys(&relay).len(), 4);
    }

    /// 智谱 GLM-5.3 的真实错误体（2026-09-20 用户实测）。
    ///
    /// 它是这条链路上最有教育意义的一个样本：**整条消息里没有 "thinking" 这个词**，
    /// 所以旧判据（响应体里有没有我们注入的键名）一次都不命中 —— 降级不执行、
    /// 400 原样抛给用户、界面显示「连接失败」。这条测试就是钉住"按语义认"这件事。
    const ZHIPU_5_3_FORCED: &str =
        r#"{"error":{"code":"1210","message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。"}}"#;

    #[test]
    fn zhipu_forced_thinking_error_is_recognized_without_the_word_thinking() {
        // 先确认前提：这个错误体确实不含 "thinking"，否则这条测试证明不了什么
        assert!(
            !ZHIPU_5_3_FORCED.to_ascii_lowercase().contains("thinking"),
            "样本里出现了 thinking，这条测试的前提不成立了，请换一个真实样本"
        );
        // 旧判据对它无效 —— 这就是用户看到「连接失败」的直接原因
        let old_signal = rejected_thinking_field(
            ZHIPU_5_3_FORCED,
            &serde_json::json!({ "thinking": { "type": "disabled" } }),
        );
        assert!(old_signal.is_none(), "旧判据本来就认不出它");
        // 新判据必须认出来
        assert!(forced_thinking_error(ZHIPU_5_3_FORCED));
    }

    #[test]
    fn forced_thinking_error_does_not_fire_on_unrelated_failures() {
        // 这些都不能触发降级重试，否则每次请求白发两遍
        for body in [
            r#"{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}"#,
            r#"{"error":{"message":"The model `glm-9` does not exist","code":"model_not_found"}}"#,
            r#"{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}"#,
            r#"{"error":{"message":"余额不足","code":"1113"}}"#,
        ] {
            assert!(!forced_thinking_error(body), "不该命中: {}", body);
        }
    }

    /// 强制思考的模型要发「最低强度」，不是「什么都不发」。
    ///
    /// 直接不发参数会落到 GLM-5.3 的默认 `reasoning_effort=max`（深度推理），
    /// 对语音输入是最差结果 —— 比不降级还慢。
    #[test]
    fn forced_thinking_models_get_low_effort_not_empty_params() {
        assert!(model_forces_thinking("glm-5.3"));
        assert!(model_forces_thinking("glm-5.3-flash"));
        assert!(model_forces_thinking("GLM-5.3-Flash"));
        assert!(!model_forces_thinking("glm-4.7-flash"));
        assert!(!model_forces_thinking("glm-4.7"));

        let overrides = thinking_overrides(&config(
            "zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5.3",
        ))
        .expect("forced-thinking model still needs parameters");
        assert_eq!(keys(&overrides), vec!["reasoning_effort", "thinking"]);
        assert_eq!(overrides["thinking"]["type"], serde_json::json!("enabled"));
        assert_eq!(overrides["reasoning_effort"], serde_json::json!("low"));

        // 同一家的非强制模型仍然走 disabled（那是最快的一档）
        let flash = thinking_overrides(&config(
            "zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-4.7-flash",
        ))
        .expect("glm-4.7-flash can disable thinking");
        assert_eq!(flash["thinking"]["type"], serde_json::json!("disabled"));
    }

    #[test]
    fn strict_openai_hosts_get_no_thinking_params() {
        // OpenAI / Azure 对未知顶层字段直接 400，且 reasoning_effort 的合法取值依模型而异，
        // 猜不准就别猜——这两家保持「一个字段都不发」的现状。
        for url in [
            "https://api.openai.com/v1",
            "https://my-resource.openai.azure.com/openai/deployments/gpt5",
            "https://my-resource.cognitiveservices.azure.com/openai/v1",
        ] {
            assert!(is_strict_openai_host(url), "{} should be strict", url);
            assert!(
                thinking_overrides(&config("openai_compat", url, "gpt-5")).is_none(),
                "{} should not receive thinking params",
                url
            );
        }
    }

    #[test]
    fn unknown_endpoints_get_the_catch_all_set() {
        // 这一档是整个改动的理由：在此之前这些端点一个字段都不发，模型默认思考就关不掉。
        for (provider, url) in [
            ("openai_compat", "https://openrouter.ai/api/v1"),
            ("openai_compat", "http://192.168.1.10:3000/v1"),
            ("doubao", "https://ark.cn-beijing.volces.com/api/v3"),
            ("groq", "https://api.groq.com/openai/v1"),
        ] {
            let overrides = thinking_overrides(&config(provider, url, "m"))
                .unwrap_or_else(|| panic!("{} should receive thinking params", url));
            assert_eq!(
                keys(&overrides),
                vec![
                    "enable_thinking",
                    "reasoning",
                    "reasoning_effort",
                    "thinking"
                ],
                "{}",
                url
            );
        }
    }

    #[test]
    fn merge_overrides_replaces_top_level_keys_only() {
        let mut body = serde_json::json!({
            "model": "m",
            "messages": [],
            "thinking": { "type": "enabled", "budget": 100 },
        });
        merge_overrides(&mut body, &disable_thinking_overrides());

        // 整体覆盖，不深合并：残留一个 budget 字段会让请求变成谁也说不清的状态
        assert_eq!(body["thinking"], serde_json::json!({"type": "disabled"}));
        assert_eq!(body["model"], serde_json::json!("m"));
        assert!(body["messages"].is_array());
    }

    #[test]
    fn rejection_detection_only_fires_when_our_field_is_named() {
        let overrides = disable_thinking_overrides();

        let named = r#"{"error":{"message":"Unrecognized request argument supplied: thinking"}}"#;
        assert_eq!(
            rejected_thinking_field(named, &overrides).as_deref(),
            Some("thinking")
        );

        let unsupported_value =
            r#"{"error":{"code":"unsupported_value","param":"reasoning_effort"}}"#;
        assert!(rejected_thinking_field(unsupported_value, &overrides).is_some());

        // 密钥错、模型不存在这些 400 绝不能触发降级重试，否则每次请求都白发两遍
        for body in [
            r#"{"error":{"message":"Incorrect API key provided"}}"#,
            r#"{"error":{"message":"The model `gpt-9` does not exist"}}"#,
            r#"{"error":{"message":"max_tokens is too small"}}"#,
        ] {
            assert!(
                rejected_thinking_field(body, &overrides).is_none(),
                "should not retry for: {}",
                body
            );
        }
    }

    #[test]
    fn rejection_cache_is_scoped_to_host_and_model() {
        // 用独特的 host 名，避免和同进程里其他测试共用那个全局表时互相干扰
        let a = config("openai_compat", "https://cache-test.invalid/v1", "model-a");
        let b = config("openai_compat", "https://cache-test.invalid/v1", "model-b");

        assert!(remembered_thinking(&a).is_none());
        remember_thinking(&a, None);
        assert_eq!(remembered_thinking(&a), Some(None));
        // 同一网关换个模型结论可能不同（unsupported_value 是按模型判的），不能共用
        assert!(remembered_thinking(&b).is_none());
    }

    /// 缓存要存「降级成什么」，不只是「降级过」。
    ///
    /// 强制思考的模型降级目标是「最低强度」，别的端点是「什么都不发」。旧结构是
    /// HashSet，只存得下后者 —— 于是 GLM-5.3 这类模型第二次请求会被当成"不发参数"，
    /// 落回它的默认 reasoning_effort=max，比不降级还慢。
    #[test]
    fn cache_remembers_which_fallback_worked() {
        let forced = config("zhipu", "https://cache-forced.invalid/v4", "glm-5.3");
        remember_thinking(&forced, Some(forced_thinking_overrides()));

        let remembered = remembered_thinking(&forced).expect("should be cached");
        let params = remembered.expect("forced-thinking endpoints still need parameters");
        assert_eq!(params["reasoning_effort"], serde_json::json!("low"));
        assert_eq!(params["thinking"]["type"], serde_json::json!("enabled"));
    }
}
