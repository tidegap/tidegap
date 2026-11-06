"""Gemini adapter.

Talks to Google's Generative Language API
(https://generativelanguage.googleapis.com) directly over ``httpx`` — no
vendor SDK dependency. The API key is read from ``GEMINI_API_KEY``, falling
back to ``GOOGLE_API_KEY`` (the precedence Google's own ``google-genai`` SDK
uses).

Endpoint used:
  - ``POST /v1beta/models/{model}:generateContent`` — sync dispatch, returns
    text plus real ``usageMetadata`` token counts.

Batch: DELIBERATELY UNSUPPORTED (mirrors the TS adapter). The uniform batch
surface here is submit → batch_id → poll(retrieve_batch) → per-request
results, modelled on Anthropic Message Batches and OpenAI Batch Files. Gemini
does not map cleanly:

- Vertex AI batch prediction requires a GCS/BigQuery source/sink — a
  different I/O contract entirely.
- The Developer-API batch mode returns a long-running *operation* keyed by an
  operation name, not a batch id with a separate results endpoint, and its
  retrieval + usage semantics differ from the shared contract.

So this adapter implements only the sync path — it inherits the base
``dispatch_batch`` / ``retrieve_batch`` stubs (both raise). The scheduler
feature-detects that (:func:`tidegap.scheduler._has_batch_support`) and keeps
Gemini tasks on the sync path.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from ..errors import PermanentProviderError, http_error
from .base import (
    DEFAULT_MAX_TOKENS,
    DispatchOptions,
    DispatchResult,
    ProviderAdapter,
    request_timeout,
)

_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class GeminiAdapter(ProviderAdapter):
    """Adapter for Google Gemini models via the Generative Language API.

    Parameters
    ----------
    api_key:
        Gemini API key. If omitted, read from ``GEMINI_API_KEY`` then
        ``GOOGLE_API_KEY``.
    base_url:
        Override the API base URL (defaults to the public endpoint).
    client:
        Optional pre-built ``httpx.AsyncClient`` (or any object exposing an
        awaitable ``post(url, *, headers, json, timeout=...)`` returning a
        response with ``status_code`` / ``json()`` / ``text``). Injected in
        tests to avoid live calls. When omitted, a short-lived client is
        created per call.
    timeout_s:
        Per-request timeout of the default client when a call names no time
        limit (direct library use; the scheduler names the one it resolved).
    """

    name = "gemini"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        client: Any | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        self._api_key = (
            api_key
            or os.environ.get("GEMINI_API_KEY")
            or os.environ.get("GOOGLE_API_KEY")
        )
        self._base_url = (base_url or _DEFAULT_BASE_URL).rstrip("/")
        self._client = client
        self._timeout_s = timeout_s

    @property
    def ready(self) -> bool:
        """True once an API key is available (env or constructor)."""
        return bool(self._api_key)

    async def dispatch(
        self,
        model: str,
        prompt: str,
        options: DispatchOptions | None = None,
    ) -> DispatchResult:
        if not self._api_key:
            raise PermanentProviderError(
                "GeminiAdapter: no API key. Set GEMINI_API_KEY (or "
                "GOOGLE_API_KEY) or pass api_key=... to the constructor."
            )
        opts = options or DispatchOptions()

        generation_config: dict[str, Any] = {
            "maxOutputTokens": opts.max_tokens
            if opts.max_tokens is not None
            else DEFAULT_MAX_TOKENS
        }
        temperature = opts.extra.get("temperature")
        if temperature is not None:
            generation_config["temperature"] = temperature

        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        }
        if opts.system is not None:
            body["systemInstruction"] = {"parts": [{"text": opts.system}]}
        if generation_config:
            body["generationConfig"] = generation_config

        # The key rides the `x-goog-api-key` header (keeping it out of URLs /
        # access logs) rather than the legacy `?key=` query parameter.
        url = f"{self._base_url}/models/{model}:generateContent"
        headers = {
            "content-type": "application/json",
            "x-goog-api-key": self._api_key,
        }

        if self._client is not None:
            res = await self._client.post(url, headers=headers, json=body, **request_timeout(opts))
        else:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout_s)
            ) as client:
                res = await client.post(url, headers=headers, json=body, **request_timeout(opts))

        if res.status_code != httpx.codes.OK:
            raise http_error(f"Gemini API {res.status_code}: {res.text[:300]}", res.status_code)

        data = res.json()
        text = _extract_text(data)
        usage = data.get("usageMetadata") or {}
        return DispatchResult(
            text=text,
            model=data.get("modelVersion") or model,
            provider=self.name,
            raw=data,
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
        )


def _extract_text(data: Any) -> str:
    """Concatenate the text parts of the first candidate."""
    candidates = data.get("candidates") if isinstance(data, dict) else None
    if not candidates:
        return ""
    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    chunks: list[str] = []
    for part in parts:
        value = part.get("text") if isinstance(part, dict) else None
        if isinstance(value, str):
            chunks.append(value)
    return "".join(chunks)


__all__ = ["GeminiAdapter"]
