"""Simple in-memory rate limiter middleware for FastAPI."""
from __future__ import annotations

import time
from collections import defaultdict

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

_PRUNE_INTERVAL = 300  # prune stale buckets every 5 minutes
_BUCKET_TTL = 600  # remove buckets idle for 10 minutes


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Token-bucket rate limiter keyed by client IP.

    Parameters
    ----------
    app : ASGI app
    requests_per_minute : max requests per minute per IP (default 120)
    burst : max burst size (default 30)
    exclude_paths : path prefixes exempt from limiting (e.g. healthz)
    """

    def __init__(self, app, *, requests_per_minute: int = 120, burst: int = 30, exclude_paths: tuple[str, ...] = ()):
        super().__init__(app)
        self._rate = requests_per_minute / 60.0  # tokens per second
        self._burst = burst
        self._exclude = exclude_paths
        self._buckets: dict[str, list[float]] = defaultdict(lambda: [float(burst), time.monotonic()])
        self._last_prune = time.monotonic()

    def _client_ip(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _prune_stale(self) -> None:
        now = time.monotonic()
        if now - self._last_prune < _PRUNE_INTERVAL:
            return
        self._last_prune = now
        stale = [ip for ip, bucket in self._buckets.items() if now - bucket[1] > _BUCKET_TTL]
        for ip in stale:
            del self._buckets[ip]

    def _allow(self, ip: str) -> bool:
        bucket = self._buckets[ip]
        now = time.monotonic()
        elapsed = now - bucket[1]
        bucket[1] = now
        bucket[0] = min(self._burst, bucket[0] + elapsed * self._rate)
        if bucket[0] >= 1.0:
            bucket[0] -= 1.0
            return True
        return False

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in self._exclude):
            return await call_next(request)
        self._prune_stale()
        ip = self._client_ip(request)
        if not self._allow(ip):
            return JSONResponse({"error": "rate limit exceeded"}, status_code=429)
        return await call_next(request)
