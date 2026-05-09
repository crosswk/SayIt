"""LLM engine: text polishing via Azure OpenAI / OpenAI-compatible / Groq / Ollama."""
from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

import httpx

from .config import LLMProfile

logger = logging.getLogger("sayit.llm")


def _read_prompt(path: str, fallback: str = "") -> str:
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except Exception:
        return fallback


_DEFAULT_SYSTEM_PROMPT = """\
你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是清洗为可直接使用的干净文本。
核心原则：保留用户全部有效信息，只清除语音噪声和识别错误。

处理规则：
1. 移除口语填充词（嗯、啊、那个、就是说、然后呢）和无意义的重复、犹豫。
2. 识别自我修正——"不对"、"不是"、"应该是"、"改到"后以最终表达为准，删除前序错误。
3. 修正明显的语音识别错误：同音字、音近字、专有名词、英文大小写、数字和时间。
4. 添加标点符号，必要时分段。中英文混合保留合理空格。
5. 检测到"第一/第二/首先/然后"等结构化表达时，输出为有序列表。

约束：
- 不添加原文没有的内容，不改变用户核心语义
- 不回答、解释、总结或续写文本中提到的问题

只输出精炼后的文本。"""

_DEFAULT_USER_PREFIX = "请校对以下 <asr_text> 标签内的语音转写文本：\n\n<asr_text>"


class LLMEngine:
    def __init__(self, profile: LLMProfile) -> None:
        self._cfg = profile
        provider = profile.provider.lower()
        timeout_map = {"azure": profile.azure_timeout, "openai": profile.openai_timeout, "groq": profile.groq_timeout, "ollama": profile.ollama_timeout}
        timeout = timeout_map.get(provider, 15)
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=8.0))

    async def close(self):
        await self._client.aclose()

    # ── public API ──

    async def polish(self, text: str, system_prompt: str | None = None) -> tuple[str, int, dict]:
        """Polish text, return (result, elapsed_ms, debug_info)."""
        if not text or not self._cfg.enabled:
            return text, 0, {"skipped": True}

        messages = self._build_messages(text, system_prompt)
        provider = self._cfg.provider.lower()

        try:
            t = time.monotonic()
            if provider == "azure":
                raw = await self._call_azure(messages)
            elif provider == "openai":
                raw = await self._call_openai(messages)
            elif provider == "groq":
                raw = await self._call_groq(messages)
            else:
                raw = await self._call_ollama(messages)
            ms = int((time.monotonic() - t) * 1000)

            result = self._strip_thinking(raw) or text
            if self._cfg.debug_llm:
                logger.info("LLM %s %dms: %s", provider, ms, result[:200])
            if provider == "openai":
                model = self._cfg.openai_model
            elif provider == "azure":
                model = self._cfg.azure_deployment
            elif provider == "groq":
                model = self._cfg.groq_model
            else:
                model = self._cfg.ollama_model
            debug = {
                "provider": provider,
                "model": model,
            }
            if self._cfg.debug_llm:
                debug["messages"] = messages
                debug["raw_output"] = raw
            return result, ms, debug
        except Exception as e:
            logger.exception("LLM %s failed, returning original", provider)
            return text, 0, {"error": str(e)}

    # ── internals ──

    def _build_messages(self, text: str, system_prompt: str | None = None) -> list[dict]:
        d = self._cfg.prompt_dir
        sys_p = system_prompt or _read_prompt(f"{d}/system.txt", _DEFAULT_SYSTEM_PROMPT)
        user_prefix = _read_prompt(f"{d}/user.txt", _DEFAULT_USER_PREFIX)
        user_content = f"{user_prefix}{text}\n</asr_text>" if "<asr_text>" in user_prefix else f"{user_prefix}{text}"
        return [{"role": "system", "content": sys_p}, {"role": "user", "content": user_content}]

    @staticmethod
    def _strip_thinking(text: str) -> str:
        if not text:
            return ""
        c = re.sub(r"<think>.*?</think>", "", text, flags=re.I | re.DOTALL)
        c = re.sub(r"</?asr_text>", "", c, flags=re.I)
        if "最终答案" in c:
            c = c.split("最终答案", 1)[-1]
        c = re.sub(r"^\s*[:：]\s*", "", c)
        return c.strip()

    @staticmethod
    def _extract_text(data: dict) -> str:
        choices = data.get("choices") or []
        if not choices:
            return ""
        msg = (choices[0] or {}).get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return "".join(
                it.get("text", "") for it in content
                if isinstance(it, dict) and it.get("type") == "text"
            ).strip()
        return ""

    async def _call_azure(self, messages: list[dict]) -> str:
        ep = self._cfg.azure_endpoint.rstrip("/")
        dep = self._cfg.azure_deployment
        ver = self._cfg.azure_api_version
        url = f"{ep}/openai/deployments/{dep}/chat/completions?api-version={ver}"
        payload = {"messages": messages, "temperature": 0.2, "max_tokens": 2048}
        resp = await self._client.post(
            url, json=payload,
            headers={"api-key": self._cfg.azure_api_key},
            timeout=self._cfg.azure_timeout,
        )
        resp.raise_for_status()
        return self._extract_text(resp.json())

    @staticmethod
    def _chat_url(base_url: str) -> str:
        base = base_url.rstrip("/")
        # Strip trailing /v1 if present, then always append /v1/chat/completions
        if base.endswith("/v1"):
            base = base[:-3]
        return f"{base}/v1/chat/completions"

    async def _call_openai(self, messages: list[dict]) -> str:
        url = self._chat_url(self._cfg.openai_base_url)
        payload = {"model": self._cfg.openai_model, "temperature": 0.2, "messages": messages}
        resp = await self._client.post(
            url, json=payload,
            headers={"Authorization": f"Bearer {self._cfg.openai_api_key}"},
            timeout=self._cfg.openai_timeout,
        )
        resp.raise_for_status()
        return self._extract_text(resp.json())

    async def _call_groq(self, messages: list[dict]) -> str:
        url = self._chat_url(self._cfg.groq_base_url)
        payload = {"model": self._cfg.groq_model, "temperature": 0.2, "messages": messages}
        resp = await self._client.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {self._cfg.groq_api_key}"},
            timeout=self._cfg.groq_timeout,
        )
        resp.raise_for_status()
        return self._extract_text(resp.json())

    async def _call_ollama(self, messages: list[dict]) -> str:
        combined = "\n\n".join(m["content"] for m in messages)
        payload = {"model": self._cfg.ollama_model, "stream": False, "prompt": combined}
        resp = await self._client.post(
            self._cfg.ollama_url, json=payload, timeout=self._cfg.ollama_timeout,
        )
        resp.raise_for_status()
        return (resp.json().get("response") or "").strip()
