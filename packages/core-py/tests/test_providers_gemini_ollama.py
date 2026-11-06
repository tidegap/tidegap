"""Gemini + Ollama adapter tests.

No live HTTP — every test injects a fake ``httpx``-like client (an object
whose awaitable ``post`` returns a canned response, or raises to simulate a
connection failure). Mirrors ``test_providers.py`` and the TS
``providers-gemini-ollama.test.ts``.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tidegap.providers import (
    DispatchOptions,
    GeminiAdapter,
    OllamaAdapter,
    ProviderAdapter,
)


class _FakeResponse:
    def __init__(self, *, status_code: int = 200, payload: Any = None, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self) -> Any:
        return self._payload


class _FakeClient:
    """Records the last ``post`` call and returns a fixed response."""

    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
        self.calls.append({"url": url, **kwargs})
        return self._response


class _RaisingClient:
    def __init__(self, err: Exception) -> None:
        self._err = err

    async def post(self, url: str, **kwargs: Any) -> Any:
        raise self._err


# --------------------------------------------------------------------- #
# Gemini


@pytest.mark.asyncio
async def test_gemini_dispatch_shapes_text_and_usage() -> None:
    payload = {
        "candidates": [
            {"content": {"parts": [{"text": "hello "}, {"text": "world"}]}}
        ],
        "usageMetadata": {
            "promptTokenCount": 12,
            "candidatesTokenCount": 5,
            "totalTokenCount": 17,
        },
        "modelVersion": "gemini-2.0-flash-001",
    }
    client = _FakeClient(_FakeResponse(payload=payload))
    adapter = GeminiAdapter(api_key="secret-key", client=client)
    result = await adapter.dispatch(
        "gemini-2.0-flash",
        "hi",
        DispatchOptions(max_tokens=128, system="be brief", extra={"temperature": 0.4}),
    )
    assert result.text == "hello world"
    assert result.provider == "gemini"
    assert result.model == "gemini-2.0-flash-001"
    assert result.input_tokens == 12
    assert result.output_tokens == 5

    call = client.calls[0]
    assert call["url"].endswith("/models/gemini-2.0-flash:generateContent")
    assert call["headers"]["x-goog-api-key"] == "secret-key"
    body = call["json"]
    assert body["systemInstruction"]["parts"][0]["text"] == "be brief"
    assert body["generationConfig"]["maxOutputTokens"] == 128
    assert body["generationConfig"]["temperature"] == 0.4
    assert body["contents"] == [{"role": "user", "parts": [{"text": "hi"}]}]


def test_gemini_ready_reflects_key() -> None:
    assert GeminiAdapter(api_key="k").ready is True
    assert GeminiAdapter(api_key=None, client=_FakeClient(_FakeResponse())).ready is False


@pytest.mark.asyncio
async def test_gemini_dispatch_without_key_raises() -> None:
    # Ensure env keys do not leak in.
    adapter = GeminiAdapter(api_key=None, client=_FakeClient(_FakeResponse()))
    adapter._api_key = None  # type: ignore[attr-defined]
    with pytest.raises(RuntimeError, match=r"no API key.*GEMINI_API_KEY.*GOOGLE_API_KEY"):
        await adapter.dispatch("gemini-2.0-flash", "hi")


@pytest.mark.asyncio
async def test_gemini_reads_env_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "goog")
    assert GeminiAdapter().ready is True
    monkeypatch.setenv("GEMINI_API_KEY", "gem")
    assert GeminiAdapter()._api_key == "gem"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_gemini_non_200_raises() -> None:
    client = _FakeClient(_FakeResponse(status_code=429, text="rate limited"))
    adapter = GeminiAdapter(api_key="k", client=client)
    with pytest.raises(RuntimeError, match=r"Gemini API 429: rate limited"):
        await adapter.dispatch("gemini-2.0-flash", "hi")


def test_gemini_has_no_batch_override() -> None:
    from tidegap.scheduler import _has_batch_support

    adapter = GeminiAdapter(api_key="k")
    # Base stubs are inherited (not overridden) → not batch-capable.
    assert _has_batch_support(adapter) is False


def test_gemini_is_provider() -> None:
    assert isinstance(GeminiAdapter(api_key="k"), ProviderAdapter)
    assert GeminiAdapter.name == "gemini"


# --------------------------------------------------------------------- #
# Ollama


@pytest.mark.asyncio
async def test_ollama_dispatch_shapes_text_and_token_counts() -> None:
    payload = {
        "message": {"content": "local answer"},
        "prompt_eval_count": 9,
        "eval_count": 4,
        "model": "llama3.1",
    }
    client = _FakeClient(_FakeResponse(payload=payload))
    adapter = OllamaAdapter(host="http://localhost:11434", client=client)
    result = await adapter.dispatch(
        "llama3.1",
        "hi",
        DispatchOptions(max_tokens=64, system="be brief", extra={"temperature": 0.3}),
    )
    assert result.text == "local answer"
    assert result.provider == "ollama"
    assert result.model == "llama3.1"
    assert result.input_tokens == 9
    assert result.output_tokens == 4

    body = client.calls[0]["json"]
    assert client.calls[0]["url"] == "http://localhost:11434/api/chat"
    assert body["stream"] is False
    assert body["messages"][0] == {"role": "system", "content": "be brief"}
    assert body["messages"][1] == {"role": "user", "content": "hi"}
    assert body["options"]["temperature"] == 0.3
    assert body["options"]["num_predict"] == 64


def test_ollama_normalizes_bare_host() -> None:
    a = OllamaAdapter(host="myhost:11434")
    assert a._host == "http://myhost:11434"  # type: ignore[attr-defined]
    b = OllamaAdapter(host="http://x:1/")
    assert b._host == "http://x:1"  # type: ignore[attr-defined]


def test_ollama_ready_is_true() -> None:
    assert OllamaAdapter().ready is True


@pytest.mark.asyncio
async def test_ollama_connection_refused_is_wrapped() -> None:
    client = _RaisingClient(httpx.ConnectError("Connection refused"))
    adapter = OllamaAdapter(host="http://localhost:11434", client=client)
    with pytest.raises(RuntimeError, match=r"could not reach Ollama at http://localhost:11434"):
        await adapter.dispatch("llama3.1", "hi")


@pytest.mark.asyncio
async def test_ollama_non_200_raises() -> None:
    client = _FakeClient(_FakeResponse(status_code=404, text="model not found"))
    adapter = OllamaAdapter(host="http://localhost:11434", client=client)
    with pytest.raises(RuntimeError, match=r"Ollama API 404: model not found"):
        await adapter.dispatch("llama3.1", "hi")


def test_ollama_has_no_batch_override() -> None:
    from tidegap.scheduler import _has_batch_support

    assert _has_batch_support(OllamaAdapter()) is False


def test_ollama_is_provider() -> None:
    assert isinstance(OllamaAdapter(), ProviderAdapter)
    assert OllamaAdapter.name == "ollama"


# --------------------------------------------------------------------- #
# Scheduler enqueue accepts the new providers (enum surface)


@pytest.mark.asyncio
async def test_enqueue_accepts_gemini_and_ollama_rejects_unknown() -> None:
    from datetime import UTC, datetime, timedelta

    from tidegap import DeferOptions, Scheduler, mock_grid_feed
    from tidegap.types import ProviderCallSpec

    opts = DeferOptions(
        deadline=(datetime.now(UTC) + timedelta(hours=1)).isoformat()
    )
    s = Scheduler(feed=mock_grid_feed())
    try:
        for provider, model in [("gemini", "gemini-2.0-flash"), ("ollama", "llama3.1")]:
            rec = await s.enqueue_provider_call(
                ProviderCallSpec(provider=provider, model=model, prompt="hi"),
                opts,
            )
            assert rec.status in ("queued", "scheduled")

        with pytest.raises(ValueError, match="unsupported provider"):
            await s.enqueue_provider_call(
                ProviderCallSpec(provider="mystery", model="m", prompt="hi"),  # type: ignore[arg-type]
                opts,
            )
    finally:
        await s.shutdown()


# --------------------------------------------------------------------- #
# The LLM time limit of a dispatch


_GEMINI_OK = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
_OLLAMA_OK = {"message": {"content": "ok"}}


@pytest.mark.asyncio
async def test_gemini_gets_the_dispatch_time_limit_instead_of_its_60_s() -> None:
    client = _FakeClient(_FakeResponse(payload=_GEMINI_OK))
    adapter = GeminiAdapter(api_key="k", client=client)
    await adapter.dispatch("gemini-2.0-flash", "hi", DispatchOptions(timeout_s=600))
    await adapter.dispatch("gemini-2.0-flash", "hi", DispatchOptions(timeout_s="none"))
    await adapter.dispatch("gemini-2.0-flash", "hi")
    assert client.calls[0]["timeout"] == 600.0
    # none: no timeout at all.
    assert "timeout" in client.calls[1] and client.calls[1]["timeout"] is None
    # No limit named (direct library use): the client keeps its own.
    assert "timeout" not in client.calls[2]


@pytest.mark.asyncio
async def test_ollama_gets_the_dispatch_time_limit_instead_of_its_300_s() -> None:
    client = _FakeClient(_FakeResponse(payload=_OLLAMA_OK))
    adapter = OllamaAdapter(client=client)
    await adapter.dispatch("llama3", "hi", DispatchOptions(timeout_s=600))
    await adapter.dispatch("llama3", "hi", DispatchOptions(timeout_s="none"))
    assert client.calls[0]["timeout"] == 600.0
    assert client.calls[1]["timeout"] is None


@pytest.mark.asyncio
async def test_the_default_client_takes_the_dispatch_time_limit_per_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[Any] = []

    class _Client:
        def __init__(self, **_: Any) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *_: Any) -> None:
            return None

        async def post(self, url: str, **kwargs: Any) -> _FakeResponse:
            seen.append(kwargs.get("timeout", "unset"))
            return _FakeResponse(payload=_GEMINI_OK)

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    adapter = GeminiAdapter(api_key="k")
    await adapter.dispatch("gemini-2.0-flash", "hi", DispatchOptions(timeout_s=600))
    assert seen == [600.0]
