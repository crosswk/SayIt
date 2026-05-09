// Model catalog

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadSource {
    pub source: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub languages: Vec<String>,
    pub sources: Vec<DownloadSource>,
    #[serde(default)]
    pub archive_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub path: String,
    pub complete: bool,
}

fn hf(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{}/resolve/main/{}", repo, file)
}

fn hf_mirror(repo: &str, file: &str) -> String {
    format!("https://hf-mirror.com/{}/resolve/main/{}", repo, file)
}

fn ms(repo: &str, file: &str) -> String {
    format!("https://modelscope.cn/models/{}/resolve/master/{}", repo, file)
}

pub fn get_available_models() -> Vec<ModelInfo> {
    let hf_repo = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
    let ms_repo = "xiaowangge/sherpa-onnx-sense-voice-small";
    let langs = vec!["zh".into(), "en".into(), "ja".into(), "ko".into(), "yue".into()];

    vec![
        ModelInfo {
            id: "sensevoice-small".into(),
            name: "SenseVoice Small (INT8)".into(),
            description: "228MB · 速度快 · 中/英/日/韩/粤 · 推荐".into(),
            model_type: "sensevoice".into(),
            total_size_bytes: 228 * 1024 * 1024,
            languages: langs.clone(),
            sources: vec![
                DownloadSource {
                    source: "ModelScope".into(),
                    files: vec![
                        ModelFile { name: "model.int8.onnx".into(), url: ms(ms_repo, "model_q8.onnx"), size_bytes: 0, sha256: None },
                        ModelFile { name: "tokens.txt".into(), url: ms(ms_repo, "tokens.txt"), size_bytes: 0, sha256: None },
                    ],
                },
                DownloadSource {
                    source: "HuggingFace".into(),
                    files: vec![
                        ModelFile { name: "model.int8.onnx".into(), url: hf(hf_repo, "model.int8.onnx"), size_bytes: 0, sha256: None },
                        ModelFile { name: "tokens.txt".into(), url: hf(hf_repo, "tokens.txt"), size_bytes: 0, sha256: None },
                    ],
                },
                DownloadSource {
                    source: "HuggingFace Mirror".into(),
                    files: vec![
                        ModelFile { name: "model.int8.onnx".into(), url: hf_mirror(hf_repo, "model.int8.onnx"), size_bytes: 0, sha256: None },
                        ModelFile { name: "tokens.txt".into(), url: hf_mirror(hf_repo, "tokens.txt"), size_bytes: 0, sha256: None },
                    ],
                },
            ],
            archive_url: None,
        },
        ModelInfo {
            id: "sensevoice-small-fp32".into(),
            name: "SenseVoice Small (FP32)".into(),
            description: "937MB · 精度更高 · 中/英/日/韩/粤".into(),
            model_type: "sensevoice".into(),
            total_size_bytes: 937 * 1024 * 1024,
            languages: langs,
            sources: vec![
                DownloadSource {
                    source: "ModelScope".into(),
                    files: vec![
                        ModelFile { name: "model.onnx".into(), url: ms(ms_repo, "model.onnx"), size_bytes: 0, sha256: None },
                        ModelFile { name: "tokens.txt".into(), url: ms(ms_repo, "tokens.txt"), size_bytes: 0, sha256: None },
                    ],
                },
                DownloadSource {
                    source: "HuggingFace".into(),
                    files: vec![
                        ModelFile { name: "model.onnx".into(), url: hf(hf_repo, "model.onnx"), size_bytes: 0, sha256: None },
                        ModelFile { name: "tokens.txt".into(), url: hf(hf_repo, "tokens.txt"), size_bytes: 0, sha256: None },
                    ],
                },
                DownloadSource {
                    source: "HuggingFace Mirror".into(),
                    files: vec![
                        ModelFile { name: "model.onnx".into(), url: hf_mirror(hf_repo, "model.onnx"), size_bytes: 0, sha256: None },
                        ModelFile { name: "tokens.txt".into(), url: hf_mirror(hf_repo, "tokens.txt"), size_bytes: 0, sha256: None },
                    ],
                },
            ],
            archive_url: None,
        },
    ]
}
