// 豆包（火山引擎）ASR 的鉴权头与资源 ID —— 三条调用路径（flash / nostream / 双向流式）共用。
//
// 火山有两代控制台，鉴权方式不同：
//
//   旧版控制台：X-Api-App-Key（App ID） + X-Api-Access-Key（Access Token）
//   新版控制台：只要 X-Api-Key（APP Key）
//
// 两代的密钥**不是同一个东西**，不能互换：把 Access Token 当 X-Api-Key 发，或者把
// APP Key 当 App ID 发，都只会拿到一个长得像「密钥填错了」的 401，用户根本猜不到
// 是控制台代次不对。所以模式由调用方明确给出，这里不做任何猜测式回退。
//
// 判定口径：**app_id 是否为空**。前端按用户选择的控制台版本，把「本次生效的凭据」
// 写进运行时配置——新版只写 api_key、app_id 留空；旧版两个都写。于是线上格式是自解释的，
// 不需要再额外传一个模式字段（也就不会出现某个调用点忘了传、导致一半用户报错的情况）。
//
// 这里刻意不保留历史上那个 `if app_id.is_empty() { app_id = api_key }` 的回退：
// 它既发不出正确的新版请求头，还会把密钥当 uid 塞进请求体。

use super::types::AsrProviderConfig;

/// 豆包 Seed-ASR 2.0 流式资源 ID。小时版（包时）与并发版（按量）是两种计费方式，
/// 同一个账号通常只开通其中之一，所以连接时要依次尝试。
pub const RESOURCE_ID_SAUC_DURATION: &str = "volc.seedasr.sauc.duration";
pub const RESOURCE_ID_SAUC_CONCURRENT: &str = "volc.seedasr.sauc.concurrent";

/// 流式端点按「小时版 → 并发版」依次尝试的资源 ID。
pub const SAUC_RESOURCE_CANDIDATES: &[&str] =
    &[RESOURCE_ID_SAUC_DURATION, RESOURCE_ID_SAUC_CONCURRENT];

/// 请求体 `user.uid`。新版控制台没有 App ID 可填，而这个字段只是给服务端做调用方标识，
/// 绝不能拿密钥顶替（历史实现就是这么干的，等于把 Access Token 写进请求体）。
const FALLBACK_UID: &str = "sayit";

/// 一次调用要用哪套鉴权。
pub enum DoubaoAuth<'a> {
    /// 新版控制台：只发 X-Api-Key。
    ApiKey { api_key: &'a str },
    /// 旧版控制台：App ID + Access Token。
    AppIdAccessKey { app_id: &'a str, access_key: &'a str },
}

impl<'a> DoubaoAuth<'a> {
    /// 从前端传入的配置判定鉴权方式。空 app_id = 新版控制台。
    pub fn from_config(config: &'a AsrProviderConfig) -> Self {
        let app_id = config.app_id.trim();
        if app_id.is_empty() {
            DoubaoAuth::ApiKey { api_key: config.api_key.trim() }
        } else {
            DoubaoAuth::AppIdAccessKey {
                app_id,
                access_key: config.api_key.trim(),
            }
        }
    }

    /// 请求体里的 `user.uid`。旧版用 App ID（它本来就是公开的账号标识），
    /// 新版没有可用标识，用固定占位符，绝不回落到密钥。
    pub fn uid(&self) -> &str {
        match self {
            DoubaoAuth::ApiKey { .. } => FALLBACK_UID,
            DoubaoAuth::AppIdAccessKey { app_id, .. } => app_id,
        }
    }

    /// 供日志使用的模式名（不含任何密钥）。
    pub fn mode_name(&self) -> &'static str {
        match self {
            DoubaoAuth::ApiKey { .. } => "api_key(new-console)",
            DoubaoAuth::AppIdAccessKey { .. } => "app_id+access_key(legacy-console)",
        }
    }

    /// 凭据是否填全。缺东西就别发请求：网关只会回一个含义模糊的鉴权错误。
    pub fn missing_field(&self) -> Option<&'static str> {
        match self {
            DoubaoAuth::ApiKey { api_key } if api_key.is_empty() => Some("API Key"),
            DoubaoAuth::AppIdAccessKey { access_key, .. } if access_key.is_empty() => {
                Some("Access Token")
            }
            _ => None,
        }
    }

    /// 以 (名, 值) 形式返回本模式需要的鉴权头，调用方逐个塞进 builder。
    pub fn headers(&self) -> Vec<(&'static str, &'a str)> {
        match self {
            DoubaoAuth::ApiKey { api_key } => vec![("X-Api-Key", api_key)],
            DoubaoAuth::AppIdAccessKey { app_id, access_key } => vec![
                ("X-Api-App-Key", app_id),
                ("X-Api-Access-Key", access_key),
            ],
        }
    }
}

/// 把火山的状态码翻成用户能照着做事的一句话。
///
/// 这些码会经历史记录的「原因」展示给用户看 —— 只给一串数字等于没说。
///
/// **只写有实据的**：`20000003` 有本仓库既有代码为证（test_connection 一直把它当静音音频
/// 放行），`45000030` 是拿真实凭据打线上接口实测到的（`requested resource not granted`）。
/// 其余按前缀分族给一个方向性说明，不猜具体含义 —— 猜错了比不写更坏，会把用户引到
/// 错误的地方去排查。
pub fn explain_status_code(code: &str) -> Option<&'static str> {
    match code {
        "20000003" => Some("The audio was classified as silence; no speech was detected"),
        "45000030" => Some("This account has not enabled the requested resource or has exhausted its quota; check the Volcengine console"),
        // 以下三条出自官方《大模型流式语音识别API》错误码表（docs.volcengine.com/docs/6561/1354869）
        "45000002" => Some("The audio sent to Volcengine was empty"),
        "45000081" => Some("Volcengine stopped waiting for the next audio packet; the connection stalled while uploading"),
        "55000031" => Some("Volcengine is overloaded; try again later"),
        _ => {
            if code.starts_with("45") {
                Some("The request was rejected; check parameters, audio format, and quota in the Volcengine console")
            } else if code.starts_with("55") {
                Some("Volcengine failed to process the request; try again later")
            } else {
                None
            }
        }
    }
}

/// 从服务端返回的 JSON 里取出状态码并翻成人话，拼成可直接展示的后缀。
/// 拿不到码就返回空串，调用方直接拼接即可。
pub fn explain_payload(payload: &str) -> String {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) else {
        return String::new();
    };
    // code 可能是数字也可能是字符串，两种都取
    let code = json
        .get("code")
        .map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    match explain_status_code(&code) {
        Some(text) => format!("（{}）", text),
        None => String::new(),
    }
}

/// 从 WebSocket 握手响应里取 X-Tt-Logid 并写日志。
///
/// 火山文档明确「强烈建议记录 logid 作为排错线索」：这是服务端给的唯一追踪 ID，
/// 用户报「豆包连不上」时带着它才能找火山定位，没有就只能猜。
pub fn log_ws_logid(scope: &str, response: &tokio_tungstenite::tungstenite::handshake::client::Response) {
    let logid = response
        .headers()
        .get("X-Tt-Logid")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<none>");
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao] {} handshake ok logid={}",
        scope, logid
    ));
}

/// 从 HTTP 响应里取 X-Tt-Logid 并写日志。
pub fn log_http_logid(scope: &str, headers: &reqwest::header::HeaderMap) {
    let logid = headers
        .get("X-Tt-Logid")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<none>");
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao] {} response logid={}",
        scope, logid
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(api_key: &str, app_id: &str) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "doubao_v2".into(),
            api_key: api_key.into(),
            app_id: app_id.into(),
            extra: serde_json::Value::Null,
        }
    }

    /// 空 app_id = 新版控制台，只发 X-Api-Key。
    #[test]
    fn empty_app_id_selects_new_console() {
        let c = cfg("APPKEY", "");
        let auth = DoubaoAuth::from_config(&c);
        assert_eq!(auth.headers(), vec![("X-Api-Key", "APPKEY")]);
    }

    /// 有 app_id = 旧版控制台，发 App Key + Access Key 两个头。
    #[test]
    fn app_id_selects_legacy_console() {
        let c = cfg("TOKEN", "1234567890");
        let auth = DoubaoAuth::from_config(&c);
        assert_eq!(
            auth.headers(),
            vec![
                ("X-Api-App-Key", "1234567890"),
                ("X-Api-Access-Key", "TOKEN"),
            ]
        );
    }

    /// 关键回归：密钥绝不能出现在 uid 里。历史实现在 app_id 为空时用 api_key 顶替，
    /// 于是 Access Token 被写进请求体。
    #[test]
    fn uid_never_leaks_the_secret() {
        let c = cfg("SECRET", "");
        let auth = DoubaoAuth::from_config(&c);
        assert_eq!(auth.uid(), FALLBACK_UID);
        assert_ne!(auth.uid(), "SECRET");
    }

    /// 旧版下 uid 用 App ID —— 它是账号标识，不是密钥。
    #[test]
    fn uid_uses_app_id_on_legacy() {
        let c = cfg("TOKEN", "1234567890");
        assert_eq!(DoubaoAuth::from_config(&c).uid(), "1234567890");
    }

    /// 两种模式各自缺料时要能报出缺的是什么。
    #[test]
    fn reports_the_missing_credential() {
        assert_eq!(DoubaoAuth::from_config(&cfg("", "")).missing_field(), Some("API Key"));
        assert_eq!(
            DoubaoAuth::from_config(&cfg("", "123")).missing_field(),
            Some("Access Token")
        );
        assert_eq!(DoubaoAuth::from_config(&cfg("k", "")).missing_field(), None);
        assert_eq!(DoubaoAuth::from_config(&cfg("k", "123")).missing_field(), None);
    }

    /// 有实据的两个码要给出具体说明。
    #[test]
    fn explains_the_codes_we_have_evidence_for() {
        assert!(explain_status_code("20000003").unwrap().contains("silence"));
        assert!(explain_status_code("45000030").unwrap().contains("quota"));
    }

    /// 没实据的码按前缀给方向，不编造具体含义。
    #[test]
    fn falls_back_to_code_family() {
        assert!(explain_status_code("45000001").unwrap().contains("rejected"));
        assert!(explain_status_code("55000031").unwrap().contains("Volcengine"));
    }

    /// 成功码和无法识别的码不该产生任何提示。
    #[test]
    fn no_hint_for_success_or_unknown() {
        assert_eq!(explain_status_code("20000000"), None);
        assert_eq!(explain_status_code(""), None);
        assert_eq!(explain_status_code("abc"), None);
    }

    /// 返回体里的 code 可能是数字也可能是字符串，两种都要认。
    #[test]
    fn explains_payload_with_either_code_type() {
        assert!(explain_payload(r#"{"code":45000030}"#).contains("quota"));
        assert!(explain_payload(r#"{"code":"45000030"}"#).contains("quota"));
    }

    /// 拿不到码就返回空串，调用方直接拼接不会多出括号。
    #[test]
    fn explains_payload_returns_empty_when_no_code() {
        assert_eq!(explain_payload("not json"), "");
        assert_eq!(explain_payload(r#"{"message":"x"}"#), "");
        assert_eq!(explain_payload(r#"{"code":20000000}"#), "");
    }

    /// 前后空白是粘贴时常见的脏数据，判定与发送都应按 trim 后的值。
    #[test]
    fn trims_whitespace_around_credentials() {
        let c = cfg("  KEY  ", "  ");
        let auth = DoubaoAuth::from_config(&c);
        assert_eq!(auth.headers(), vec![("X-Api-Key", "KEY")]);
    }
}

#[cfg(test)]
mod status_code_tests {
    use super::explain_status_code;

    /// 文档里写明的码要有专门的说明，不能落进「45 开头 = 请求被拒」的笼统分支 ——
    /// 45000081 是网络卡住，让用户去查参数和额度就是把人往错的方向引。
    #[test]
    fn documented_codes_get_specific_explanations() {
        assert!(explain_status_code("45000081").unwrap().contains("next audio packet"));
        assert!(explain_status_code("45000002").unwrap().contains("empty"));
        assert!(explain_status_code("55000031").unwrap().contains("overloaded"));
    }
}
