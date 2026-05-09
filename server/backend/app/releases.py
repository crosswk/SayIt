from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote

import yaml
from fastapi import HTTPException

from .config import Config

_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_DEFAULT_MANIFEST_NAME = "latest.yml"


def _validate_segment(value: str, field_name: str) -> str:
    if not value or not _SAFE_SEGMENT_RE.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"invalid {field_name}")
    return value


def _release_dir(cfg: Config, platform: str, arch: str) -> Path:
    base_dir = Path(cfg.paths.releases_dir).resolve()
    safe_platform = _validate_segment(platform, "platform")
    safe_arch = _validate_segment(arch, "arch")
    release_dir = (base_dir / safe_platform / safe_arch).resolve()
    if not release_dir.is_relative_to(base_dir):
        raise HTTPException(status_code=400, detail="invalid release path")
    return release_dir


def _download_path(platform: str, arch: str, filename: str) -> str:
    return f"/api/desktop-updates/{platform}/{arch}/{quote(filename, safe='/')}"


def resolve_release_file(cfg: Config, platform: str, arch: str, filename: str) -> Path:
    release_dir = _release_dir(cfg, platform, arch)
    relative_name = filename.lstrip("/\\") or _DEFAULT_MANIFEST_NAME
    candidate = (release_dir / relative_name).resolve()
    if not candidate.is_relative_to(release_dir) or not candidate.is_file():
        raise HTTPException(status_code=404, detail="release file not found")
    return candidate


def read_release_manifest(cfg: Config, platform: str, arch: str) -> dict:
    manifest_path = resolve_release_file(cfg, platform, arch, _DEFAULT_MANIFEST_NAME)
    payload = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}

    files = []
    for item in payload.get("files") or []:
        if not isinstance(item, dict):
            continue
        entry = {key: value for key, value in item.items() if isinstance(key, str)}
        filename = entry.get("url") or entry.get("name")
        if isinstance(filename, str):
            entry["download_path"] = _download_path(platform, arch, filename)
        files.append(entry)

    manifest = {
        "platform": platform,
        "arch": arch,
        "version": payload.get("version"),
        "releaseDate": payload.get("releaseDate"),
        "releaseName": payload.get("releaseName"),
        "releaseNotes": payload.get("releaseNotes"),
        "path": payload.get("path"),
        "sha512": payload.get("sha512"),
        "stagingPercentage": payload.get("stagingPercentage"),
        "files": files,
    }

    installer_path = manifest.get("path")
    if isinstance(installer_path, str):
        manifest["download_path"] = _download_path(platform, arch, installer_path)

    return manifest


def read_public_download(cfg: Config, platform: str, arch: str) -> dict | None:
    try:
        manifest = read_release_manifest(cfg, platform, arch)
    except HTTPException as exc:
        if exc.status_code == 404:
            return None
        raise

    download_path = manifest.get("download_path")
    if not isinstance(download_path, str) or not download_path:
        return None

    return {
        "platform": platform,
        "arch": arch,
        "version": manifest.get("version"),
        "filename": manifest.get("path"),
        "url": download_path,
        "releaseDate": manifest.get("releaseDate"),
    }
