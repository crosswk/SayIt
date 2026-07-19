from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
README = ROOT / "README.md"
ASR_DOC = ROOT / "docs" / "SayIt 语音识别配置.md"


def test_readme_calls_out_sensevoice_hotword_boundary():
    text = README.read_text(encoding="utf-8")
    assert "本地 Qwen3-ASR" in text
    assert "本地 SenseVoice" in text
    assert "后处理纠错" in text


def test_asr_doc_keeps_hotword_support_matrix():
    text = ASR_DOC.read_text(encoding="utf-8")
    assert "### 热词支持情况" in text
    assert "| 本地 Qwen3-ASR | 支持 |" in text
    assert "| 本地 SenseVoice | 不支持 ASR 热词 |" in text
    assert "sherpa-onnx SenseVoice 配置没有热词/context bias 字段" in text
