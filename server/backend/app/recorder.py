"""Recording manager: disabled – audio is not persisted server-side."""
from __future__ import annotations

import logging

from .config import Config

logger = logging.getLogger("sayit.recorder")


class Recorder:
    """No-op recorder. Audio files are never saved on the backend."""

    def __init__(self, config: Config) -> None:
        pass

    def save(self, pcm_bytes: bytes, connection_id: str) -> None:
        return None

    def list_recordings(self) -> list[dict]:
        return []

    def get_path(self, name: str) -> None:
        return None

    def cleanup_expired(self, retention_days: int) -> int:
        return 0
