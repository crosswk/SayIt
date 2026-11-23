"""Catch ASR output that the audio cannot have produced.

Given near-silent audio (a key click over room noise), the ASR model sometimes writes a fluent
sentence anyway. Every such case found so far shares one property: the amount of text does not
fit the amount of speech in the recording. So the check is an audio/text consistency test, not a
text blacklist and not a loudness threshold:

1. VAD found speech           -> drop when the text is too long for that much speech.
2. VAD found nothing          -> amplify and run VAD again (quiet talkers come back, clicks do
                                 not), then apply rule 1 to what it finds.
3. Still nothing after gain   -> keep only when the recording has a sustained voiced (pitched)
                                 stretch, which room noise and clicks lack.

Pure functions only; VAD is injected so this module needs neither torch nor the model.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

import numpy as np

MODE_OFF = "off"
MODE_LOG = "log"
MODE_ENFORCE = "enforce"
MODES = (MODE_OFF, MODE_LOG, MODE_ENFORCE)

# Longer recordings are left alone: the fabricated sentences seen so far all came from clips
# under 30 s, and in a long, mostly quiet recording a wrong drop costs the user far more.
MAX_AUDIO_SEC = 30.0
# Fast Mandarin is about 6-8 characters per second of detected speech; measured fabrications
# start around 18. Units are CJK characters plus Latin/digit words (see text_units).
MAX_UNITS_PER_SEC = 15.0
# Below this the rate is too noisy to judge (a one-word reply over a 150 ms VAD segment).
# Short phantom output is already handled by the caller's short-text rules.
MIN_UNITS_FOR_RATE = 8
MIN_VOICED_MS = 500
_GAIN_TARGET_RMS = 0.1  # -20 dBFS

# Escapes on purpose: a literal CJK character in a pattern is one bad re-encode away from
# never matching again, and nothing fails loudly when that happens.
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")
_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['\u2019.][A-Za-z0-9]+)*")


def normalize_mode(raw: object, default: str = MODE_ENFORCE) -> str:
    mode = str(raw or "").strip().lower()
    return mode if mode in MODES else default


def text_units(text: str) -> int:
    """Rough count of spoken units: one per CJK character, one per Latin/digit word.

    Counting Latin letters one by one would make every English sentence look impossibly fast.
    """
    cjk = len(_CJK_RE.findall(text))
    words = len(_WORD_RE.findall(_CJK_RE.sub(" ", text)))
    return cjk + words


def normalize_gain(audio: np.ndarray) -> np.ndarray:
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))) + 1e-9
    return np.clip(audio * (_GAIN_TARGET_RMS / rms), -1.0, 1.0).astype(np.float32)


def voiced_ms(audio: np.ndarray, sample_rate: int = 16000) -> int:
    """Total duration of frames with a clear pitch in the 80-400 Hz range.

    A frame counts when its normalised autocorrelation peaks above 0.55 at a pitch lag and its
    energy stands clear of the recording's own noise floor (so the measure is level-independent).
    """
    frame, hop = int(0.040 * sample_rate), int(0.010 * sample_rate)
    if len(audio) <= frame:
        return 0
    lag_lo, lag_hi = sample_rate // 400, sample_rate // 80
    starts = np.arange(0, len(audio) - frame, hop)
    offsets = np.arange(frame)
    energies = np.empty(len(starts), dtype=np.float64)
    peaks = np.empty(len(starts), dtype=np.float64)
    for i in range(0, len(starts), 512):  # batches keep memory flat on 30 s clips
        chunk = audio[starts[i:i + 512, None] + offsets[None, :]].astype(np.float64)
        chunk -= chunk.mean(axis=1, keepdims=True)
        energies[i:i + 512] = (chunk ** 2).sum(axis=1)
        ac = np.fft.irfft(np.abs(np.fft.rfft(chunk, 2048, axis=1)) ** 2, axis=1)[:, :lag_hi]
        ac /= ac[:, :1] + 1e-12
        peaks[i:i + 512] = ac[:, lag_lo:lag_hi].max(axis=1)
    floor = np.percentile(energies, 20) + 1e-12
    voiced = (peaks > 0.55) & (energies > 4 * floor)
    return int(voiced.sum()) * 10


@dataclass(slots=True)
class Verdict:
    drop: bool
    reason: str            # "" | "rate" | "rate_after_gain" | "no_voice"
    units: int
    vad_ms: int
    gain_vad_ms: int | None = None
    voiced_ms: int | None = None


def _too_fast(units: int, speech_ms: int) -> bool:
    return units >= MIN_UNITS_FOR_RATE and units / (speech_ms / 1000.0) > MAX_UNITS_PER_SEC


def judge(
    audio: np.ndarray,
    text: str,
    vad_ms: int,
    speech_ms_fn: Callable[[np.ndarray], int | None],
) -> Verdict:
    """Decide whether `text` is plausible for `audio`.

    vad_ms: speech duration VAD found in the raw audio. speech_ms_fn reruns VAD on another array
    and may return None on failure, in which case the text is kept (fail open).
    """
    units = text_units(text)
    if not units or len(audio) / 16000.0 >= MAX_AUDIO_SEC:
        return Verdict(False, "", units, vad_ms)
    if vad_ms > 0:
        return Verdict(_too_fast(units, vad_ms), "rate" if _too_fast(units, vad_ms) else "", units, vad_ms)
    gain_ms = speech_ms_fn(normalize_gain(audio))
    if gain_ms is None:
        return Verdict(False, "", units, vad_ms)
    if gain_ms > 0:
        fast = _too_fast(units, gain_ms)
        return Verdict(fast, "rate_after_gain" if fast else "", units, vad_ms, gain_ms)
    v_ms = voiced_ms(audio)
    quiet = v_ms < MIN_VOICED_MS
    return Verdict(quiet, "no_voice" if quiet else "", units, vad_ms, gain_ms, v_ms)
