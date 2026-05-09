"""Diagnostics report upload and indexing endpoints."""

from __future__ import annotations

import json
import re
import secrets
import shutil
import time
import zipfile
from collections import defaultdict
from pathlib import Path

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse

router = APIRouter()

DIAGNOSTICS_DIR = Path(__file__).resolve().parents[2] / "runtime" / "diagnostics_reports"
DIAGNOSTICS_DIR.mkdir(exist_ok=True)

MAX_ZIP_SIZE = 50 * 1024 * 1024
MAX_TOTAL_UNZIPPED_SIZE = 80 * 1024 * 1024
MAX_TOTAL_DISK_USAGE = 500 * 1024 * 1024  # 500MB total cap
MAX_ZIP_ENTRIES = 200

# Upload rate limit: per-IP, max uploads per window
_UPLOAD_RATE_WINDOW = 3600  # 1 hour
_UPLOAD_RATE_MAX = 5
_upload_log: dict[str, list[float]] = defaultdict(list)

# One-time upload tokens (issued via WebSocket, consumed on upload)
_upload_tokens: dict[str, float] = {}  # token -> expiry timestamp
_UPLOAD_TOKEN_TTL = 300  # 5 minutes

_TICKET_ID_RE = re.compile(r"^[a-f0-9]{32}$")


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_upload_rate(ip: str) -> bool:
    now = time.monotonic()
    log = _upload_log[ip]
    # Prune old entries
    _upload_log[ip] = [t for t in log if now - t < _UPLOAD_RATE_WINDOW]
    if len(_upload_log[ip]) >= _UPLOAD_RATE_MAX:
        return False
    _upload_log[ip].append(now)
    return True


def _total_disk_usage() -> int:
    if not DIAGNOSTICS_DIR.exists():
        return 0
    return sum(f.stat().st_size for f in DIAGNOSTICS_DIR.rglob("*") if f.is_file())


def create_upload_token() -> str:
    """Create a one-time upload token. Called from WebSocket handler."""
    token = secrets.token_hex(16)
    _upload_tokens[token] = time.time() + _UPLOAD_TOKEN_TTL
    # Prune expired tokens
    now = time.time()
    expired = [k for k, v in _upload_tokens.items() if v < now]
    for k in expired:
        _upload_tokens.pop(k, None)
    return token


def _consume_token(token: str | None) -> bool:
    if not token:
        return False
    expiry = _upload_tokens.pop(token, None)
    if expiry is None:
        return False
    return time.time() < expiry


def _safe_json_load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _build_index(ticket_id: str, save_dir: Path, zip_size: int) -> dict:
    manifest = _safe_json_load(save_dir / "extracted" / "manifest.json")
    summary = _safe_json_load(save_dir / "extracted" / "summary.json")
    timeline = _safe_json_load(save_dir / "extracted" / "timeline.json")

    return {
        "ticket_id": ticket_id,
        "status": "received",
        "received_at": int(time.time()),
        "zip_size": zip_size,
        "app_version": manifest.get("systemInfo", {}).get("appVersion"),
        "platform": manifest.get("systemInfo", {}).get("platform"),
        "issue_window_label": manifest.get("issueWindowLabel"),
        "summary": {
            "errors": summary.get("summary", {}).get("errors"),
            "warnings": summary.get("summary", {}).get("warnings"),
            "files_scanned": summary.get("filesScanned"),
            "timeline_entries": summary.get("totalTimelineEntries"),
        },
        "latest_timeline": timeline[-5:] if isinstance(timeline, list) else [],
    }


def _extract_zip(zip_path: Path, dest_dir: Path) -> None:
    with zipfile.ZipFile(zip_path, "r") as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ZIP_ENTRIES:
            raise ValueError("Too many files in diagnostics archive")

        total_size = sum(info.file_size for info in infos)
        if total_size > MAX_TOTAL_UNZIPPED_SIZE:
            raise ValueError("Diagnostics archive is too large after extraction")

        for info in infos:
            extracted_path = (dest_dir / info.filename).resolve()
            if not str(extracted_path).startswith(str(dest_dir.resolve())):
                raise ValueError("Unsafe file path in diagnostics archive")

        archive.extractall(dest_dir)


@router.post("/api/diagnostics")
async def upload_diagnostics(request: Request, diagnostics: UploadFile = File(...)):
    # Token auth (optional for now — if token provided, validate it)
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else None
    if token and not _consume_token(token):
        return JSONResponse(status_code=401, content={"error": "Invalid or expired upload token"})

    # Rate limit by IP
    ip = _client_ip(request)
    if not _check_upload_rate(ip):
        return JSONResponse(status_code=429, content={"error": "Upload rate limit exceeded (max 5 per hour)"})

    if not diagnostics.filename or not diagnostics.filename.lower().endswith(".zip"):
        return JSONResponse(status_code=400, content={"error": "Only .zip diagnostics packages are accepted"})

    content = await diagnostics.read()
    if len(content) > MAX_ZIP_SIZE:
        return JSONResponse(status_code=413, content={"error": "Diagnostics package exceeds 50MB"})

    # Disk usage cap
    if _total_disk_usage() + len(content) > MAX_TOTAL_DISK_USAGE:
        return JSONResponse(status_code=507, content={"error": "Diagnostics storage full"})

    ticket_id = secrets.token_hex(16)
    save_dir = DIAGNOSTICS_DIR / ticket_id
    save_dir.mkdir(exist_ok=True)

    zip_path = save_dir / "diagnostics.zip"
    zip_path.write_bytes(content)

    extracted_dir = save_dir / "extracted"
    if extracted_dir.exists():
        shutil.rmtree(extracted_dir)
    extracted_dir.mkdir(exist_ok=True)

    try:
        _extract_zip(zip_path, extracted_dir)
        index = _build_index(ticket_id, save_dir, len(content))
        (save_dir / "index.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return JSONResponse(
            status_code=200,
            content={
                "ticket_id": ticket_id,
                "message": "Diagnostics package received",
                "size": len(content),
                "index": index["summary"],
            },
        )
    except Exception as exc:
        (save_dir / "index.json").write_text(
            json.dumps(
                {
                    "ticket_id": ticket_id,
                    "status": "invalid",
                    "error": str(exc),
                    "received_at": int(time.time()),
                    "zip_size": len(content),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return JSONResponse(
            status_code=400,
            content={"error": str(exc), "ticket_id": ticket_id},
        )


@router.get("/api/diagnostics/{ticket_id}")
async def get_diagnostics_status(ticket_id: str):
    # Validate ticket_id format to prevent path traversal
    if not _TICKET_ID_RE.fullmatch(ticket_id):
        return JSONResponse(status_code=400, content={"error": "Invalid ticket ID format"})

    report_dir = (DIAGNOSTICS_DIR / ticket_id).resolve()
    if not report_dir.is_relative_to(DIAGNOSTICS_DIR.resolve()):
        return JSONResponse(status_code=400, content={"error": "Invalid ticket ID"})

    index_path = report_dir / "index.json"
    if not report_dir.exists() or not index_path.exists():
        return JSONResponse(status_code=404, content={"error": "Ticket not found"})

    return JSONResponse(status_code=200, content=_safe_json_load(index_path))
