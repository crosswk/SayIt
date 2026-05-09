from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import Config
from .db import Database

logger = logging.getLogger("sayit.telemetry")


def _now_ms() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _safe_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_text(value: Any, max_len: int = 512) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_len]


def _parse_time(value: str | None) -> int | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)
    try:
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


class TelemetryService:
    def __init__(self, cfg: Config, db: Database) -> None:
        self._cfg = cfg
        self._db = db

    @property
    def enabled(self) -> bool:
        return bool(self._cfg.telemetry.enabled)

    def health_summary(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "db_path": self._cfg.telemetry.db_path,
            "node_id": self._cfg.telemetry.node_id,
            "deployment_mode": self._cfg.telemetry.deployment_mode,
            "log_file": self._cfg.logging.file,
        }

    def record_connection_event(self, connection_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self._event(None, connection_id, event_type, payload)

    def _event(self, session_id: str | None, connection_id: str, event_type: str, payload: dict[str, Any] | None = None) -> None:
        if not self.enabled:
            return
        try:
            self._db.execute(
                """
                INSERT INTO usage_events(session_id, connection_id, event_type, event_time, payload_json)
                VALUES(?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    connection_id,
                    event_type,
                    _now_ms(),
                    json.dumps(payload or {}, ensure_ascii=False),
                ),
            )
        except Exception:
            logger.exception("Failed to persist usage event %s", event_type)

    def create_session(
        self,
        *,
        connection_id: str,
        client_ip: str | None,
        forwarded_for: str | None,
        client_meta: dict[str, Any] | None,
        app_context: dict[str, Any] | None,
        source: str = "live",
    ) -> str | None:
        if not self.enabled:
            return None

        session_id = uuid4().hex
        now = _now_ms()
        client_meta = client_meta or {}
        app_context = app_context or {}
        exe_path = _safe_text(app_context.get("exe_path")) if self._cfg.telemetry.collect_exe_path else None
        window_title = _safe_text(app_context.get("window_title")) if self._cfg.telemetry.collect_window_title else None

        try:
            self._db.execute(
                """
                INSERT INTO usage_sessions(
                    session_id, connection_id, started_at, user_id, user_name, device_id, hostname,
                    client_version, platform, local_ip, client_ip, forwarded_for, node_id, deployment_mode,
                    source, process_name, exe_path, window_title, window_class, focus_class, control_type,
                    llm_enabled, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    connection_id,
                    now,
                    _safe_text(client_meta.get("user_id")),
                    _safe_text(client_meta.get("user_name")),
                    _safe_text(client_meta.get("device_id")),
                    _safe_text(client_meta.get("hostname")),
                    _safe_text(client_meta.get("client_version")),
                    _safe_text(client_meta.get("platform")),
                    _safe_text(client_meta.get("local_ip"), 64),
                    _safe_text(client_ip, 128),
                    _safe_text(forwarded_for, 512),
                    self._cfg.telemetry.node_id,
                    self._cfg.telemetry.deployment_mode,
                    _safe_text(source, 32),
                    _safe_text(app_context.get("process_name")),
                    exe_path,
                    window_title,
                    _safe_text(app_context.get("window_class")),
                    _safe_text(app_context.get("focus_class")),
                    _safe_text(app_context.get("control_type")),
                    0,
                    "recording",
                    now,
                    now,
                ),
            )
            self._event(
                session_id,
                connection_id,
                "session_started",
                {"client_meta": client_meta, "app_context": app_context, "client_ip": client_ip, "forwarded_for": forwarded_for},
            )
            return session_id
        except Exception:
            logger.exception("Failed to create usage session")
            return None

    def update_stop(
        self,
        session_id: str | None,
        connection_id: str,
        *,
        ptt_hold_ms: int | None,
        audio_duration_ms: int,
        is_empty_audio: bool,
    ) -> None:
        if not self.enabled or not session_id:
            return
        now = _now_ms()
        try:
            self._db.execute(
                """
                UPDATE usage_sessions
                SET stopped_at=?, ptt_hold_ms=?, audio_duration_ms=?, is_empty_audio=?, updated_at=?
                WHERE session_id=?
                """,
                (now, ptt_hold_ms, max(0, audio_duration_ms), 1 if is_empty_audio else 0, now, session_id),
            )
            self._event(
                session_id,
                connection_id,
                "session_stopped",
                {"ptt_hold_ms": ptt_hold_ms, "audio_duration_ms": audio_duration_ms, "is_empty_audio": is_empty_audio},
            )
        except Exception:
            logger.exception("Failed to update stop metadata for session %s", session_id)

    def record_debug_audio(self, session_id: str | None, connection_id: str, recording_path: Path | None) -> None:
        pass

    def record_pipeline_result(
        self,
        session_id: str | None,
        connection_id: str,
        *,
        asr_provider: str,
        asr_model: str,
        asr_lang: str,
        asr_ms: int,
        asr_debug: dict[str, Any],
        llm_enabled: bool,
        llm_provider: str | None,
        llm_model: str | None,
        llm_ms: int,
        has_result: bool,
    ) -> None:
        if not self.enabled or not session_id:
            return
        timings = (asr_debug or {}).get("timings", {}) if isinstance(asr_debug, dict) else {}
        now = _now_ms()
        status = "success" if has_result else "empty_result"
        try:
            self._db.execute(
                """
                UPDATE usage_sessions
                SET asr_provider=?, asr_model=?, asr_lang=?, asr_ms=?, vad_ms=?, queue_wait_ms=?, infer_ms=?,
                    batch_exec_ms=?, batch_size=?, seg_count=?, llm_enabled=?, llm_provider=?, llm_model=?, llm_ms=?,
                    is_empty_result=?, status=?, finished_at=?, updated_at=?
                WHERE session_id=?
                """,
                (
                    _safe_text(asr_provider),
                    _safe_text(asr_model),
                    _safe_text(asr_lang),
                    max(0, int(asr_ms)),
                    _safe_int(timings.get("vad_ms")) or 0,
                    _safe_int(timings.get("queue_wait_ms")) or 0,
                    _safe_int(timings.get("infer_ms")) or 0,
                    _safe_int(timings.get("batch_exec_ms")) or 0,
                    _safe_int(timings.get("batch_size")) or 0,
                    _safe_int(timings.get("seg_count")) or 0,
                    1 if llm_enabled else 0,
                    _safe_text(llm_provider),
                    _safe_text(llm_model),
                    max(0, int(llm_ms)),
                    0 if has_result else 1,
                    status,
                    now,
                    now,
                    session_id,
                ),
            )
            self._event(
                session_id,
                connection_id,
                "asr_completed",
                {
                    "asr_provider": asr_provider,
                    "asr_model": asr_model,
                    "asr_lang": asr_lang,
                    "asr_ms": asr_ms,
                },
            )
            if llm_enabled:
                self._event(
                    session_id,
                    connection_id,
                    "llm_completed",
                    {
                        "llm_provider": llm_provider,
                        "llm_model": llm_model,
                        "llm_ms": llm_ms,
                    },
                )
            self._event(
                session_id,
                connection_id,
                "session_finished",
                {
                    "asr_ms": asr_ms,
                    "llm_enabled": llm_enabled,
                    "llm_ms": llm_ms,
                    "has_result": has_result,
                },
            )
        except Exception:
            logger.exception("Failed to persist pipeline result for session %s", session_id)

    def mark_failure(self, session_id: str | None, connection_id: str, code: str, message: str) -> None:
        if not self.enabled or not session_id:
            return
        now = _now_ms()
        try:
            self._db.execute(
                """
                UPDATE usage_sessions
                SET status='failed', error_code=?, error_message=?, finished_at=COALESCE(finished_at, ?), updated_at=?
                WHERE session_id=?
                """,
                (_safe_text(code, 128), _safe_text(message, 2000), now, now, session_id),
            )
            self._event(session_id, connection_id, "session_failed", {"error_code": code, "error_message": message})
        except Exception:
            logger.exception("Failed to mark failure for session %s", session_id)

    def mark_disconnected(self, session_id: str | None, connection_id: str) -> None:
        if not self.enabled or not session_id:
            self._event(None, connection_id, "ws_disconnected", None)
            return
        now = _now_ms()
        try:
            session = self._db.fetch_one("SELECT status FROM usage_sessions WHERE session_id=?", (session_id,))
            if not session:
                return
            current_status = session.get("status")
            if current_status in {"success", "empty_result", "failed", "short_audio", "empty_audio"}:
                self._event(session_id, connection_id, "ws_disconnected", {"final_status": current_status})
                return
            self._db.execute(
                """
                UPDATE usage_sessions
                SET status='disconnected', finished_at=COALESCE(finished_at, ?), updated_at=?
                WHERE session_id=?
                """,
                (now, now, session_id),
            )
            self._event(session_id, connection_id, "ws_disconnected", {"final_status": "disconnected"})
        except Exception:
            logger.exception("Failed to mark disconnect for session %s", session_id)

    def mark_terminal_status(self, session_id: str | None, connection_id: str, status: str, message: str | None = None) -> None:
        if not self.enabled or not session_id:
            return
        now = _now_ms()
        try:
            self._db.execute(
                """
                UPDATE usage_sessions
                SET status=?, finished_at=COALESCE(finished_at, ?), error_message=COALESCE(error_message, ?), updated_at=?
                WHERE session_id=?
                """,
                (status, now, _safe_text(message, 2000), now, session_id),
            )
            self._event(session_id, connection_id, "session_status", {"status": status, "message": message})
        except Exception:
            logger.exception("Failed to mark terminal status %s for session %s", status, session_id)

    def _build_filters(self, filters: dict[str, Any]) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []

        def _like(field: str, value: Any) -> None:
            if not value:
                return
            escaped = str(value).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append(f"{field} LIKE ? ESCAPE '\\'")
            params.append(f"%{escaped}%")

        from_ts = _parse_time(filters.get("from"))
        to_ts = _parse_time(filters.get("to"))
        if from_ts is not None:
            clauses.append("started_at >= ?")
            params.append(from_ts)
        if to_ts is not None:
            clauses.append("started_at <= ?")
            params.append(to_ts)

        for key, field in [
            ("user_id", "user_id"),
            ("status", "status"),
            ("node_id", "node_id"),
            ("client_ip", "client_ip"),
            ("asr_model", "asr_model"),
            ("llm_model", "llm_model"),
            ("process_name", "process_name"),
        ]:
            value = filters.get(key)
            if value:
                clauses.append(f"{field} = ?")
                params.append(value)

        ai_enabled = filters.get("ai_enabled")
        if ai_enabled is not None and ai_enabled != "":
            clauses.append("llm_enabled = ?")
            params.append(1 if str(ai_enabled).lower() in {"1", "true", "yes"} else 0)

        _like("user_name", filters.get("user_name"))
        _like("process_name", filters.get("app"))

        source = filters.get("source")
        if source:
            clauses.append("source = ?")
            params.append(source)

        return (" WHERE " + " AND ".join(clauses)) if clauses else "", params

    def get_overview(self, filters: dict[str, Any]) -> dict[str, Any]:
        where_sql, params = self._build_filters(filters)
        summary = self._db.fetch_one(
            f"""
            SELECT
                COUNT(*) AS total_sessions,
                COALESCE(SUM(ptt_hold_ms), 0) AS total_hold_ms,
                COALESCE(SUM(audio_duration_ms), 0) AS total_audio_ms,
                COALESCE(AVG(NULLIF(asr_ms, 0)), 0) AS avg_asr_ms,
                COALESCE(AVG(CASE WHEN llm_enabled = 1 THEN llm_ms END), 0) AS avg_llm_ms,
                COALESCE(SUM(CASE WHEN is_empty_result = 1 THEN 1 ELSE 0 END), 0) AS empty_results,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_sessions
            FROM usage_sessions
            {where_sql}
            """,
            tuple(params),
        ) or {}
        top_apps = self._db.fetch_all(
            f"""
            SELECT COALESCE(process_name, 'unknown') AS process_name, COUNT(*) AS sessions
            FROM usage_sessions
            {where_sql}
            GROUP BY COALESCE(process_name, 'unknown')
            ORDER BY sessions DESC, process_name ASC
            LIMIT 10
            """,
            tuple(params),
        )
        total_sessions = int(summary.get("total_sessions") or 0)
        return {
            "total_sessions": total_sessions,
            "total_hold_ms": int(summary.get("total_hold_ms") or 0),
            "total_audio_ms": int(summary.get("total_audio_ms") or 0),
            "avg_asr_ms": round(float(summary.get("avg_asr_ms") or 0), 2),
            "avg_llm_ms": round(float(summary.get("avg_llm_ms") or 0), 2),
            "empty_result_rate": round(((summary.get("empty_results") or 0) / total_sessions), 4) if total_sessions else 0,
            "error_rate": round(((summary.get("failed_sessions") or 0) / total_sessions), 4) if total_sessions else 0,
            "top_apps": top_apps,
        }

    def list_sessions(self, filters: dict[str, Any], limit: int, offset: int, sort: str | None = None) -> dict[str, Any]:
        where_sql, params = self._build_filters(filters)
        count_row = self._db.fetch_one(f"SELECT COUNT(*) AS total FROM usage_sessions {where_sql}", tuple(params)) or {"total": 0}
        # Sort support
        _SORT_MAP = {
            "time_asc": "started_at ASC",
            "time_desc": "started_at DESC",
            "asr_asc": "asr_ms ASC",
            "asr_desc": "asr_ms DESC",
            "audio_asc": "audio_duration_ms ASC",
            "audio_desc": "audio_duration_ms DESC",
        }
        order = _SORT_MAP.get(sort, "started_at DESC")
        items = self._db.fetch_all(
            f"""
            SELECT
                session_id, connection_id, started_at, stopped_at, finished_at,
                user_id, user_name, device_id, hostname, client_version, platform,
                client_ip, forwarded_for, local_ip, source, process_name, window_title, ptt_hold_ms, audio_duration_ms,
                asr_model, asr_ms, llm_enabled, llm_model, llm_ms, status,
                error_code, error_message, node_id, debug_audio_saved, recording_path
            FROM usage_sessions
            {where_sql}
            ORDER BY {order}
            LIMIT ? OFFSET ?
            """,
            tuple(params + [limit, offset]),
        )
        return {"total": int(count_row.get("total") or 0), "items": items}

    def get_session_detail(self, session_id: str) -> dict[str, Any] | None:
        session = self._db.fetch_one("SELECT * FROM usage_sessions WHERE session_id=?", (session_id,))
        if not session:
            return None
        events = self._db.fetch_all(
            """
            SELECT event_type, event_time, payload_json
            FROM usage_events
            WHERE session_id = ?
            ORDER BY event_time ASC
            """,
            (session_id,),
        )
        for event in events:
            try:
                event["payload"] = json.loads(event.pop("payload_json") or "{}")
            except json.JSONDecodeError:
                event["payload"] = {}
        session["events"] = events
        return session

    _ALLOWED_GROUP_FIELDS = frozenset({"process_name", "user_id", "asr_model", "llm_model", "node_id", "platform", "source", "status"})

    def metric_by_group(self, filters: dict[str, Any], field: str, limit: int = 20) -> list[dict[str, Any]]:
        if field not in self._ALLOWED_GROUP_FIELDS:
            raise ValueError(f"invalid group field: {field}")
        where_sql, params = self._build_filters(filters)
        return self._db.fetch_all(
            f"""
            SELECT
                COALESCE({field}, 'unknown') AS label,
                COUNT(*) AS sessions,
                COALESCE(SUM(audio_duration_ms), 0) AS total_audio_ms,
                COALESCE(AVG(NULLIF(asr_ms, 0)), 0) AS avg_asr_ms,
                COALESCE(AVG(CASE WHEN llm_enabled = 1 THEN llm_ms END), 0) AS avg_llm_ms,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_sessions
            FROM usage_sessions
            {where_sql}
            GROUP BY COALESCE({field}, 'unknown')
            ORDER BY sessions DESC, label ASC
            LIMIT ?
            """,
            tuple(params + [limit]),
        )

    def timeline(self, filters: dict[str, Any], bucket: str) -> list[dict[str, Any]]:
        where_sql, params = self._build_filters(filters)
        fmt = "%Y-%m-%d %H:00" if bucket == "hour" else "%Y-%m-%d"
        bucket_expr = self._db.dialect.strftime_bucket(fmt, "started_at")
        return self._db.fetch_all(
            f"""
            SELECT
                {bucket_expr} AS bucket,
                COUNT(*) AS sessions,
                COALESCE(SUM(audio_duration_ms), 0) AS total_audio_ms,
                COALESCE(AVG(NULLIF(asr_ms, 0)), 0) AS avg_asr_ms,
                COALESCE(AVG(CASE WHEN llm_enabled = 1 THEN llm_ms END), 0) AS avg_llm_ms
            FROM usage_sessions
            {where_sql}
            GROUP BY bucket
            ORDER BY bucket ASC
            """,
            tuple(params),
        )

    def duration_distribution(self, filters: dict[str, Any]) -> list[dict[str, Any]]:
        where_sql, params = self._build_filters(filters)
        buckets = [
            ("0-5s", 0, 5000),
            ("5-10s", 5000, 10000),
            ("10-20s", 10000, 20000),
            ("20-30s", 20000, 30000),
            ("30-45s", 30000, 45000),
            ("45s-1m", 45000, 60000),
            ("1-2m", 60000, 120000),
            ("2-3m", 120000, 180000),
            ("3-4m", 180000, 240000),
            ("4-5m", 240000, 300000),
        ]
        cases = ", ".join(
            f"SUM(CASE WHEN audio_duration_ms >= {lo} AND audio_duration_ms < {hi} THEN 1 ELSE 0 END)"
            for _, lo, hi in buckets
        )
        row = self._db.fetch_one(
            f"SELECT {cases} FROM usage_sessions {where_sql}",
            tuple(params),
        )
        values = list(row.values()) if row else [0] * len(buckets)
        return [{"label": label, "count": int(v or 0)} for (label, _, _), v in zip(buckets, values)]

    def get_percentiles(self, filters: dict[str, Any]) -> dict[str, Any]:
        where_sql, params = self._build_filters(filters)
        extra = f"{where_sql} AND" if where_sql else "WHERE"
        def _pct(field, p):
            row = self._db.fetch_one(
                f"SELECT {field} AS v FROM usage_sessions {extra} {field} > 0 ORDER BY {field} ASC LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * {p} AS INTEGER) FROM usage_sessions {extra} {field} > 0)",
                tuple(params + params),
            )
            return round(float(row["v"]), 1) if row and row.get("v") else 0
        return {
            "asr_p50": _pct("asr_ms", 0.5), "asr_p95": _pct("asr_ms", 0.95), "asr_p99": _pct("asr_ms", 0.99),
            "llm_p50": _pct("llm_ms", 0.5), "llm_p95": _pct("llm_ms", 0.95), "llm_p99": _pct("llm_ms", 0.99),
        }
    def list_service_logs(self, limit: int = 100, level: str | None = None, from_: str | None = None, to: str | None = None, q: str | None = None) -> list[dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if level:
            clauses.append("level = ?")
            params.append(level.upper())
        from_ts = _parse_time(from_)
        to_ts = _parse_time(to)
        if from_ts is not None:
            clauses.append("created_at >= ?")
            params.append(from_ts)
        if to_ts is not None:
            clauses.append("created_at <= ?")
            params.append(to_ts)
        if q and q.strip():
            escaped_q = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            clauses.append("message LIKE ? ESCAPE '\\'")
            params.append(f"%{escaped_q}%")
        where_sql = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self._db.fetch_all(
            f"""
            SELECT created_at, level, logger_name, node_id, session_id, connection_id, message, payload_json
            FROM service_logs
            {where_sql}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            tuple(params + [limit]),
        )
        for row in rows:
            try:
                row["payload"] = json.loads(row.pop("payload_json") or "{}")
            except json.JSONDecodeError:
                row["payload"] = {}
        return rows
