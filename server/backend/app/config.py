from __future__ import annotations

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

@dataclass(slots=True)
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: list[str] = field(default_factory=lambda: ["*"])


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
    headline: str = "随口说，出色写。"
    subheadline: str = "用说话代替打字，AI 实时把口语变成可以直接用的书面表达。"
    download_label: str = "下载 Windows 客户端"
    download_platform: str = "win32"
    download_arch: str = "x64"


@dataclass(slots=True)
class WebDemoConfig:
    enabled: bool = True
    max_duration_sec: int = 600
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
        config_file=str(resolved_config),
        env_file=str(resolved_env) if resolved_env else "",
    )
