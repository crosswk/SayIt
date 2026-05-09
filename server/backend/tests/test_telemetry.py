from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from backend.app.config import Config, TelemetryConfig, LoggingConfig
from backend.app.db import Database
from backend.app.telemetry import TelemetryService


class TelemetryServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="sayit-telemetry-test-"))
        self.cfg = Config(
            telemetry=TelemetryConfig(
                enabled=True,
                db_path=str(self._tmpdir / "sayit.sqlite3"),
                node_id="test-node",
                deployment_mode="single",
            ),
            logging=LoggingConfig(
                file=str(self._tmpdir / "backend.log"),
            ),
        )
        self.db = Database(self.cfg.telemetry.db_path)
        self.db.initialize()
        self.service = TelemetryService(self.cfg, self.db)

    def tearDown(self) -> None:
        self.db.close()
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def test_success_flow_persists_session_and_events(self) -> None:
        session_id = self.service.create_session(
            connection_id="cid-1",
            client_ip="127.0.0.1",
            forwarded_for="10.0.0.1",
            client_meta={
                "user_id": "tester",
                "user_name": "Tester",
                "device_id": "device-1",
                "hostname": "pc-1",
                "client_version": "0.1.0",
                "platform": "win32",
            },
            app_context={
                "process_name": "Code.exe",
                "exe_path": r"C:\Code.exe",
                "window_title": "Visual Studio Code",
                "window_class": "Chrome_WidgetWin_1",
                "focus_class": "Chrome_RenderWidgetHostHWND",
                "control_type": "ControlType.Edit",
            },
        )
        assert session_id

        self.service.update_stop(session_id, "cid-1", ptt_hold_ms=1400, audio_duration_ms=1100, is_empty_audio=False)
        self.service.record_pipeline_result(
            session_id,
            "cid-1",
            asr_provider="qwen3-asr",
            asr_model="Qwen/Qwen3-ASR-1.7B",
            asr_lang="zh",
            asr_ms=320,
            asr_debug={"timings": {"vad_ms": 8, "queue_wait_ms": 6, "infer_ms": 280, "batch_size": 1, "seg_count": 1}},
            llm_enabled=True,
            llm_provider="azure",
            llm_model="gpt-4o",
            llm_ms=510,
            has_result=True,
        )

        overview = self.service.get_overview({})
        self.assertEqual(overview["total_sessions"], 1)
        self.assertEqual(overview["top_apps"][0]["process_name"], "Code.exe")

        detail = self.service.get_session_detail(session_id)
        self.assertIsNotNone(detail)
        assert detail is not None
        self.assertEqual(detail["status"], "success")
        self.assertEqual(detail["user_id"], "tester")
        self.assertEqual(detail["llm_provider"], "azure")
        self.assertNotIn("asr_text", detail)
        self.assertNotIn("llm_text", detail)
        event_types = [event["event_type"] for event in detail["events"]]
        self.assertIn("session_started", event_types)
        self.assertIn("session_stopped", event_types)
        self.assertIn("asr_completed", event_types)
        self.assertIn("llm_completed", event_types)
        self.assertIn("session_finished", event_types)

    def test_session_is_tracked_when_ai_disabled(self) -> None:
        session_id = self.service.create_session(
            connection_id="cid-ai-off",
            client_ip="127.0.0.1",
            forwarded_for=None,
            client_meta={"user_id": "tester"},
            app_context={"process_name": "OUTLOOK.EXE"},
        )
        assert session_id
        self.service.update_stop(session_id, "cid-ai-off", ptt_hold_ms=900, audio_duration_ms=820, is_empty_audio=False)
        self.service.record_pipeline_result(
            session_id,
            "cid-ai-off",
            asr_provider="qwen3-asr",
            asr_model="demo-asr",
            asr_lang="zh",
            asr_ms=111,
            asr_debug={"timings": {"vad_ms": 5}},
            llm_enabled=False,
            llm_provider=None,
            llm_model=None,
            llm_ms=0,
            has_result=True,
        )

        listed = self.service.list_sessions({"user_id": "tester"}, 10, 0)
        self.assertEqual(listed["total"], 1)
        row = listed["items"][0]
        self.assertEqual(row["llm_enabled"], 0)
        self.assertEqual(row["llm_ms"], 0)

    def test_disconnect_marks_session_when_not_completed(self) -> None:
        session_id = self.service.create_session(
            connection_id="cid-disc",
            client_ip="127.0.0.1",
            forwarded_for=None,
            client_meta={"user_id": "tester"},
            app_context={"process_name": "Teams.exe"},
        )
        assert session_id
        self.service.mark_disconnected(session_id, "cid-disc")
        detail = self.service.get_session_detail(session_id)
        assert detail is not None
        self.assertEqual(detail["status"], "disconnected")

    def test_failure_and_legacy_metadata_flow(self) -> None:
        session_id = self.service.create_session(
            connection_id="cid-legacy",
            client_ip="127.0.0.1",
            forwarded_for=None,
            client_meta=None,
            app_context=None,
        )
        assert session_id
        self.service.mark_failure(session_id, "cid-legacy", "pipeline_error", "ASR not loaded")
        detail = self.service.get_session_detail(session_id)
        assert detail is not None
        self.assertEqual(detail["status"], "failed")
        self.assertEqual(detail["error_code"], "pipeline_error")


if __name__ == "__main__":
    unittest.main()
