"""Audio/text consistency guard: text that the recording cannot have produced is dropped."""
from __future__ import annotations

import unittest

import numpy as np

from backend.app import halluc_guard as hg
from backend.app import main
from backend.app.config import load_config

SR = 16000


def _noise(seconds: float, level: float = 0.002, seed: int = 1) -> np.ndarray:
    return (np.random.default_rng(seed).standard_normal(int(seconds * SR)) * level).astype(np.float32)


def _click_over_noise(seconds: float) -> np.ndarray:
    audio = _noise(seconds)
    at = int(0.4 * seconds * SR)
    audio[at:at + 40] += 0.3 * np.hanning(40).astype(np.float32)
    return audio


def _voiced(seconds: float, level: float = 0.01) -> np.ndarray:
    """A pitched, harmonic signal with a gliding pitch over faint noise: stands in for quiet speech."""
    t = np.arange(int(seconds * SR)) / SR
    phase = 2 * np.pi * np.cumsum(140 + 30 * np.sin(2 * np.pi * 0.7 * t)) / SR
    tone = sum(np.sin(k * phase) / k for k in (1, 2, 3, 4))
    # Syllable-like bursts with gaps: the voicing measure is relative to the clip's own quiet
    # frames, as in real speech, so an unbroken tone would have nothing to stand out from.
    gate = (np.sin(2 * np.pi * 2.0 * t) > -0.3).astype(np.float64)
    return (level * tone * gate + _noise(seconds, 0.0002)).astype(np.float32)


class TextUnitsTests(unittest.TestCase):
    def test_counts_cjk_characters_and_latin_words(self) -> None:
        self.assertEqual(hg.text_units("中国共产党中央委员会。"), 10)
        self.assertEqual(hg.text_units("And the river got frozen."), 5)
        self.assertEqual(hg.text_units("用 ChatGPT 写了2004行"), 6)
        self.assertEqual(hg.text_units("，。！"), 0)


class VoicedTests(unittest.TestCase):
    def test_noise_and_click_have_no_sustained_voicing(self) -> None:
        self.assertLess(hg.voiced_ms(_click_over_noise(4.0)), hg.MIN_VOICED_MS)

    def test_quiet_pitched_signal_is_voiced_regardless_of_level(self) -> None:
        self.assertGreaterEqual(hg.voiced_ms(_voiced(3.0, level=0.003)), 1200)


class JudgeTests(unittest.TestCase):
    SENTENCE = "《大鱼》是周杰伦演唱的一首歌曲，收录于2004年发行的专辑《叶惠美》中。"

    def test_long_text_over_a_blip_of_speech_is_dropped(self) -> None:
        v = hg.judge(_click_over_noise(3.0), self.SENTENCE, 600, lambda a: self.fail("no rerun expected"))
        self.assertTrue(v.drop)
        self.assertEqual(v.reason, "rate")

    def test_normal_speaking_rate_is_kept(self) -> None:
        v = hg.judge(_voiced(6.0), self.SENTENCE, 5200, lambda a: self.fail("no rerun expected"))
        self.assertFalse(v.drop)

    def test_short_reply_is_never_judged_by_rate(self) -> None:
        self.assertFalse(hg.judge(_voiced(1.0), "好的，谢谢", 150, lambda a: 0).drop)

    def test_vad_silent_but_speech_found_after_gain_is_kept(self) -> None:
        v = hg.judge(_voiced(4.0, level=0.002), "你找一下国内的源，去下载。", 0, lambda a: 2600)
        self.assertFalse(v.drop)
        self.assertEqual(v.gain_vad_ms, 2600)

    def test_vad_silent_and_only_a_blip_after_gain_is_dropped(self) -> None:
        v = hg.judge(_click_over_noise(8.0), self.SENTENCE, 0, lambda a: 700)
        self.assertTrue(v.drop)
        self.assertEqual(v.reason, "rate_after_gain")

    def test_vad_silent_twice_and_unvoiced_is_dropped(self) -> None:
        v = hg.judge(_click_over_noise(5.0), self.SENTENCE, 0, lambda a: 0)
        self.assertTrue(v.drop)
        self.assertEqual(v.reason, "no_voice")

    def test_vad_silent_twice_but_voiced_is_kept(self) -> None:
        v = hg.judge(_voiced(5.0, level=0.002), "兴趣小组、学校、社团、专业、兴趣方面。", 0, lambda a: 0)
        self.assertFalse(v.drop)

    def test_long_recordings_are_left_alone(self) -> None:
        self.assertFalse(hg.judge(_noise(31.0), self.SENTENCE, 0, lambda a: 0).drop)

    def test_vad_failure_on_rerun_keeps_the_text(self) -> None:
        self.assertFalse(hg.judge(_click_over_noise(5.0), self.SENTENCE, 0, lambda a: None).drop)


class PunctuationPatternTests(unittest.TestCase):
    """The full-width punctuation in these patterns was once stored mis-encoded and never matched."""

    HOTWORDS = "ChatGPT GPT OpenAI Claude DeepSeek Kimi Gemini"

    def test_hotword_list_separated_by_ideographic_commas_is_caught(self) -> None:
        self.assertTrue(main._is_hotword_hallucination("ChatGPT、GPT、OpenAI、Claude、DeepSeek、Kimi。", self.HOTWORDS))
        self.assertTrue(main._is_hotword_hallucination("ChatGPT，GPT，OpenAI，Claude，DeepSeek", self.HOTWORDS))

    def test_sentence_mentioning_hotwords_is_kept(self) -> None:
        self.assertFalse(main._is_hotword_hallucination("我平时用 ChatGPT、Claude 写代码，偶尔用 Kimi。", self.HOTWORDS))

    def test_punctuation_only_output_is_noise(self) -> None:
        self.assertTrue(main._is_noise("。，、？！", 3.0))
        self.assertFalse(main._is_noise("好的，没问题，就这么办。", 3.0))


class ConfigTests(unittest.TestCase):
    def test_default_mode_is_enforce(self) -> None:
        self.assertEqual(load_config().asr.halluc_guard, "enforce")

    def test_unknown_mode_falls_back(self) -> None:
        self.assertEqual(hg.normalize_mode("ENFORCE"), "enforce")
        self.assertEqual(hg.normalize_mode("nonsense"), "enforce")
        self.assertEqual(hg.normalize_mode("log"), "log")


if __name__ == "__main__":
    unittest.main()
