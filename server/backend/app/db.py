from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

# ---------------------------------------------------------------------------
# SQL dialect helpers
# ---------------------------------------------------------------------------

class SQLDialect:
    """SQL fragments that differ between SQLite and PostgreSQL."""
    name: str = "sqlite"
    placeholder: str = "?"
    autoincrement_pk: str = "INTEGER PRIMARY KEY AUTOINCREMENT"
    upsert_schema_version: str = (
        "INSERT INTO schema_meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )

    def strftime_bucket(self, fmt: str, epoch_ms_col: str) -> str:
        return f"strftime('{fmt}', {epoch_ms_col} / 1000, 'unixepoch')"

    def column_exists_sql(self, table: str) -> str | None:
        """Return SQL to list columns, or None if PRAGMA is used."""
        return None  # SQLite uses PRAGMA


class PostgreSQLDialect(SQLDialect):
    name = "postgresql"
    placeholder = "%s"
    autoincrement_pk = "SERIAL PRIMARY KEY"
    upsert_schema_version = (
        "INSERT INTO schema_meta(key, value) VALUES(%s, %s) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )

    def strftime_bucket(self, fmt: str, epoch_ms_col: str) -> str:
        pg_fmt = fmt.replace("%Y", "YYYY").replace("%m", "MM").replace("%d", "DD").replace("%H", "HH24")
        return f"to_char(to_timestamp({epoch_ms_col} / 1000.0), '{pg_fmt}')"

    def column_exists_sql(self, table: str) -> str | None:
        return (
            f"SELECT column_name FROM information_schema.columns "
            f"WHERE table_name = '{table}'"
        )


SQLITE_DIALECT = SQLDialect()
POSTGRESQL_DIALECT = PostgreSQLDialect()


# ---------------------------------------------------------------------------
# Database interface
# ---------------------------------------------------------------------------

class Database:
    """Unified database interface supporting SQLite and PostgreSQL."""

    def __init__(self, path: str, backend: str = "sqlite") -> None:
        self.backend = backend
        self.dialect: SQLDialect = POSTGRESQL_DIALECT if backend == "postgresql" else SQLITE_DIALECT
        self._lock = threading.RLock()

        if backend == "postgresql":
            import psycopg2
            import psycopg2.extras
            self._pg_extras = psycopg2.extras
            self._conn = psycopg2.connect(path)
            self._conn.autocommit = False
        else:
            self._pg_extras = None
            self.path = Path(path)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
            self._conn.row_factory = sqlite3.Row

    def _add_column_if_missing(self, table: str, column: str, col_type: str) -> None:
        if self.backend == "postgresql":
            sql = self.dialect.column_exists_sql(table)
            cols = {row["column_name"] for row in self.fetch_all(sql)}
            if column not in cols:
                self._conn.cursor().execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")
                self._conn.commit()
        else:
            cols = {row[1] for row in self._conn.execute(f"PRAGMA table_info({table})")}
            if column not in cols:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")

    def _exec_ddl(self, sql: str) -> None:
        """Execute DDL, adapting syntax for the backend."""
        if self.backend == "postgresql":
            sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
            sql = sql.replace("?", "%s")
        with self._lock:
            if self.backend == "postgresql":
                cur = self._conn.cursor()
                cur.execute(sql)
                self._conn.commit()
            else:
                self._conn.execute(sql)

    def initialize(self) -> None:
        with self._lock:
            if self.backend == "sqlite":
                self._conn.execute("PRAGMA journal_mode=WAL")
                self._conn.execute("PRAGMA synchronous=NORMAL")
                self._conn.execute("PRAGMA foreign_keys=ON")

            ddl = [
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """,
                f"""
                CREATE TABLE IF NOT EXISTS usage_sessions (
                    id {self.dialect.autoincrement_pk},
                    session_id TEXT NOT NULL UNIQUE,
                    connection_id TEXT NOT NULL,
                    started_at BIGINT NOT NULL,
                    stopped_at BIGINT,
                    finished_at BIGINT,
                    user_id TEXT,
                    user_name TEXT,
                    device_id TEXT,
                    hostname TEXT,
                    client_version TEXT,
                    platform TEXT,
                    local_ip TEXT,
                    client_ip TEXT,
                    forwarded_for TEXT,
                    node_id TEXT,
                    deployment_mode TEXT,
                    source TEXT,
                    process_name TEXT,
                    exe_path TEXT,
                    window_title TEXT,
                    window_class TEXT,
                    focus_class TEXT,
                    control_type TEXT,
                    ptt_hold_ms INTEGER,
                    audio_duration_ms INTEGER DEFAULT 0,
                    is_empty_audio INTEGER DEFAULT 0,
                    is_empty_result INTEGER DEFAULT 0,
                    asr_provider TEXT,
                    asr_model TEXT,
                    asr_lang TEXT,
                    asr_ms INTEGER DEFAULT 0,
                    vad_ms INTEGER DEFAULT 0,
                    queue_wait_ms INTEGER DEFAULT 0,
                    infer_ms INTEGER DEFAULT 0,
                    batch_exec_ms INTEGER DEFAULT 0,
                    batch_size INTEGER DEFAULT 0,
                    seg_count INTEGER DEFAULT 0,
                    llm_enabled INTEGER DEFAULT 0,
                    llm_provider TEXT,
                    llm_model TEXT,
                    llm_ms INTEGER DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'created',
                    error_code TEXT,
                    error_message TEXT,
                    debug_audio_saved INTEGER DEFAULT 0,
                    recording_path TEXT,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL
                )
                """,
                f"""
                CREATE TABLE IF NOT EXISTS usage_events (
                    id {self.dialect.autoincrement_pk},
                    session_id TEXT,
                    connection_id TEXT,
                    event_type TEXT NOT NULL,
                    event_time BIGINT NOT NULL,
                    payload_json TEXT
                )
                """,
                f"""
                CREATE TABLE IF NOT EXISTS service_logs (
                    id {self.dialect.autoincrement_pk},
                    created_at BIGINT NOT NULL,
                    level TEXT NOT NULL,
                    logger_name TEXT NOT NULL,
                    node_id TEXT,
                    session_id TEXT,
                    connection_id TEXT,
                    message TEXT NOT NULL,
                    payload_json TEXT
                )
                """,
                f"""
                CREATE TABLE IF NOT EXISTS feedback (
                    id {self.dialect.autoincrement_pk},
                    machine_id TEXT NOT NULL,
                    app_version TEXT,
                    client_ip TEXT,
                    feedback_text TEXT NOT NULL,
                    transcript_json TEXT,
                    context_json TEXT,
                    created_at BIGINT NOT NULL
                )
                """,
            ]
            for sql in ddl:
                self._exec_ddl(sql)

            indexes = [
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_started_at ON usage_sessions(started_at DESC)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_user_id ON usage_sessions(user_id)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_process_name ON usage_sessions(process_name)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_status ON usage_sessions(status)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_client_ip ON usage_sessions(client_ip)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_node_id ON usage_sessions(node_id)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_asr_model ON usage_sessions(asr_model)",
                "CREATE INDEX IF NOT EXISTS idx_usage_sessions_llm_model ON usage_sessions(llm_model)",
                "CREATE INDEX IF NOT EXISTS idx_usage_events_session_time ON usage_events(session_id, event_time)",
                "CREATE INDEX IF NOT EXISTS idx_service_logs_created_at ON service_logs(created_at DESC)",
                "CREATE INDEX IF NOT EXISTS idx_service_logs_level ON service_logs(level)",
                "CREATE INDEX IF NOT EXISTS idx_service_logs_session_id ON service_logs(session_id)",
                "CREATE INDEX IF NOT EXISTS idx_feedback_machine_id ON feedback(machine_id)",
                "CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC)",
            ]
            for sql in indexes:
                self._exec_ddl(sql)

            self._add_column_if_missing("usage_sessions", "local_ip", "TEXT")
            self._add_column_if_missing("usage_sessions", "source", "TEXT")

            p = self.dialect.placeholder
            upsert = self.dialect.upsert_schema_version
            if self.backend == "postgresql":
                cur = self._conn.cursor()
                cur.execute(upsert, (str(SCHEMA_VERSION),) * 2)
                self._conn.commit()
            else:
                self._conn.execute(
                    "INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    ("schema_version", str(SCHEMA_VERSION)),
                )
                self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        sql, params = self._adapt(sql, params)
        with self._lock:
            if self.backend == "postgresql":
                cur = self._conn.cursor()
                cur.execute(sql, params)
                self._conn.commit()
                try:
                    return cur.fetchone()[0] if cur.description else 0
                except (TypeError, IndexError):
                    return 0
            else:
                cur = self._conn.execute(sql, params)
                self._conn.commit()
                return int(cur.lastrowid)

    def fetch_one(self, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        sql, params = self._adapt(sql, params)
        with self._lock:
            if self.backend == "postgresql":
                cur = self._conn.cursor(cursor_factory=self._pg_extras.RealDictCursor)
                cur.execute(sql, params)
                row = cur.fetchone()
                return dict(row) if row else None
            else:
                row = self._conn.execute(sql, params).fetchone()
                return dict(row) if row else None

    def fetch_all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        sql, params = self._adapt(sql, params)
        with self._lock:
            if self.backend == "postgresql":
                cur = self._conn.cursor(cursor_factory=self._pg_extras.RealDictCursor)
                cur.execute(sql, params)
                return [dict(row) for row in cur.fetchall()]
            else:
                rows = self._conn.execute(sql, params).fetchall()
                return [dict(row) for row in rows]

    def _adapt(self, sql: str, params: tuple[Any, ...]) -> tuple[str, tuple[Any, ...]]:
        """Replace ? placeholders with %s for PostgreSQL."""
        if self.backend == "postgresql":
            sql = sql.replace("?", "%s")
        return sql, params
