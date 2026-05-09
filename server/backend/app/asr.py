"""ASR engine: Qwen3-ASR 1.7B with vLLM acceleration + FSMN-VAD batch inference."""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .config import Config

logger = logging.getLogger("sayit.asr")


@dataclass
class _ASRJob:
    audio: np.ndarray
    context: str | None
    language: str | None
    future: asyncio.Future[tuple[str, dict]]
    queued_at: float


def _load_hotwords(path: str) -> list[str]:
    try:
        lines = Path(path).read_text(encoding="utf-8").strip().splitlines()
        return [w.strip() for w in lines if w.strip() and not w.startswith("#")]
    except Exception:
        return []


class ASREngine:
    """ASR engine supporting Qwen3-ASR (vLLM) and FireRedASR2-LLM backends."""

    def __init__(self, config: Config) -> None:
        self._engine_type = config.asr.engine  # "qwen3" or "firered"
        self._firered_backend = None

        if self._engine_type == "firered":
            from .asr_firered import FireRedASRBackend
            logger.info("Initializing FireRedASR2-LLM engine (INT8=%s)", config.asr.firered_use_int8)
            self._firered_backend = FireRedASRBackend(
                model_dir=config.asr.firered_model_dir,
                device=config.asr.device,
                use_int8=config.asr.firered_use_int8,
            )
            self._backend = "firered"
        else:
            from qwen_asr import Qwen3ASRModel

            self._lang_map = {"中文": "Chinese", "英文": "English", "日文": "Japanese"}
            self._language = self._lang_map.get(config.asr.language, config.asr.language)

            logger.info("Loading Qwen3-ASR model=%s backend=vllm", config.asr.model)
            try:
                self._model = Qwen3ASRModel.LLM(
                    model=config.asr.model,
                    gpu_memory_utilization=config.asr.vllm_gpu_util,
                    max_new_tokens=512,
                    max_model_len=config.asr.vllm_max_model_len,
                )
                self._backend = "vllm"
            except Exception:
                logger.exception("vLLM failed, falling back to transformers")
                import torch
                self._model = Qwen3ASRModel.from_pretrained(
                    config.asr.model, dtype=torch.bfloat16,
                    device_map=config.asr.device, max_new_tokens=512,
                )
                self._backend = "transformers"
            logger.info("Qwen3-ASR ready (%s)", self._backend)

        # FSMN-VAD
        self._vad = None
        try:
            from funasr import AutoModel
            self._vad = AutoModel(model=config.vad.model, device=config.asr.device, disable_update=True)
            logger.info("VAD ready (%s)", config.vad.model)
        except Exception:
            logger.exception("VAD failed to load")

        # Hotwords
        self._hotwords_path = Path(config.paths.prompt_dir) / "hotwords.txt"
        hotwords = _load_hotwords(str(self._hotwords_path))
        self._context = " ".join(hotwords) if hotwords else ""
        if hotwords:
            logger.info("Loaded %d hotwords: %s", len(hotwords), hotwords)

        requested_workers = max(1, int(config.asr.max_concurrency))
        if self._backend != "vllm" and requested_workers != 1:
            logger.warning("ASR concurrent model calls are unstable with %s backend; force max_concurrency=1", self._backend)
            requested_workers = 1
        self._max_concurrency = requested_workers
        self._batch_max_size = max(1, int(config.asr.batch_max_size))
        self._batch_wait_s = max(0, int(config.asr.batch_wait_ms)) / 1000.0
        self._executor = ThreadPoolExecutor(max_workers=self._max_concurrency)
        self._queue: asyncio.Queue[_ASRJob] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None
        self._debug = config.logging.debug_asr
        logger.info(
            "ASR mode=queued-batch workers=%d batch_max=%d batch_wait_ms=%d",
            self._max_concurrency,
            self._batch_max_size,
            int(self._batch_wait_s * 1000),
        )

    def _resolve_language(self, language: str | None) -> str | None:
        """Resolve language: None=use default, 'auto'=model auto-detect, else map to full name."""
        if language is None:
            return self._language
        low = language.strip().lower()
        if low in ("auto", ""):
            return None  # Qwen3-ASR auto-detect
        lang_map = {"zh": "Chinese", "en": "English", "中文": "Chinese", "英文": "English"}
        return lang_map.get(low, language)

    def get_hotwords(self) -> list[str]:
        return _load_hotwords(str(self._hotwords_path))

    def set_hotwords(self, words: list[str]) -> list[str]:
        clean = [w.strip() for w in words if w.strip()]
        self._hotwords_path.write_text(
            "# hotwords (one per line)\n" + "\n".join(clean) + "\n", encoding="utf-8"
        )
        self._context = " ".join(clean) if clean else ""
        logger.info("Hotwords updated (%d): %s", len(clean), clean)
        return clean

    def get_batching(self) -> dict:
        return {
            "batch_max_size": self._batch_max_size,
            "batch_wait_ms": int(self._batch_wait_s * 1000),
        }

    def set_batching(self, batch_max_size: int | None = None, batch_wait_ms: int | None = None) -> dict:
        if batch_max_size is not None:
            self._batch_max_size = max(1, int(batch_max_size))
        if batch_wait_ms is not None:
            self._batch_wait_s = max(0, int(batch_wait_ms)) / 1000.0
        logger.info(
            "ASR batching updated: batch_max_size=%d batch_wait_ms=%d",
            self._batch_max_size,
            int(self._batch_wait_s * 1000),
        )
        return self.get_batching()

    async def close(self):
        if self._worker_task and not self._worker_task.done():
            self._worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker_task
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _ensure_worker(self) -> None:
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._worker_loop(), name="sayit-asr-worker")

    async def _worker_loop(self) -> None:
        while True:
            first = await self._queue.get()
            batch = [first]
            deadline = time.monotonic() + self._batch_wait_s
            while len(batch) < self._batch_max_size:
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    break
                try:
                    nxt = await asyncio.wait_for(self._queue.get(), timeout=timeout)
                except asyncio.TimeoutError:
                    break
                batch.append(nxt)

            batch_exec_start = time.monotonic()
            try:
                loop = asyncio.get_running_loop()
                inputs = [(j.audio, j.context, j.language) for j in batch]
                outputs = await loop.run_in_executor(self._executor, self._transcribe_batch_sync, inputs)
                if len(outputs) != len(batch):
                    raise RuntimeError(f"batch output size mismatch: {len(outputs)} vs {len(batch)}")
                batch_exec_ms = int((time.monotonic() - batch_exec_start) * 1000)
                for job, item in zip(batch, outputs):
                    if not job.future.done():
                        text, debug = item
                        timings = debug.setdefault("timings", {})
                        queue_wait_ms = int((batch_exec_start - job.queued_at) * 1000)
                        timings["queue_wait_ms"] = queue_wait_ms
                        timings["batch_exec_ms"] = batch_exec_ms
                        timings["batch_size"] = len(batch)
                        job.future.set_result((text, debug))
            except Exception as e:
                logger.exception("ASR batch worker failed")
                for job in batch:
                    if not job.future.done():
                        job.future.set_exception(e)
            finally:
                for _ in batch:
                    self._queue.task_done()

    def _transcribe_batch_sync(self, items: list[tuple[np.ndarray, str | None, str | None]]) -> list[tuple[str, dict]]:
        """Transcribe queued jobs in one worker thread.

        Pipeline:
        1) VAD split per request (for >15s audio)
        2) merge all request segments by context
        3) one batched model call per context
        """
        outputs: list[tuple[str, dict]] = [("", {}) for _ in items]
        seg_groups: dict[tuple[str, str], list[tuple[int, int, np.ndarray]]] = {}
        job_debug: dict[int, dict] = {}
        job_text_parts: dict[int, list[str]] = {}
        job_vad_ms: dict[int, int] = {}
        job_infer_ms: dict[int, int] = {}
        job_lang: dict[int, str] = {}

        for idx, (audio, context, language) in enumerate(items):
            if audio.size == 0:
                outputs[idx] = ("", {})
                continue
            ctx = context if context is not None else self._context
            lang = self._resolve_language(language)
            duration = len(audio) / 16000.0
            vad_t0 = time.monotonic()
            job_lang[idx] = lang

            # Reject near-silent audio to prevent hotword hallucination.
            # Whispered speech has peak ≥ 0.01; pure silence/noise is below.
            if float(np.max(np.abs(audio))) < 0.01 and duration < 1.5:
                job_vad_ms[idx] = int((time.monotonic() - vad_t0) * 1000)
                job_debug[idx] = {"duration_sec": round(duration, 1), "vad_segments": [], "context": ctx, "silent": True}
                job_text_parts[idx] = []
                continue

            if duration <= 120.0:
                # ≤ 2min: send whole audio, no split — accuracy first.
                # VAD-based filtering was removed because it aggressively
                # discards whispered speech (low-energy audio misclassified
                # as silence), causing severe recognition loss.
                segs = [(audio, duration)]
            else:
                # > 2min: safe split at ≥3s silence gaps
                segs = self._safe_split(audio)
                logger.info("Safe split %.1fs -> %d segs %s",
                            duration, len(segs), [f"{d:.1f}s" for _, d in segs])
            job_vad_ms[idx] = int((time.monotonic() - vad_t0) * 1000)

            debug = {
                "duration_sec": round(duration, 1),
                "vad_segments": [{"index": i, "duration_sec": round(d, 1)} for i, (_, d) in enumerate(segs)],
                "context": ctx,
            }
            job_debug[idx] = debug
            job_text_parts[idx] = [""] * len(segs)

            for seg_idx, (seg_audio, _) in enumerate(segs):
                if seg_audio.size == 0:
                    continue
                seg_groups.setdefault((ctx, lang), []).append((idx, seg_idx, seg_audio))

        for (ctx, lang), entries in seg_groups.items():
            audio_list = [(seg_audio, 16000) for _, _, seg_audio in entries]
            results = None
            try:
                t_inf = time.monotonic()
                if self._engine_type == "firered":
                    # FireRed: transcribe one segment at a time (no native batch for wav arrays)
                    texts = []
                    for _, _, seg_audio in entries:
                        texts.append(self._firered_backend.transcribe_audio(seg_audio))
                    infer_ms = int((time.monotonic() - t_inf) * 1000)
                    seg_total = len(entries)
                    seg_counter: dict[int, int] = {}
                    for job_idx, _, _ in entries:
                        seg_counter[job_idx] = seg_counter.get(job_idx, 0) + 1
                    for job_idx, seg_cnt in seg_counter.items():
                        job_infer_ms[job_idx] = job_infer_ms.get(job_idx, 0) + int(infer_ms * (seg_cnt / seg_total))
                    for (job_idx, seg_idx, _), text in zip(entries, texts):
                        job_text_parts[job_idx][seg_idx] = text
                else:
                    if len(audio_list) == 1:
                        results = self._model.transcribe(
                            audio=audio_list[0], language=lang, context=ctx,
                        )
                    else:
                        results = self._model.transcribe(
                            audio=audio_list, language=lang, context=ctx,
                        )
                    infer_ms = int((time.monotonic() - t_inf) * 1000)
                    if not results or len(results) != len(entries):
                        raise RuntimeError(f"batch result mismatch: got={len(results) if results else 0} expected={len(entries)}")
                    seg_total = len(entries)
                    seg_counter: dict[int, int] = {}
                    for job_idx, _, _ in entries:
                        seg_counter[job_idx] = seg_counter.get(job_idx, 0) + 1
                    for job_idx, seg_cnt in seg_counter.items():
                        job_infer_ms[job_idx] = job_infer_ms.get(job_idx, 0) + int(infer_ms * (seg_cnt / seg_total))
                    for (job_idx, seg_idx, _), r in zip(entries, results):
                        job_text_parts[job_idx][seg_idx] = r.text
            except Exception:
                logger.exception("Batched transcribe failed, fallback to single requests")
                for job_idx, seg_idx, seg_audio in entries:
                    t_inf = time.monotonic()
                    if self._engine_type == "firered":
                        text = self._firered_backend.transcribe_audio(seg_audio)
                    else:
                        res = self._model.transcribe(
                            audio=(seg_audio, 16000), language=lang, context=ctx,
                        )
                        text = res[0].text if res else ""
                    job_infer_ms[job_idx] = job_infer_ms.get(job_idx, 0) + int((time.monotonic() - t_inf) * 1000)
                    job_text_parts[job_idx][seg_idx] = text

        for idx, debug in job_debug.items():
            debug["timings"] = {
                "vad_ms": job_vad_ms.get(idx, 0),
                "infer_ms": job_infer_ms.get(idx, 0),
                "seg_count": len(job_text_parts.get(idx, [])),
            }
            outputs[idx] = ("".join(job_text_parts[idx]), debug)

        return outputs

    @staticmethod
    def _energy_subsplit(seg: np.ndarray, max_chunk: float = 15.0,
                         search_window: float = 2.0) -> list[np.ndarray]:
        """Split a long segment at low-energy points near ideal boundaries."""
        seg_dur = len(seg) / 16000.0
        if seg_dur <= max_chunk:
            return [seg]
        frame_len = int(0.02 * 16000)  # 20ms frames
        hop = frame_len // 2
        n_frames = (len(seg) - frame_len) // hop
        if n_frames <= 0:
            return [seg]
        energy = np.array([np.sum(seg[i * hop:i * hop + frame_len] ** 2)
                           for i in range(n_frames)])
        smooth_win = max(1, int(0.5 * 16000 / hop))
        kernel = np.ones(smooth_win) / smooth_win
        energy_smooth = np.convolve(energy, kernel, mode="same")

        cuts = [0.0]
        pos = 0.0
        while pos + max_chunk < seg_dur:
            ideal = pos + max_chunk
            i_s = max(0, int((ideal - search_window) * 16000 / hop))
            i_e = min(int((ideal + search_window) * 16000 / hop), len(energy_smooth))
            best = i_s + int(np.argmin(energy_smooth[i_s:i_e]))
            cuts.append(best * hop / 16000.0)
            pos = cuts[-1]
        cuts.append(seg_dur)

        parts = []
        for i in range(len(cuts) - 1):
            s = int(cuts[i] * 16000)
            e = int(cuts[i + 1] * 16000)
            if e > s:
                parts.append(seg[s:e])
        return parts or [seg]

    def _vad_split(self, audio: np.ndarray, fallback_to_full: bool = True) -> list[tuple[np.ndarray, float]]:
        """Split audio using VAD, then merge adjacent short segments into ~10-15s chunks.

        Segments still longer than MAX_CHUNK after VAD merging are sub-split at
        low-energy points so that no single segment exceeds ~15s.
        """
        if self._vad is None:
            return [(audio, len(audio) / 16000.0)] if fallback_to_full else []
        try:
            import torch
            res = self._vad.generate(input=torch.tensor(audio, dtype=torch.float32), cache={}, is_final=True)
            if not res or not res[0].get("value"):
                return [(audio, len(audio) / 16000.0)] if fallback_to_full else []

            raw_segs = res[0]["value"]  # list of (start_ms, end_ms)

            # Merge adjacent segments into chunks ≤ MAX_CHUNK seconds
            # but don't merge across large silence gaps (> MAX_GAP)
            MAX_CHUNK = 15.0
            MAX_GAP = 5.0  # seconds
            merged: list[tuple[int, int]] = []
            cur_start, cur_end = raw_segs[0]
            for start_ms, end_ms in raw_segs[1:]:
                gap = (start_ms - cur_end) / 1000.0
                chunk_dur = (end_ms - cur_start) / 1000.0
                if chunk_dur <= MAX_CHUNK and gap <= MAX_GAP:
                    cur_end = end_ms  # extend current chunk
                else:
                    merged.append((cur_start, cur_end))
                    cur_start, cur_end = start_ms, end_ms
            merged.append((cur_start, cur_end))

            segments = []
            for s_ms, e_ms in merged:
                seg = audio[int(s_ms / 1000 * 16000):int(e_ms / 1000 * 16000)]
                if seg.size == 0:
                    continue
                # Sub-split segments that exceed MAX_CHUNK at low-energy points
                for part in self._energy_subsplit(seg, max_chunk=MAX_CHUNK):
                    segments.append((part, len(part) / 16000.0))
            if segments:
                return segments
            return [(audio, len(audio) / 16000.0)] if fallback_to_full else []
        except Exception:
            logger.exception("VAD failed")
            return [(audio, len(audio) / 16000.0)] if fallback_to_full else []

    def _safe_split(self, audio: np.ndarray, min_gap: float = 3.0, min_seg: float = 15.0, max_seg: float = 240.0) -> list[tuple[np.ndarray, float]]:
        """Split audio at long silence gaps (≥ min_gap seconds), keeping ALL audio.

        Unlike _vad_split which discards silence, this preserves the full audio
        and only uses VAD to find natural pause points for splitting.
        """
        if self._vad is None:
            return [(audio, len(audio) / 16000.0)]
        try:
            import torch
            res = self._vad.generate(input=torch.tensor(audio, dtype=torch.float32), cache={}, is_final=True)
            if not res or not res[0].get("value"):
                return [(audio, len(audio) / 16000.0)]

            speech_segs = res[0]["value"]
            dur = len(audio) / 16000.0

            # Find silence gaps between speech segments
            gaps = []
            for i in range(1, len(speech_segs)):
                gs, ge = speech_segs[i - 1][1], speech_segs[i][0]
                gd = (ge - gs) / 1000.0
                if gd >= min_gap:
                    gaps.append(((gs + ge) / 2 / 1000.0, gd))

            # Pick cuts from longest gaps first, ensuring segment size constraints
            gaps.sort(key=lambda x: -x[1])
            cuts: list[float] = []
            for mid, _ in gaps:
                test = sorted(cuts + [mid])
                points = [0.0] + test + [dur]
                seg_durs = [points[j + 1] - points[j] for j in range(len(points) - 1)]
                if all(d >= min_seg for d in seg_durs) and all(d <= max_seg for d in seg_durs):
                    cuts.append(mid)

            if not cuts:
                return [(audio, dur)]

            cuts.sort()
            points = [0.0] + cuts + [dur]
            segments = []
            for i in range(len(points) - 1):
                s, e = int(points[i] * 16000), int(points[i + 1] * 16000)
                seg = audio[s:e]
                segments.append((seg, len(seg) / 16000.0))
            return segments
        except Exception:
            logger.exception("Safe split failed")
            return [(audio, len(audio) / 16000.0)]

    def _transcribe_sync(self, audio: np.ndarray, context: str | None = None, language: str | None = None) -> tuple[str, dict]:
        if audio.size == 0:
            return "", {}
        ctx = context if context is not None else self._context
        lang = self._resolve_language(language)
        duration = len(audio) / 16000.0
        debug = {"duration_sec": round(duration, 1), "vad_segments": [], "context": ctx}

        if self._engine_type == "firered":
            if duration <= 15.0:
                debug["vad_segments"] = [{"index": 0, "duration_sec": round(duration, 1)}]
                return self._firered_backend.transcribe_audio(audio), debug
            segments = self._vad_split(audio)
            debug["vad_segments"] = [
                {"index": i, "duration_sec": round(d, 1)} for i, (_, d) in enumerate(segments)
            ]
            texts = [self._firered_backend.transcribe_audio(seg) for seg, _ in segments]
            return "".join(texts), debug

        # Qwen3-ASR path
        # ≤ 2min: direct, no split — accuracy first
        if duration <= 120.0:
            debug["vad_segments"] = [{"index": 0, "duration_sec": round(duration, 1)}]
            results = self._model.transcribe(
                audio=(audio, 16000), language=lang, context=ctx,
            )
            return (results[0].text if results else ""), debug

        # > 2min: safe split at ≥3s silence gaps, batch transcribe
        segments = self._safe_split(audio)
        debug["vad_segments"] = [
            {"index": i, "duration_sec": round(d, 1)} for i, (_, d) in enumerate(segments)
        ]

        if len(segments) <= 1:
            results = self._model.transcribe(
                audio=(audio, 16000), language=lang, context=ctx,
            )
            return (results[0].text if results else ""), debug

        logger.info("Safe split %.1fs -> %d segs %s",
                     duration, len(segments), [f"{d:.1f}s" for _, d in segments])

        audio_list = [(seg, 16000) for seg, _ in segments]
        results = self._model.transcribe(
            audio=audio_list, language=lang, context=ctx,
        )
        return "".join(r.text for r in results), debug

    async def transcribe(self, audio: np.ndarray, context: str | None = None, language: str | None = None) -> tuple[str, int, dict]:
        """Returns (text, elapsed_ms, debug_info). context overrides default hotwords."""
        if audio.size == 0:
            return "", 0, {}
        copied = audio.copy()
        t = time.monotonic()
        self._ensure_worker()
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[tuple[str, dict[str, Any]]] = loop.create_future()
        await self._queue.put(_ASRJob(audio=copied, context=context, language=language, future=fut, queued_at=t))
        text, debug = await fut
        ms = int((time.monotonic() - t) * 1000)
        if self._debug:
            dur = len(audio) / 16000.0
            logger.info("ASR %.1fs -> %dms %d chars: %s", dur, ms, len(text), text[:100])
        return text, ms, debug
