from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_CONFIG_PATH = _PROJECT_ROOT / "config.yaml"


# ---------------------------------------------------------------------------
# Sub-configs — mirror the YAML structure
# ---------------------------------------------------------------------------

_KIB = 1024
_MIB = 1024 * 1024


@dataclass(slots=True)
class BodyLimitConfig:
    """HTTP 请求体上限（字节）。

    接口内原有的检查（诊断包 50 MiB、录音 10 MiB）照旧保留，这里是外面多加的一层。
    """
    diagnostics: int = 52 * _MIB      # 截图 ≤20 MiB + 日志压缩后约 2 MiB；接口自己还限 50 MiB
    asr_corrections: int = 11 * _MIB  # 录音 ≤10 MiB + 文字与热词不到 50 KiB
    feedback: int = 512 * _KIB        # 正常最大约 70~90 KiB
    admin: int = 8 * _MIB             # admin 后台上传 5 MiB 截图，base64 后约 6.7 MiB
    default: int = 1 * _MIB           # 其余都是 GET 或很小的 POST


@dataclass(slots=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: list[str] = field(default_factory=lambda: ["*"])
    body_limits: BodyLimitConfig = field(default_factory=BodyLimitConfig)


@dataclass(slots=True)
class GatewayConfig:
    host: str = "0.0.0.0"
    port: int = 8443
    backend_target: str = "http://127.0.0.1:8000"
    tls_key_file: str = ""
    tls_cert_file: str = ""


@dataclass(slots=True)
class PathsConfig:
    prompt_dir: str = str(_PROJECT_ROOT / "prompts")
    releases_dir: str = str(_PROJECT_ROOT / "releases")
    notices_dir: str = str(_PROJECT_ROOT / "notices")


@dataclass(slots=True)
class ASRConfig:
    engine: str = "qwen3"
    model: str = "Qwen/Qwen3-ASR-1.7B"
    device: str = "cuda:0"
    language: str = "Chinese"
    itn: bool = True
    vllm_gpu_util: float = 0.5
    vllm_max_model_len: int = 8192
    max_concurrency: int = 1
    batch_max_size: int = 32
    batch_wait_ms: int = 60
    firered_model_dir: str = str(_PROJECT_ROOT / "pretrained_models")
    firered_use_int8: bool = True
    halluc_guard: str = "enforce"   # off / log / enforce, see halluc_guard.py


@dataclass(slots=True)
class VADConfig:
    model: str = "fsmn-vad"
    max_single_segment_time: int = 30000


@dataclass(slots=True)
class LLMProfile:
    enabled: bool = True
    provider: str = "azure"
    prompt_dir: str = str(_PROJECT_ROOT / "prompts")
    debug_llm: bool = False

    azure_endpoint: str = ""
    azure_api_key: str = ""
    azure_deployment: str = "gpt-4o"
    azure_api_version: str = "2024-12-01-preview"
    azure_timeout: int = 15

    openai_base_url: str = "https://api.openai.com"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_timeout: int = 15
    # None → 请求体整体不带 temperature 字段。推理模型只接受该参数的默认值，显式发
    # 0.2 会被 400 拒收，所以不能靠"换个数字"适配，必须能配成不发送。默认仍是 0.2，
    # 保证既有 Azure / OpenAI 配置行为不变。
    openai_temperature: float | None = 0.2
    # 空串 → 不发送该字段。取 none/low/medium/high，档位越低延迟越短。
    openai_reasoning_effort: str = ""

    groq_base_url: str = "https://api.groq.com/openai"
    groq_api_key: str = ""
    groq_model: str = "qwen/qwen3-32b"
    groq_timeout: int = 15

    ollama_url: str = "http://127.0.0.1:11434/api/generate"
    ollama_model: str = "qwen2.5:7b"
    ollama_timeout: int = 15


@dataclass(slots=True)
class PublicSiteConfig:
    app_name: str = "SayIt"
    headline: str = "随口说，出色写"
    subheadline: str = "用说话代替打字，AI 实时把口语变成可以直接用的书面表达。"
    download_label: str = "下载 Windows 客户端"
    download_platform: str = "win32"
    download_arch: str = "x64"


@dataclass(slots=True)
class WebDemoConfig:
    enabled: bool = True
    # Same as the desktop app's per-take limit (client MAX_RECORDING_SEC = 300); the site says 5 minutes.
    max_duration_sec: int = 300
    max_concurrency_per_ip: int = 3
    llm: LLMProfile = field(default_factory=LLMProfile)


@dataclass(slots=True)
class LoggingConfig:
    level: str = "INFO"
    debug_asr: bool = False
    debug_llm: bool = False
    file: str = str(_PROJECT_ROOT / "runtime" / "logs" / "sayit.log")
    retention_days: int = 14
    slow_asr_ms: int = 5000
    slow_llm_ms: int = 8000


@dataclass(slots=True)
class TelemetryConfig:
    enabled: bool = True
    db_backend: str = "sqlite"  # "sqlite" or "postgresql"
    db_path: str = str(_PROJECT_ROOT / "runtime" / "telemetry" / "sayit.sqlite3")
    collect_window_title: bool = True
    collect_exe_path: bool = True
    node_id: str = "single-node-01"
    deployment_mode: str = "single"


@dataclass(slots=True)
class AdminConfig:
    enabled: bool = True
    username: str = "admin"
    password: str = "sayit"  # default password — WARNING printed at startup


# ---------------------------------------------------------------------------
# guard：连接防护（推流检测 / 准入 / 额度 / 润色预算）
#
# 代码里的默认值一律是「关 / 0 / 空」：没有 guard 段 = 什么都不做，行为与没有这一层时一致。
# 真实阈值只写在私有的 config.yaml 里，不进代码、不进 config.example.yaml。
# 每项检查 mode 取 off / log / enforce：log 只写 `guard violation ...` 日志，enforce 才拒绝 / 降级。
# 阈值为 0 表示该维度不限。不读环境变量。
# ---------------------------------------------------------------------------

GUARD_MODES = ("off", "log", "enforce")


@dataclass(slots=True)
class GuardPaceConfig:
    """live 推流检测：音频秒数 > 已过秒数 × max_ratio + grace_sec 即违规。"""

    mode: str = "off"
    max_ratio: float = 0.0
    grace_sec: float = 0.0


@dataclass(slots=True)
class GuardAdmissionConfig:
    """准入：device_id / client_version 格式，live 有音频必须带 ptt_hold_ms。格式在 guard.py。"""

    mode: str = "off"


@dataclass(slots=True)
class GuardQuotaConfig:
    """音频额度，单位分钟，滚动 24 小时。"""

    mode: str = "off"
    device_minutes: float = 0.0
    ip_minutes: float = 0.0
    nonlive_device_minutes: float = 0.0
    nonlive_ip_minutes: float = 0.0
    demo_ip_minutes: float = 0.0
    internal_minutes: float = 0.0
    # 网页体验：全站 24 小时音频分钟，单 IP / 全站的会话次数
    demo_global_minutes: float = 0.0
    demo_ip_sessions_per_hour: int = 0
    demo_ip_sessions_per_day: int = 0
    demo_global_sessions_per_hour: int = 0
    # 桌面端会话次数：按设备（1 分钟 / 1 小时 / 24 小时）、按 IP（1 小时 / 24 小时）
    device_sessions_per_minute: int = 0
    device_sessions_per_hour: int = 0
    device_sessions_per_day: int = 0
    ip_sessions_per_hour: int = 0
    ip_sessions_per_day: int = 0
    # 桌面端每台设备每小时「识别结果为空或只有一个字」的会话数
    device_empty_per_hour: int = 0


@dataclass(slots=True)
class GuardWebDemoConfig:
    """网页体验必须来自这些站点的浏览器（看 WebSocket 握手的 Origin 头）。"""

    mode: str = "off"
    allowed_origins: list[str] = field(default_factory=list)


@dataclass(slots=True)
class GuardAiBudgetConfig:
    """润色预算。超了只停润色，识别照常。

    用量按模型接口报回的 token 数计（输入 + 输出，推理模型的思考 token 也算在输出里），
    接口没报时按字数估算。滚动 24 小时。system_prompt 超过 max_system_prompt_chars 的会话
    直接不润色：它由客户端整段提供、原样交给模型，不限长就等于一个不计费的通用 LLM 接口。
    """

    mode: str = "off"
    device_tokens: int = 0
    ip_tokens: int = 0
    max_system_prompt_chars: int = 0


@dataclass(slots=True)
class GuardAlertConfig:
    """全站最近一小时超过阈值时打一行 WARNING（每项每小时最多一次）。0 = 不报。"""

    audio_minutes_per_hour: float = 0.0
    ai_tokens_per_hour: int = 0
    hits_per_hour: int = 0  # 规则命中次数（含 log 模式下的 violation）


@dataclass(slots=True)
class GuardConfig:
    present: bool = False  # config.yaml 里有没有 guard 段
    trusted_proxies: list[str] = field(default_factory=list)
    allow_ips: list[str] = field(default_factory=list)
    use_real_ip: bool = False
    netid_log: bool = False
    pace: GuardPaceConfig = field(default_factory=GuardPaceConfig)
    admission: GuardAdmissionConfig = field(default_factory=GuardAdmissionConfig)
    quota: GuardQuotaConfig = field(default_factory=GuardQuotaConfig)
    ai_budget: GuardAiBudgetConfig = field(default_factory=GuardAiBudgetConfig)
    alert: GuardAlertConfig = field(default_factory=GuardAlertConfig)
    web_demo: GuardWebDemoConfig = field(default_factory=GuardWebDemoConfig)
    # 解析时发现的配置问题。不抛异常（load_config 在 main 导入期执行，抛了整个后端起不来），
    # 由启动 banner 统一打出来。
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    paths: PathsConfig = field(default_factory=PathsConfig)
    asr: ASRConfig = field(default_factory=ASRConfig)
    vad: VADConfig = field(default_factory=VADConfig)
    llm: LLMProfile = field(default_factory=LLMProfile)
    public_site: PublicSiteConfig = field(default_factory=PublicSiteConfig)
    web_demo: WebDemoConfig = field(default_factory=WebDemoConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    telemetry: TelemetryConfig = field(default_factory=TelemetryConfig)
    admin: AdminConfig = field(default_factory=AdminConfig)
    guard: GuardConfig = field(default_factory=GuardConfig)

    config_file: str = str(_DEFAULT_CONFIG_PATH)
    env_file: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return payload if isinstance(payload, dict) else {}


def _pick(source: dict[str, Any], *keys: str, default: Any = None) -> Any:
    current: Any = source
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current


def _env_str(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value in (None, ""):
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value in (None, ""):
        return default
    return value.lower() in ("1", "true", "yes", "on")


def _env_list(name: str, default: list[str]) -> list[str]:
    value = os.getenv(name)
    if value in (None, ""):
        return default
    return [s.strip() for s in value.split(",") if s.strip()]


def _resolve_path(raw: str | None, fallback: Path) -> str:
    if not raw:
        return str(fallback)
    value = Path(raw).expanduser()
    if not value.is_absolute():
        value = (_PROJECT_ROOT / value).resolve()
    return str(value)


def _normalize_mode3(raw: Any, default: str) -> str:
    mode = str(raw or "").strip().lower()
    return mode if mode in ("off", "log", "enforce") else default


def _normalize_asr_language(raw: Any, default: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return default
    lowered = value.lower()
    aliases = {
        "中文": "Chinese", "汉语": "Chinese", "chinese": "Chinese",
        "zh": "Chinese", "zh-cn": "Chinese",
        "english": "English", "en": "English",
        "cantonese": "Cantonese", "粤语": "Cantonese",
    }
    if lowered in aliases:
        return aliases[lowered]
    if "?" in value or "\ufffd" in value:
        return default
    return value


def _clean_display_text(raw: Any, default: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return default
    question_marks = value.count("?") + value.count("\ufffd")
    if question_marks >= max(2, len(value) // 4):
        return default
    return value


def _resolve_config_path(config_path: str | None) -> Path:
    explicit = config_path or os.getenv("SAYIT_CONFIG_FILE")
    if explicit:
        return Path(explicit).expanduser().resolve()
    if _DEFAULT_CONFIG_PATH.exists():
        return _DEFAULT_CONFIG_PATH
    legacy = _PROJECT_ROOT / "config" / "config.yaml"
    if legacy.exists():
        return legacy
    return _DEFAULT_CONFIG_PATH


def _resolve_env_path(env_path: str | None) -> Path | None:
    explicit = env_path or os.getenv("SAYIT_ENV_FILE")
    candidates = [
        Path(explicit).expanduser() if explicit else None,
        _PROJECT_ROOT / ".env",
    ]
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate.resolve()
    return None


def _env_name(prefix: str, name: str) -> str:
    return f"{prefix}_{name}" if prefix else name


def _opt_temperature(env_name: str, section: dict[str, Any], default: float | None) -> float | None:
    """temperature 三态解析：未配置 → 沿用默认；显式 null/none → 不发送该字段；数字 → 用该值。

    推理模型只接受 temperature 的默认值，发 0.2 会被拒 400，所以必须有"整体不发送"这一态。

    空环境变量按"未设置"处理，与 _env_str / _env_int 一致 —— docker-compose 的
    environment 列表常把未赋值的键传成空串，若把空串当成"不发送"，会静默改掉 Azure
    那套配置的行为。解析失败也回落默认值而不抛异常：load_config() 在 main.py 是模块
    导入期执行的，这里抛一次 ValueError 等于整个后端起不来。
    """
    raw = os.getenv(env_name)
    if raw is not None and raw.strip():
        token = raw.strip().lower()
        if token in ("none", "null"):
            return None
        try:
            return float(token)
        except ValueError:
            return default
    if "temperature" not in section:
        return default
    value = section.get("temperature")
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _opt_reasoning_effort(env_name: str, section: dict[str, Any], default: str) -> str:
    """reasoning_effort：空串表示不发送该字段。

    不做取值白名单 —— 网关可能新增档位，写死清单会挡住新值。写错的代价可控：会被
    服务端 400 拒，而 400 的响应体现在会进日志（见 llm.py::_raise_for_status）。
    """
    raw = _env_str(env_name, str(section.get("reasoning_effort") or default))
    return raw.strip().lower()


def _load_llm_profile(
    section: dict[str, Any],
    prompt_dir: str,
    fallback: LLMProfile | None = None,
    env_prefix: str = "SAYIT",
    debug_llm: bool = False,
) -> LLMProfile:
    base = fallback or LLMProfile(prompt_dir=prompt_dir, debug_llm=debug_llm)
    azure = _pick(section, "azure", default={}) or {}
    openai = _pick(section, "openai", default={}) or {}
    groq = _pick(section, "groq", default={}) or {}
    ollama = _pick(section, "ollama", default={}) or {}

    return LLMProfile(
        enabled=bool(section.get("enabled", base.enabled)),
        provider=_env_str(_env_name(env_prefix, "LLM_PROVIDER"), str(section.get("provider") or base.provider)),
        prompt_dir=_resolve_path(section.get("prompt_dir"), Path(base.prompt_dir or prompt_dir)),
        debug_llm=debug_llm,
        azure_endpoint=_env_str(_env_name(env_prefix, "AZURE_ENDPOINT"), base.azure_endpoint),
        azure_api_key=_env_str(_env_name(env_prefix, "AZURE_API_KEY"), base.azure_api_key),
        azure_deployment=_env_str(_env_name(env_prefix, "AZURE_DEPLOYMENT"), str(azure.get("deployment") or base.azure_deployment)),
        azure_api_version=str(azure.get("api_version") or base.azure_api_version),
        azure_timeout=int(azure.get("timeout_sec") or base.azure_timeout),
        openai_base_url=_env_str(
            _env_name(env_prefix, "OPENAI_BASE_URL"),
            str(openai.get("base_url") or base.openai_base_url),
        ),
        openai_api_key=_env_str(_env_name(env_prefix, "OPENAI_API_KEY"), base.openai_api_key),
        openai_model=_env_str(_env_name(env_prefix, "OPENAI_MODEL"), str(openai.get("model") or base.openai_model)),
        openai_timeout=int(openai.get("timeout_sec") or base.openai_timeout),
        openai_temperature=_opt_temperature(
            _env_name(env_prefix, "OPENAI_TEMPERATURE"), openai, base.openai_temperature
        ),
        openai_reasoning_effort=_opt_reasoning_effort(
            _env_name(env_prefix, "OPENAI_REASONING_EFFORT"), openai, base.openai_reasoning_effort
        ),
        groq_base_url=_env_str(
            _env_name(env_prefix, "GROQ_BASE_URL"),
            str(groq.get("base_url") or base.groq_base_url),
        ),
        groq_api_key=_env_str(_env_name(env_prefix, "GROQ_API_KEY"), base.groq_api_key),
        groq_model=_env_str(_env_name(env_prefix, "GROQ_MODEL"), str(groq.get("model") or base.groq_model)),
        groq_timeout=int(groq.get("timeout_sec") or base.groq_timeout),
        ollama_url=_env_str(_env_name(env_prefix, "OLLAMA_URL"), str(ollama.get("url") or base.ollama_url)),
        ollama_model=_env_str(_env_name(env_prefix, "OLLAMA_MODEL"), str(ollama.get("model") or base.ollama_model)),
        ollama_timeout=int(ollama.get("timeout_sec") or base.ollama_timeout),
    )


def _auto_infer_llm(profile: LLMProfile) -> LLMProfile:
    """Auto-infer provider from API keys; disable LLM if no keys are set."""
    provider = profile.provider.lower().strip()
    has_key = {
        "openai": bool(profile.openai_api_key),
        "azure": bool(profile.azure_api_key and profile.azure_endpoint),
        "groq": bool(profile.groq_api_key),
        "ollama": True,  # ollama doesn't need a key
    }
    # If the selected provider has credentials, keep it
    if has_key.get(provider):
        return profile
    # Try to infer from available keys
    for candidate in ("openai", "azure", "groq", "ollama"):
        if has_key[candidate] and candidate != "ollama":
            object.__setattr__(profile, "provider", candidate)
            object.__setattr__(profile, "enabled", True)
            return profile
    # No keys at all → disable LLM
    object.__setattr__(profile, "enabled", False)
    return profile


# ---------------------------------------------------------------------------
# guard 段解析：写错任何一项都只记警告、按「关 / 0 / 空」处理，绝不抛异常
# ---------------------------------------------------------------------------

_GUARD_KEYS = frozenset({
    "trusted_proxies", "allow_ips", "use_real_ip", "netid_log", "pace", "admission", "quota", "ai_budget", "alert",
    "web_demo",
})
_QUOTA_MINUTE_KEYS = (
    "device_minutes", "ip_minutes", "nonlive_device_minutes", "nonlive_ip_minutes",
    "demo_ip_minutes", "internal_minutes", "demo_global_minutes",
)
_QUOTA_COUNT_KEYS = (
    "demo_ip_sessions_per_hour", "demo_ip_sessions_per_day", "demo_global_sessions_per_hour",
    "device_sessions_per_minute", "device_sessions_per_hour", "device_sessions_per_day",
    "ip_sessions_per_hour", "ip_sessions_per_day", "device_empty_per_hour",
)
_GUARD_SUB_KEYS = {
    "pace": frozenset({"mode", "max_ratio", "grace_sec"}),
    "admission": frozenset({"mode"}),
    "quota": frozenset({"mode", *_QUOTA_MINUTE_KEYS, *_QUOTA_COUNT_KEYS}),
    "web_demo": frozenset({"mode", "allowed_origins"}),
    "ai_budget": frozenset({"mode", "device_tokens", "ip_tokens", "max_system_prompt_chars"}),
    "alert": frozenset({"audio_minutes_per_hour", "ai_tokens_per_hour", "hits_per_hour"}),
}


def _guard_repr(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= 60 else text[:57] + "..."


def _guard_mode(value: Any, name: str, warnings: list[str]) -> str:
    # PyYAML 把裸写的 off 读成 False、on 读成 True。off 按本意处理；on 不知道想要 log 还是
    # enforce，宁可关着也不猜。
    if value is None or value is False:
        return "off"
    if isinstance(value, str) and value.strip().lower() in GUARD_MODES:
        return value.strip().lower()
    warnings.append(f"guard.{name}={_guard_repr(value)} 无效，按 off 处理（取值 \"off\" / \"log\" / \"enforce\"，记得加引号）")
    return "off"


def _guard_number(section: dict[str, Any], key: str, name: str, warnings: list[str], *, integer: bool = False) -> Any:
    value = section.get(key)
    if value is None:
        return 0 if integer else 0.0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")) or value < 0:
        warnings.append(f"guard.{name}.{key}={_guard_repr(value)} 不是非负数，按 0（不限 / 不生效）处理")
        return 0 if integer else 0.0
    return int(value) if integer else float(value)


def _guard_bool(section: dict[str, Any], key: str, warnings: list[str]) -> bool:
    value = section.get(key)
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    warnings.append(f"guard.{key}={_guard_repr(value)} 不是 true/false，按 false 处理")
    return False


def _guard_list(section: dict[str, Any], key: str, warnings: list[str], *, prefix: str = "") -> list[str]:
    value = section.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        warnings.append(f"guard.{prefix}{key} 必须是列表，已忽略")
        return []
    items: list[str] = []
    for item in value:
        if isinstance(item, str) and item.strip():
            items.append(item.strip())
        else:
            warnings.append(f"guard.{prefix}{key} 里的 {_guard_repr(item)} 不是字符串，已忽略")
    return items


def _guard_section(section: dict[str, Any], key: str, warnings: list[str]) -> dict[str, Any]:
    value = section.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        warnings.append(f"guard.{key} 必须是映射，已忽略")
        return {}
    unknown = sorted(str(k) for k in value if k not in _GUARD_SUB_KEYS[key])
    if unknown:
        warnings.append(f"guard.{key} 里有不认识的键 {', '.join(unknown)}（拼错了？），已忽略")
    return value


def _load_guard(raw: Any) -> GuardConfig:
    if raw is None:
        return GuardConfig()
    if not isinstance(raw, dict):
        return GuardConfig(warnings=["guard 段必须是映射，整段已忽略"])
    warnings: list[str] = []
    unknown = sorted(str(k) for k in raw if k not in _GUARD_KEYS)
    if unknown:
        warnings.append(f"guard 里有不认识的键 {', '.join(unknown)}（拼错了？），已忽略")
    pace = _guard_section(raw, "pace", warnings)
    admission = _guard_section(raw, "admission", warnings)
    quota = _guard_section(raw, "quota", warnings)
    ai_budget = _guard_section(raw, "ai_budget", warnings)
    alert = _guard_section(raw, "alert", warnings)
    web_demo = _guard_section(raw, "web_demo", warnings)
    return GuardConfig(
        present=True,
        trusted_proxies=_guard_list(raw, "trusted_proxies", warnings),
        allow_ips=_guard_list(raw, "allow_ips", warnings),
        use_real_ip=_guard_bool(raw, "use_real_ip", warnings),
        netid_log=_guard_bool(raw, "netid_log", warnings),
        pace=GuardPaceConfig(
            mode=_guard_mode(pace.get("mode"), "pace.mode", warnings),
            max_ratio=_guard_number(pace, "max_ratio", "pace", warnings),
            grace_sec=_guard_number(pace, "grace_sec", "pace", warnings),
        ),
        admission=GuardAdmissionConfig(mode=_guard_mode(admission.get("mode"), "admission.mode", warnings)),
        quota=GuardQuotaConfig(
            mode=_guard_mode(quota.get("mode"), "quota.mode", warnings),
            **{k: _guard_number(quota, k, "quota", warnings) for k in _QUOTA_MINUTE_KEYS},
            **{k: _guard_number(quota, k, "quota", warnings, integer=True) for k in _QUOTA_COUNT_KEYS},
        ),
        web_demo=GuardWebDemoConfig(
            mode=_guard_mode(web_demo.get("mode"), "web_demo.mode", warnings),
            allowed_origins=_guard_list(web_demo, "allowed_origins", warnings, prefix="web_demo."),
        ),
        ai_budget=GuardAiBudgetConfig(
            mode=_guard_mode(ai_budget.get("mode"), "ai_budget.mode", warnings),
            device_tokens=_guard_number(ai_budget, "device_tokens", "ai_budget", warnings, integer=True),
            ip_tokens=_guard_number(ai_budget, "ip_tokens", "ai_budget", warnings, integer=True),
            max_system_prompt_chars=_guard_number(
                ai_budget, "max_system_prompt_chars", "ai_budget", warnings, integer=True,
            ),
        ),
        alert=GuardAlertConfig(
            audio_minutes_per_hour=_guard_number(alert, "audio_minutes_per_hour", "alert", warnings),
            ai_tokens_per_hour=_guard_number(alert, "ai_tokens_per_hour", "alert", warnings, integer=True),
            hits_per_hour=_guard_number(alert, "hits_per_hour", "alert", warnings, integer=True),
        ),
        warnings=warnings,
    )


_BODY_LIMIT_KEYS = {
    # yaml 键 -> (字段名, 单位)
    "diagnostics_mib": ("diagnostics", _MIB),
    "asr_corrections_mib": ("asr_corrections", _MIB),
    "feedback_kib": ("feedback", _KIB),
    "admin_mib": ("admin", _MIB),
    "default_kib": ("default", _KIB),
}


def _load_body_limits(raw: dict) -> BodyLimitConfig:
    """读 server.body_limits。写错的值记一条警告后用默认值，不抛异常 ——
    load_config 在 main.py 导入期执行，一个手误不该让整个后端起不来。"""
    values = {}
    for key, value in raw.items():
        spec = _BODY_LIMIT_KEYS.get(key)
        if spec is None:
            logging.getLogger("sayit.config").warning("server.body_limits: unknown key %r ignored", key)
            continue
        field_name, unit = spec
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
            logging.getLogger("sayit.config").warning(
                "server.body_limits.%s: invalid value %r, using default", key, value
            )
            continue
        values[field_name] = int(value * unit)
    return BodyLimitConfig(**values)


# ---------------------------------------------------------------------------
# Main loader
# ---------------------------------------------------------------------------

def load_config(config_path: str | None = None, env_path: str | None = None) -> Config:
    defaults = Config()
    resolved_config = _resolve_config_path(config_path)
    resolved_env = _resolve_env_path(env_path)
    if resolved_env:
        load_dotenv(resolved_env, override=False)

    raw = _read_yaml(resolved_config)

    server_raw = _pick(raw, "server", default={}) or {}
    gateway_raw = _pick(raw, "gateway", default={}) or {}
    paths_raw = _pick(raw, "paths", default={}) or {}
    asr_raw = _pick(raw, "asr", default={}) or {}
    vad_raw = _pick(raw, "vad", default={}) or {}
    llm_raw = _pick(raw, "llm", default={}) or {}
    public_site_raw = _pick(raw, "public_site", default={}) or {}
    web_demo_raw = _pick(raw, "web_demo", default={}) or {}
    logging_raw = _pick(raw, "logging", default={}) or {}
    telemetry_raw = _pick(raw, "telemetry", default={}) or {}
    admin_raw = _pick(raw, "admin", default={}) or {}
    guard_raw = raw.get("guard")

    host = str(server_raw.get("host") or defaults.server.host)
    port = int(server_raw.get("port") or defaults.server.port)
    backend_host = "127.0.0.1" if host == "0.0.0.0" else host
    debug_llm = bool(logging_raw.get("debug_llm", defaults.logging.debug_llm))

    prompt_dir = _resolve_path(
        paths_raw.get("prompt_dir") or llm_raw.get("prompt_dir"),
        _PROJECT_ROOT / "prompts",
    )

    # --- LLM profile loading ---
    # New format: llm.providers.{name} + llm.desktop / llm.web_demo
    # Legacy format: llm.provider + llm.{azure,openai,...} (still supported)
    providers_raw = _pick(llm_raw, "providers", default={}) or {}
    if providers_raw:
        # New format: build a shared provider pool, then pick by name
        desktop_provider = str(llm_raw.get("desktop") or "").strip()
        web_demo_provider = str(llm_raw.get("web_demo") or "").strip()

        def _profile_from_providers(provider_name: str, env_prefix: str) -> LLMProfile:
            azure = providers_raw.get("azure") or {}
            openai = providers_raw.get("openai") or {}
            groq = providers_raw.get("groq") or {}
            ollama = providers_raw.get("ollama") or {}
            base = LLMProfile(prompt_dir=prompt_dir, debug_llm=debug_llm)
            resolved_provider = _env_str(_env_name(env_prefix, "LLM_PROVIDER"), provider_name or base.provider)
            return LLMProfile(
                enabled=bool(resolved_provider),
                provider=resolved_provider,
                prompt_dir=prompt_dir,
                debug_llm=debug_llm,
                azure_endpoint=_env_str(_env_name(env_prefix, "AZURE_ENDPOINT"), base.azure_endpoint),
                azure_api_key=_env_str(_env_name(env_prefix, "AZURE_API_KEY"), base.azure_api_key),
                azure_deployment=_env_str(_env_name(env_prefix, "AZURE_DEPLOYMENT"), str(azure.get("deployment") or base.azure_deployment)),
                azure_api_version=str(azure.get("api_version") or base.azure_api_version),
                azure_timeout=int(azure.get("timeout_sec") or base.azure_timeout),
                openai_base_url=_env_str(
                    _env_name(env_prefix, "OPENAI_BASE_URL"),
                    str(openai.get("base_url") or base.openai_base_url),
                ),
                openai_api_key=_env_str(_env_name(env_prefix, "OPENAI_API_KEY"), base.openai_api_key),
                openai_model=_env_str(_env_name(env_prefix, "OPENAI_MODEL"), str(openai.get("model") or base.openai_model)),
                openai_timeout=int(openai.get("timeout_sec") or base.openai_timeout),
                openai_temperature=_opt_temperature(
                    _env_name(env_prefix, "OPENAI_TEMPERATURE"), openai, base.openai_temperature
                ),
                openai_reasoning_effort=_opt_reasoning_effort(
                    _env_name(env_prefix, "OPENAI_REASONING_EFFORT"), openai, base.openai_reasoning_effort
                ),
                groq_base_url=_env_str(
                    _env_name(env_prefix, "GROQ_BASE_URL"),
                    str(groq.get("base_url") or base.groq_base_url),
                ),
                groq_api_key=_env_str(_env_name(env_prefix, "GROQ_API_KEY"), base.groq_api_key),
                groq_model=_env_str(_env_name(env_prefix, "GROQ_MODEL"), str(groq.get("model") or base.groq_model)),
                groq_timeout=int(groq.get("timeout_sec") or base.groq_timeout),
                ollama_url=_env_str(_env_name(env_prefix, "OLLAMA_URL"), str(ollama.get("url") or base.ollama_url)),
                ollama_model=_env_str(_env_name(env_prefix, "OLLAMA_MODEL"), str(ollama.get("model") or base.ollama_model)),
                ollama_timeout=int(ollama.get("timeout_sec") or base.ollama_timeout),
            )

        desktop_llm = _profile_from_providers(desktop_provider, "SAYIT")
        web_demo_llm = _profile_from_providers(web_demo_provider, "SAYIT_WEB_DEMO")
        # Web demo falls back to main env vars for keys not set with WEB_DEMO prefix
        for attr in ("azure_api_key", "azure_endpoint", "openai_api_key", "groq_api_key"):
            if not getattr(web_demo_llm, attr):
                object.__setattr__(web_demo_llm, attr, getattr(desktop_llm, attr))
    else:
        # Legacy format
        desktop_llm = _load_llm_profile(llm_raw, prompt_dir=prompt_dir, debug_llm=debug_llm)
        web_demo_llm = _load_llm_profile(
            _pick(web_demo_raw, "llm", default={}) or {},
            prompt_dir=prompt_dir,
            fallback=desktop_llm,
            env_prefix="SAYIT_WEB_DEMO",
            debug_llm=debug_llm,
        )

    # --- Auto-infer provider from available API keys ---
    desktop_llm = _auto_infer_llm(desktop_llm)
    web_demo_llm = _auto_infer_llm(web_demo_llm)

    return Config(
        server=ServerConfig(
            host=host,
            port=port,
            cors_origins=_env_list("SAYIT_CORS_ORIGINS", list(server_raw.get("cors_origins") or defaults.server.cors_origins)),
            body_limits=_load_body_limits(_pick(server_raw, "body_limits", default={}) or {}),
        ),
        gateway=GatewayConfig(
            host=str(gateway_raw.get("host") or defaults.gateway.host),
            port=int(gateway_raw.get("port") or defaults.gateway.port),
            backend_target=str(
                gateway_raw.get("backend_target") or f"http://{backend_host}:{port}"
            ),
            tls_key_file=_resolve_path(
                gateway_raw.get("tls_key_file"),
                _PROJECT_ROOT / "certs" / "dev.key",
            ),
            tls_cert_file=_resolve_path(
                gateway_raw.get("tls_cert_file"),
                _PROJECT_ROOT / "certs" / "dev.crt",
            ),
        ),
        paths=PathsConfig(
            prompt_dir=prompt_dir,
            releases_dir=_resolve_path(paths_raw.get("releases_dir"), _PROJECT_ROOT / "releases"),
            notices_dir=_resolve_path(paths_raw.get("notices_dir"), _PROJECT_ROOT / "notices"),
        ),
        asr=ASRConfig(
            engine=str(asr_raw.get("engine") or defaults.asr.engine),
            model=str(asr_raw.get("model") or defaults.asr.model),
            device=str(asr_raw.get("device") or defaults.asr.device),
            language=_normalize_asr_language(
                _env_str("SAYIT_ASR_LANGUAGE", "") or asr_raw.get("language"),
                defaults.asr.language,
            ),
            itn=bool(asr_raw.get("itn", defaults.asr.itn)),
            vllm_gpu_util=float(asr_raw.get("vllm_gpu_util") or defaults.asr.vllm_gpu_util),
            vllm_max_model_len=int(asr_raw.get("vllm_max_model_len") or defaults.asr.vllm_max_model_len),
            max_concurrency=int(asr_raw.get("max_concurrency") or defaults.asr.max_concurrency),
            batch_max_size=int(asr_raw.get("batch_max_size") or defaults.asr.batch_max_size),
            batch_wait_ms=int(asr_raw.get("batch_wait_ms") or defaults.asr.batch_wait_ms),
            firered_model_dir=_resolve_path(
                _pick(asr_raw, "firered", "model_dir"),
                _PROJECT_ROOT / "pretrained_models",
            ),
            firered_use_int8=bool(_pick(asr_raw, "firered", "use_int8", default=defaults.asr.firered_use_int8)),
            halluc_guard=_normalize_mode3(asr_raw.get("halluc_guard"), defaults.asr.halluc_guard),
        ),
        vad=VADConfig(
            model=str(vad_raw.get("model") or defaults.vad.model),
            max_single_segment_time=int(vad_raw.get("max_single_segment_time") or defaults.vad.max_single_segment_time),
        ),
        llm=desktop_llm,
        public_site=PublicSiteConfig(
            app_name=_clean_display_text(public_site_raw.get("app_name"), defaults.public_site.app_name),
            headline=_clean_display_text(public_site_raw.get("headline"), defaults.public_site.headline),
            subheadline=_clean_display_text(public_site_raw.get("subheadline"), defaults.public_site.subheadline),
            download_label=_clean_display_text(public_site_raw.get("download_label"), defaults.public_site.download_label),
            download_platform=str(public_site_raw.get("download_platform") or defaults.public_site.download_platform),
            download_arch=str(public_site_raw.get("download_arch") or defaults.public_site.download_arch),
        ),
        web_demo=WebDemoConfig(
            enabled=_env_bool("SAYIT_WEB_DEMO_ENABLED", bool(web_demo_raw.get("enabled", defaults.web_demo.enabled))),
            max_duration_sec=int(web_demo_raw.get("max_duration_sec") or defaults.web_demo.max_duration_sec),
            max_concurrency_per_ip=int(web_demo_raw.get("max_concurrency_per_ip") or defaults.web_demo.max_concurrency_per_ip),
            llm=web_demo_llm,
        ),
        logging=LoggingConfig(
            level=_env_str("SAYIT_LOG_LEVEL", str(logging_raw.get("level") or defaults.logging.level)),
            debug_asr=bool(logging_raw.get("debug_asr", defaults.logging.debug_asr)),
            debug_llm=debug_llm,
            file=_resolve_path(logging_raw.get("file"), _PROJECT_ROOT / "runtime" / "logs" / "sayit.log"),
            retention_days=int(logging_raw.get("retention_days") or defaults.logging.retention_days),
            slow_asr_ms=int(logging_raw.get("slow_asr_ms") or defaults.logging.slow_asr_ms),
            slow_llm_ms=int(logging_raw.get("slow_llm_ms") or defaults.logging.slow_llm_ms),
        ),
        telemetry=TelemetryConfig(
            enabled=bool(telemetry_raw.get("enabled", defaults.telemetry.enabled)),
            db_backend=str(telemetry_raw.get("db") or telemetry_raw.get("db_backend") or defaults.telemetry.db_backend),
            db_path=_env_str("SAYIT_DB_URL", "") or _resolve_path(
                telemetry_raw.get("db_path"),
                _PROJECT_ROOT / "runtime" / "telemetry" / "sayit.sqlite3",
            ),
            collect_window_title=bool(telemetry_raw.get("collect_window_title", defaults.telemetry.collect_window_title)),
            collect_exe_path=bool(telemetry_raw.get("collect_exe_path", defaults.telemetry.collect_exe_path)),
            node_id=str(telemetry_raw.get("node_id") or defaults.telemetry.node_id),
            deployment_mode=str(telemetry_raw.get("deployment_mode") or defaults.telemetry.deployment_mode),
        ),
        admin=AdminConfig(
            enabled=bool(admin_raw.get("enabled", defaults.admin.enabled)),
            username=_env_str("SAYIT_ADMIN_USERNAME", str(admin_raw.get("username") or defaults.admin.username)),
            password=_env_str("SAYIT_ADMIN_PASSWORD", str(admin_raw.get("password") or defaults.admin.password)),
        ),
        guard=_load_guard(guard_raw),
        config_file=str(resolved_config),
        env_file=str(resolved_env) if resolved_env else "",
    )
