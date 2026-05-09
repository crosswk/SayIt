"""ASR engine: FireRedASR2-AED with optional FireRedPunc."""
from __future__ import annotations

import logging
import time
from pathlib import Path

import numpy as np
import torch

logger = logging.getLogger("sayit.asr.firered")


class FireRedASRBackend:
    """Wraps FireRedASR2-AED + FireRedPunc for use as a drop-in ASR backend."""

    def __init__(self, model_dir: str, device: str = "cuda:0", use_int8: bool = False) -> None:
        from fireredasr2s.fireredasr2.asr import FireRedAsr2, FireRedAsr2Config
        from fireredasr2s.fireredpunc.punc import FireRedPunc

        model_dir = Path(model_dir).resolve()
        asr_dir = model_dir / "FireRedASR2-AED"
        punc_dir = model_dir / "FireRedPunc"

        logger.info("Loading FireRedASR2-AED from %s", asr_dir)
        asr_config = FireRedAsr2Config(use_gpu=True, use_half=True)
        self._asr = FireRedAsr2.from_pretrained("aed", str(asr_dir), asr_config)

        self._punc = None
        if punc_dir.exists():
            from fireredasr2s.fireredpunc.punc import FireRedPuncConfig
            logger.info("Loading FireRedPunc from %s", punc_dir)
            self._punc = FireRedPunc.from_pretrained(str(punc_dir), FireRedPuncConfig())

        logger.info("FireRedASR2-AED ready")

    def _feat(self, wav_list):
        """Extract features from list of torch tensors."""
        import tempfile, soundfile as sf
        tmp_paths, uttids = [], []
        for i, wav in enumerate(wav_list):
            f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            p = f.name
            f.close()
            audio_np = wav.numpy() if isinstance(wav, torch.Tensor) else wav
            if audio_np.dtype != np.float32:
                audio_np = audio_np.astype(np.float32)
            sf.write(p, audio_np, 16000)
            tmp_paths.append(p)
            uttids.append(f"u{i}")
        feats, lengths, durs, _, _ = self._asr.feat_extractor(tmp_paths, uttids)
        for p in tmp_paths:
            Path(p).unlink(missing_ok=True)
        return feats, lengths, durs

    def transcribe_audio(self, audio: np.ndarray) -> str:
        """Transcribe a 16kHz float32 numpy array, return text."""
        if audio.dtype != np.float32:
            audio = audio.astype(np.float32) / 32768.0

        # Normalize low-volume audio (e.g. whispered speech) to prevent
        # FireRed AED from producing empty results due to weak features.
        peak = np.max(np.abs(audio))
        if 0 < peak < 0.1:
            audio = audio * (0.1 / peak)

        # Clip to [-1.0, 1.0] before int16 conversion to prevent overflow
        audio_clipped = np.clip(audio, -1.0, 1.0)
        results = self._asr.transcribe([f"u0"], [(16000, (audio_clipped * 32768).astype(np.int16))])
        text = results[0].get("text", "").strip() if results else ""
        # Filter blanks
        if not text or "<blank>" in text or "<sil>" in text:
            return ""
        # Punctuation
        if self._punc and text:
            punc_result = self._punc.process([text])
            if punc_result and isinstance(punc_result[0], dict):
                text = punc_result[0].get("punc_text", text)
            elif punc_result:
                text = str(punc_result[0])
        return text
