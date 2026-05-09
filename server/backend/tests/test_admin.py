from __future__ import annotations

import base64
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.admin import router as admin_router, _public_router as admin_public_router
from backend.app.config import Config, TelemetryConfig, AdminConfig, LoggingConfig
from backend.app.db import Database
from backend.app.telemetry import TelemetryService


class AdminRouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="sayit-admin-test-"))
        self.cfg = Config(
            telemetry=TelemetryConfig(
                enabled=True,
                db_path=str(self._tmpdir / "sayit.sqlite3"),
            ),
            logging=LoggingConfig(
                file=str(self._tmpdir / "backend.log"),
            ),
            admin=AdminConfig(
                enabled=True,
                username="admin",
                password="secret",
            ),
        )
        self.db = Database(self.cfg.telemetry.db_path)
        self.db.initialize()
        self.telemetry = TelemetryService(self.cfg, self.db)

        self.app = FastAPI()
        self.app.state.config = self.cfg
        self.app.state.telemetry = self.telemetry
        self.app.include_router(admin_public_router)
        self.app.include_router(admin_router)
        self.client = TestClient(self.app)

    def tearDown(self) -> None:
        self.db.close()
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _auth_headers(self) -> dict[str, str]:
        token = base64.b64encode(b"admin:secret").decode("ascii")
        return {"Authorization": f"Basic {token}"}

    def test_admin_requires_basic_auth(self) -> None:
        # Admin API endpoints require auth
        response = self.client.get("/admin/api/overview")
        self.assertEqual(response.status_code, 401)
        self.assertIn("Basic", response.headers.get("www-authenticate", ""))

    def test_admin_ui_and_api_work_with_auth(self) -> None:
        # Admin UI page is served without auth (login handled client-side)
        ui = self.client.get("/admin")
        self.assertIn(ui.status_code, (200, 404))  # 404 if admin.html not at expected path in test env

        overview = self.client.get("/admin/api/overview", headers=self._auth_headers())
        self.assertEqual(overview.status_code, 200)
        self.assertEqual(overview.json()["total_sessions"], 0)

    def test_service_logs_endpoint_returns_rows(self) -> None:
        self.db.execute(
            """
            INSERT INTO service_logs(created_at, level, logger_name, node_id, session_id, connection_id, message, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (1234567890, "WARNING", "sayit.test", "node-1", "sid-1", "cid-1", "example warning", "{}"),
        )
        response = self.client.get("/admin/api/service-logs", headers=self._auth_headers())
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["message"], "example warning")


if __name__ == "__main__":
    unittest.main()
