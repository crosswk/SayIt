from __future__ import annotations

import json
import logging
from contextvars import ContextVar, Token
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from .db import Database

_NODE_ID: ContextVar[str] = ContextVar("sayit_node_id", default="-")
_SESSION_ID: ContextVar[str] = ContextVar("sayit_session_id", default="-")
_CONNECTION_ID: ContextVar[str] = ContextVar("sayit_connection_id", default="-")


class _ContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.node_id = _NODE_ID.get("-")
        record.session_id = _SESSION_ID.get("-")
        record.connection_id = _CONNECTION_ID.get("-")
        return True


class _SQLiteLogHandler(logging.Handler):
    def __init__(self, database: Database) -> None:
        super().__init__(level=logging.INFO)
        self._db = database

    def emit(self, record: logging.LogRecord) -> None:
        should_store = record.levelno >= logging.WARNING or str(record.name).startswith("sayit")
        if not should_store:
            return
        try:
            message = self.format(record)
            payload = {
                "pathname": record.pathname,
                "lineno": record.lineno,
                "funcName": record.funcName,
            }
            self._db.execute(
                """
                INSERT INTO service_logs(
                    created_at, level, logger_name, node_id, session_id, connection_id, message, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(record.created * 1000),
                    record.levelname,
                    record.name,
                    getattr(record, "node_id", "-"),
                    getattr(record, "session_id", "-"),
                    getattr(record, "connection_id", "-"),
                    message[:4000],
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
        except Exception:
            self.handleError(record)


def bind_log_context(
    *,
    node_id: str | None = None,
    session_id: str | None = None,
    connection_id: str | None = None,
) -> dict[str, Token[str]]:
    tokens: dict[str, Token[str]] = {}
    if node_id is not None:
        tokens["node_id"] = _NODE_ID.set(node_id or "-")
    if session_id is not None:
        tokens["session_id"] = _SESSION_ID.set(session_id or "-")
    if connection_id is not None:
        tokens["connection_id"] = _CONNECTION_ID.set(connection_id or "-")
    return tokens


def reset_log_context(tokens: dict[str, Token[str]]) -> None:
    if token := tokens.get("node_id"):
        _NODE_ID.reset(token)
    if token := tokens.get("session_id"):
        _SESSION_ID.reset(token)
    if token := tokens.get("connection_id"):
        _CONNECTION_ID.reset(token)


def configure_logging(log_level: str, log_file: str, retention_days: int, node_id: str) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.filters.clear()

    level = getattr(logging, str(log_level).upper(), logging.INFO)
    root.setLevel(level)

    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s node=%(node_id)s sid=%(session_id)s "
        "cid=%(connection_id)s %(name)s %(message)s"
    )
    context_filter = _ContextFilter()

    console = logging.StreamHandler()
    console.setLevel(level)
    console.setFormatter(formatter)
    console.addFilter(context_filter)
    root.addHandler(console)

    file_handler = TimedRotatingFileHandler(
        filename=str(log_path),
        when="midnight",
        backupCount=max(1, int(retention_days)),
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    file_handler.addFilter(context_filter)
    root.addHandler(file_handler)

    logging.captureWarnings(True)
    bind_log_context(node_id=node_id)


def attach_database_log_handler(database: Database) -> None:
    root = logging.getLogger()
    for handler in root.handlers:
        if isinstance(handler, _SQLiteLogHandler):
            return

    context_filter = _ContextFilter()
    db_handler = _SQLiteLogHandler(database)
    db_handler.setFormatter(logging.Formatter("%(message)s"))
    db_handler.addFilter(context_filter)
    root.addHandler(db_handler)
