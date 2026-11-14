// 转写供应商模块 — ASR 和 AI 的 trait 定义及具体实现

pub mod types;
pub mod prompt;
pub mod diag;
pub mod http_client;
pub mod capabilities;
pub mod ai_openai_compat;
pub mod ai_ollama;
pub mod asr_doubao;
pub mod asr_doubao_stream;
pub mod asr_doubao_realtime;
pub mod asr_qwen;
pub mod asr_qwen_omni;
pub mod asr_mimo;
pub mod asr_deepseek;
pub mod asr_groq;
pub mod asr_gemini;
pub mod asr_gemini_live;
pub mod asr_openai_chat_audio;
pub mod asr_openai_compat;
pub mod asr_openai_realtime;
pub mod asr_openrouter;
pub mod asr_qwen_realtime;
pub mod asr_qwen_audio_stream;
pub mod doubao_auth;
pub mod doubao_protocol;
pub mod registry;
