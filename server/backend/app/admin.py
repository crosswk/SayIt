from __future__ import annotations

import secrets
from dataclasses import dataclass, field, fields
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .config import Config
from .telemetry import TelemetryService

_UI_PATH = Path(__file__).resolve().parents[2] / "web" / "admin.html"
_SECURITY = HTTPBasic(auto_error=False)


def _config(request: Request) -> Config:
    cfg = getattr(request.app.state, "config", None)
    if cfg is None:
        raise HTTPException(status_code=503, detail="config not initialized")
    return cfg


def _telemetry(request: Request) -> TelemetryService:
    service = getattr(request.app.state, "telemetry", None)
    if service is None:
        raise HTTPException(status_code=503, detail="telemetry service not initialized")
    return service


def _require_admin(
    request: Request,
    credentials: HTTPBasicCredentials | None = Depends(_SECURITY),
) -> None:
    cfg = _config(request)
    if not cfg.admin.enabled:
        raise HTTPException(status_code=404, detail="admin disabled")
    if not cfg.admin.password:
        raise HTTPException(status_code=503, detail="admin password not configured")

    username_ok = credentials is not None and secrets.compare_digest(credentials.username, cfg.admin.username)
    password_ok = credentials is not None and secrets.compare_digest(credentials.password, cfg.admin.password)
    if username_ok and password_ok:
        return

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="admin authentication required",
        headers={"WWW-Authenticate": 'Basic realm="SayIt Admin"'},
    )


# ---------------------------------------------------------------------------
# Shared filter parameters
# ---------------------------------------------------------------------------

@dataclass
class _FilterParams:
    """Common query filters shared across admin endpoints."""
    from_: str | None = None
    to: str | None = None
    user_id: str | None = None
    user_name: str | None = None
    app: str | None = None
    process_name: str | None = None
    client_ip: str | None = None
    status: str | None = None
    node_id: str | None = None
    asr_model: str | None = None
    llm_model: str | None = None
    ai_enabled: str | None = None
    source: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        d = {f.name.rstrip("_"): getattr(self, f.name) for f in fields(self)}
        # dataclass field is "from_" but dict key must be "from"
        if "from_" in d:
            d["from"] = d.pop("from_")
        return d


def _parse_filters(request: Request) -> _FilterParams:
    """Build *_FilterParams* from query string — single source of truth."""
    q = request.query_params
    return _FilterParams(
        from_=q.get("from"),
        to=q.get("to"),
        user_id=q.get("user_id"),
        user_name=q.get("user_name"),
        app=q.get("app"),
        process_name=q.get("process_name"),
        client_ip=q.get("client_ip"),
        status=q.get("status"),
        node_id=q.get("node_id"),
        asr_model=q.get("asr_model"),
        llm_model=q.get("llm_model"),
        ai_enabled=q.get("ai_enabled"),
        source=q.get("source"),
    )


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(_require_admin)])

# Serve admin UI without auth (login is handled client-side)
_public_router = APIRouter(prefix="/admin", tags=["admin"])


@_public_router.get("")
@_public_router.get("/")
async def admin_ui() -> FileResponse:
    return FileResponse(_UI_PATH)


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------

@router.get("/api/overview")
async def overview(request: Request, f: _FilterParams = Depends(_parse_filters)) -> JSONResponse:
    return JSONResponse(_telemetry(request).get_overview(f.to_dict()))


@router.get("/api/sessions")
async def sessions(
    request: Request,
    f: _FilterParams = Depends(_parse_filters),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    sort: str | None = Query(default=None),
) -> JSONResponse:
    return JSONResponse(_telemetry(request).list_sessions(f.to_dict(), limit=limit, offset=offset, sort=sort))


@router.get("/api/sessions/{session_id}")
async def session_detail(request: Request, session_id: str) -> JSONResponse:
    detail = _telemetry(request).get_session_detail(session_id)
    if not detail:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(detail)


@router.get("/api/metrics/by-app")
async def metrics_by_app(request: Request, f: _FilterParams = Depends(_parse_filters)) -> JSONResponse:
    return JSONResponse(_telemetry(request).metric_by_group(f.to_dict(), "process_name"))


@router.get("/api/metrics/by-user")
async def metrics_by_user(request: Request, f: _FilterParams = Depends(_parse_filters)) -> JSONResponse:
    return JSONResponse(_telemetry(request).metric_by_group(f.to_dict(), "user_id"))


@router.get("/api/metrics/by-model")
async def metrics_by_model(request: Request, f: _FilterParams = Depends(_parse_filters)) -> JSONResponse:
    d = f.to_dict()
    return JSONResponse({
        "asr": _telemetry(request).metric_by_group(d, "asr_model"),
        "llm": _telemetry(request).metric_by_group(d, "llm_model"),
    })


@router.get("/api/metrics/timeline")
async def metrics_timeline(
    request: Request,
    f: _FilterParams = Depends(_parse_filters),
    bucket: str = Query(default="day"),
) -> JSONResponse:
    return JSONResponse(_telemetry(request).timeline(f.to_dict(), "hour" if bucket == "hour" else "day"))


@router.get("/api/metrics/duration-distribution")
async def duration_distribution(request: Request, f: _FilterParams = Depends(_parse_filters)) -> JSONResponse:
    return JSONResponse(_telemetry(request).duration_distribution(f.to_dict()))


@router.get("/api/metrics/percentiles")
async def metrics_percentiles(request: Request, f: _FilterParams = Depends(_parse_filters)) -> JSONResponse:
    return JSONResponse(_telemetry(request).get_percentiles(f.to_dict()))


@router.get("/api/service-logs")
async def service_logs(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    level: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    q: str | None = Query(default=None),
) -> JSONResponse:
    return JSONResponse(_telemetry(request).list_service_logs(limit=limit, level=level, from_=from_, to=to, q=q))


@router.get("/api/system-info")
async def system_info(request: Request) -> JSONResponse:
    cfg = _config(request)
    llm = cfg.llm
    provider = llm.provider.lower() if llm.enabled else None
    model_map = {"openai": llm.openai_model, "azure": llm.azure_deployment, "groq": llm.groq_model, "ollama": llm.ollama_model}
    web_llm = cfg.web_demo.llm
    web_provider = web_llm.provider.lower() if web_llm.enabled else None
    web_model_map = {"openai": web_llm.openai_model, "azure": web_llm.azure_deployment, "groq": web_llm.groq_model, "ollama": web_llm.ollama_model}
    return JSONResponse({
        "asr_engine": cfg.asr.engine,
        "asr_model": cfg.asr.model,
        "llm": {"enabled": llm.enabled, "provider": provider, "model": model_map.get(provider, "-") if provider else "-"},
        "web_demo_llm": {"enabled": web_llm.enabled, "provider": web_provider, "model": web_model_map.get(web_provider, "-") if web_provider else "-"},
        "web_demo": {"enabled": cfg.web_demo.enabled, "max_duration_sec": cfg.web_demo.max_duration_sec, "max_concurrency_per_ip": cfg.web_demo.max_concurrency_per_ip},
        "node_id": cfg.telemetry.node_id,
        "deployment_mode": cfg.telemetry.deployment_mode,
        "resources": _collect_resources(),
    })


def _collect_resources() -> dict:
    """Collect CPU / memory / disk / GPU metrics."""
    import psutil

    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    boot = psutil.boot_time()
    uptime_sec = int(__import__("time").time() - boot)
    info: dict = {
        "cpu_percent": psutil.cpu_percent(interval=0),
        "cpu_count": psutil.cpu_count(),
        "mem_total_gb": round(mem.total / (1 << 30), 1),
        "mem_used_gb": round(mem.used / (1 << 30), 1),
        "mem_percent": mem.percent,
        "disk_total_gb": round(disk.total / (1 << 30), 1),
        "disk_used_gb": round(disk.used / (1 << 30), 1),
        "disk_percent": disk.percent,
        "uptime_sec": uptime_sec,
        "gpus": [],
    }
    try:
        import subprocess

        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0:
            for line in r.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 6:
                    info["gpus"].append({
                        "index": int(parts[0]),
                        "name": parts[1],
                        "util_percent": int(parts[2]),
                        "mem_used_mb": int(parts[3]),
                        "mem_total_mb": int(parts[4]),
                        "temp_c": int(parts[5]),
                    })
    except Exception:
        pass
    return info


# ---------------------------------------------------------------------------
# Protected operational endpoints (moved from public API)
# ---------------------------------------------------------------------------

@router.get("/api/healthz-details")
async def healthz_details(request: Request) -> JSONResponse:
    cfg = _config(request)
    from .main import asr_engine, llm_engine, web_demo_llm_engine, _active_ws_count, _get_telemetry
    return JSONResponse({
        "status": "ok",
        "asr": asr_engine is not None,
        "asr_engine": cfg.asr.engine,
        "asr_model": cfg.asr.model,
        "llm": cfg.llm.enabled and llm_engine is not None,
        "web_demo": {
            "enabled": cfg.web_demo.enabled,
            "llm": cfg.web_demo.llm.enabled and web_demo_llm_engine is not None,
            "max_duration_sec": cfg.web_demo.max_duration_sec,
            "max_concurrency_per_ip": cfg.web_demo.max_concurrency_per_ip,
        },
        "telemetry": _get_telemetry().health_summary() if _get_telemetry() else None,
        "active_connections": _active_ws_count,
    })


@router.get("/api/hotwords")
async def get_hotwords(request: Request) -> JSONResponse:
    from .main import asr_engine
    return JSONResponse(asr_engine.get_hotwords() if asr_engine else [])


@router.put("/api/hotwords")
async def put_hotwords(request: Request, payload: list[str] = Body(default=[])) -> JSONResponse:
    from .main import asr_engine
    if not asr_engine:
        return JSONResponse({"error": "ASR not loaded"}, status_code=503)
    return JSONResponse(asr_engine.set_hotwords(payload))


@router.get("/api/asr-tuning")
async def get_asr_tuning(request: Request) -> JSONResponse:
    from .main import asr_engine
    if not asr_engine:
        return JSONResponse({"error": "ASR not loaded"}, status_code=503)
    return JSONResponse(asr_engine.get_batching())


@router.put("/api/asr-tuning")
async def put_asr_tuning(request: Request, payload: dict = Body(default={})) -> JSONResponse:
    from .main import asr_engine
    if not asr_engine:
        return JSONResponse({"error": "ASR not loaded"}, status_code=503)
    return JSONResponse(asr_engine.set_batching(
        batch_max_size=payload.get("batch_max_size"),
        batch_wait_ms=payload.get("batch_wait_ms"),
    ))


@router.get("/api/feedback")
async def list_feedback(
    request: Request,
    t: TelemetryService = Depends(_telemetry),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> JSONResponse:
    import json as _json
    db = t._db
    p = db.dialect.placeholder
    rows = db.fetch_all(
        f"SELECT * FROM feedback ORDER BY created_at DESC LIMIT {p} OFFSET {p}",
        (limit, offset),
    )
    total = db.fetch_one("SELECT COUNT(*) as cnt FROM feedback")
    items = []
    for r in rows:
        item = dict(r)
        for k in ("transcript_json", "context_json"):
            if item.get(k):
                try:
                    item[k] = _json.loads(item[k])
                except Exception:
                    pass
        items.append(item)
    return JSONResponse({"items": items, "total": (total or {}).get("cnt", 0)})
