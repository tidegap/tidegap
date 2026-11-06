"""Ollama adapter.

Talks to a local Ollama server over HTTP (default http://localhost:11434,
override with ``OLLAMA_HOST``). No API key — Ollama runs on the machine. Uses
``httpx`` directly; no vendor SDK dependency.

Endpoint used:
  - ``POST /api/chat`` (stream:false) — sync dispatch, returns the assistant
    message plus ``prompt_eval_count`` / ``eval_count`` token counts.

Batch: UNSUPPORTED. Ollama is local inference with no batch API — there is no
cost/SLA batch tier to route through. This adapter inherits the base
``dispatch_batch`` / ``retrieve_batch`` stubs (both raise); the scheduler
keeps Ollama tasks on the sync path.

Carbon accounting is unchanged: energy coefficients for local models
(``llama-*``, ``mistral-*``, ``mixtral-*``) already live in the SSOT energy
table, and the receipt applies the caller's grid intensity exactly as it does
for hosted providers. There is no special-cased "local" carbon logic here.
"""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

from ..errors import http_error
from .base import (
    DEFAULT_MAX_TOKENS,
    DispatchOptions,
    DispatchResult,
    ProviderAdapter,
    request_timeout,
)

_DEFAULT_HOST = "http://localhost:11434"


def _normalize_host(raw: str | None) -> str:
    """Normalize a host into a scheme-qualified base URL with no trailing slash."""
    host = (raw or _DEFAULT_HOST).strip() or _DEFAULT_HOST
    if not re.match(r"^https?://", host, re.IGNORECASE):
        host = f"http://{host}"
    return host.rstrip("/")


class OllamaAdapter(ProviderAdapter):
    """Adapter for a local Ollama server.

    Parameters
    ----------
    host:
        Base host URL. If omitted, read from ``OLLAMA_HOST``, else
        ``http://localhost:11434``. A bare ``host:port`` is accepted and
        prefixed with ``http://``.
    client:
        Optional pre-built ``httpx.AsyncClient`` (or any object exposing an
        awaitable ``post(url, *, json, timeout=...)`` returning a response with
        ``status_code`` / ``json()`` / ``text``). Injected in tests to avoid
        live calls. When omitted, a short-lived client is created per call.
    timeout_s:
        Per-request timeout of the default client when a call names no time
        limit (direct library use; the scheduler names the one it resolved).
        Local inference can be slow, so this is generous.
    """

    name = "ollama"

    def __init__(
        self,
        *,
        host: str | None = None,
        client: Any | None = None,
        timeout_s: float = 300.0,
    ) -> None:
        self._host = _normalize_host(host if host is not None else os.environ.get("OLLAMA_HOST"))
        self._client = client
        self._timeout_s = timeout_s

    @property
    def ready(self) -> bool:
        """Always True: Ollama is local + keyless. Reachability of the local
        server surfaces at dispatch time (a connection-refused there), not
        here."""
        return True

    async def dispatch(
        self,
        model: str,
        prompt: str,
        options: DispatchOptions | None = None,
    ) -> DispatchResult:
        opts = options or DispatchOptions()

        ollama_options: dict[str, Any] = {}
        temperature = opts.extra.get("temperature")
        if temperature is not None:
            ollama_options["temperature"] = temperature
        ollama_options["num_predict"] = (
            opts.max_tokens if opts.max_tokens is not None else DEFAULT_MAX_TOKENS
        )

        messages: list[dict[str, str]] = []
        if opts.system is not None:
            messages.append({"role": "system", "content": opts.system})
        messages.append({"role": "user", "content": prompt})

        body: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
        if ollama_options:
            body["options"] = ollama_options

        url = f"{self._host}/api/chat"
        try:
            if self._client is not None:
                res = await self._client.post(url, json=body, **request_timeout(opts))
            else:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self._timeout_s)
                ) as client:
                    res = await client.post(url, json=body, **request_timeout(opts))
        except httpx.HTTPError as err:
            # Connection refused / DNS / TLS — the local server is unreachable.
            raise RuntimeError(
                f"OllamaAdapter: could not reach Ollama at {self._host} ({err}). "
                "Is `ollama serve` running? Set OLLAMA_HOST to override the address."
            ) from err

        if res.status_code != httpx.codes.OK:
            raise http_error(f"Ollama API {res.status_code}: {res.text[:300]}", res.status_code)

        data = res.json()
        message = data.get("message") or {}
        return DispatchResult(
            text=message.get("content") or "",
            model=data.get("model") or model,
            provider=self.name,
            raw=data,
            input_tokens=data.get("prompt_eval_count"),
            output_tokens=data.get("eval_count"),
        )


__all__ = ["OllamaAdapter"]
