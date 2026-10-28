"""Provider adapter tests.

No live API calls — every test injects a hand-rolled fake or a
``unittest.mock`` ``AsyncMock`` for the vendor SDK client. The point is
to verify that our adapter shapes (request kwargs, response parsing)
match what the official SDKs expose, not to test the SDKs themselves.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from tidegap.providers import (
    AnthropicAdapter,
    DispatchOptions,
    GeminiAdapter,
    OllamaAdapter,
    OpenAIAdapter,
    ProviderAdapter,
    ProviderRefusalError,
)
from tidegap.providers.anthropic import _create_kwargs
from tidegap.providers.anthropic import _extract_text as _extract_anth
from tidegap.providers.openai import _extract_text as _extract_oai

# --------------------------------------------------------------------- #
# Anthropic


def _fake_anthropic_message() -> Any:
    return SimpleNamespace(
        id="msg_01abc",
        model="claude-sonnet-4-5",
        content=[SimpleNamespace(type="text", text="hello, world")],
        usage=SimpleNamespace(input_tokens=12, output_tokens=4),
    )


def _fake_anthropic_batch() -> Any:
    return SimpleNamespace(id="msgbatch_01xyz", processing_status="in_progress")


def _make_anthropic_client(*, messages_create: Any = None, batches_create: Any = None) -> Any:
    client = SimpleNamespace()
    client.messages = SimpleNamespace(
        create=messages_create or AsyncMock(return_value=_fake_anthropic_message()),
        batches=SimpleNamespace(
            create=batches_create or AsyncMock(return_value=_fake_anthropic_batch()),
        ),
    )
    return client


@pytest.mark.asyncio
async def test_anthropic_dispatch_returns_flattened_text() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    result = await adapter.dispatch("claude-sonnet-4-5", "hi")
    assert result.text == "hello, world"
    assert result.model == "claude-sonnet-4-5"
    assert result.provider == "anthropic"
    assert result.input_tokens == 12
    assert result.output_tokens == 4
    client.messages.create.assert_awaited_once()
    kwargs = client.messages.create.await_args.kwargs
    assert kwargs["model"] == "claude-sonnet-4-5"
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]
    assert kwargs["max_tokens"] == 16000


@pytest.mark.asyncio
async def test_anthropic_dispatch_passes_system_and_extra() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    await adapter.dispatch(
        "claude-sonnet-4-5",
        "hi",
        DispatchOptions(
            max_tokens=256,
            system="You are terse.",
            extra={"temperature": 0.1},
        ),
    )
    kwargs = client.messages.create.await_args.kwargs
    assert kwargs["system"] == "You are terse."
    assert kwargs["extra_body"] == {"temperature": 0.1}
    assert "temperature" not in kwargs
    assert kwargs["max_tokens"] == 256


@pytest.mark.asyncio
async def test_anthropic_dispatch_batch_builds_requests() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    handle = await adapter.dispatch_batch(
        "claude-sonnet-4-5",
        ["one", "two", "three"],
    )
    assert handle.batch_id == "msgbatch_01xyz"
    assert handle.provider == "anthropic"
    assert handle.prompt_count == 3
    client.messages.batches.create.assert_awaited_once()
    kwargs = client.messages.batches.create.await_args.kwargs
    assert len(kwargs["requests"]) == 3
    assert kwargs["requests"][0]["custom_id"] == "req-0"
    assert kwargs["requests"][2]["params"]["messages"] == [
        {"role": "user", "content": "three"}
    ]


@pytest.mark.asyncio
async def test_anthropic_retrieve_batch_in_progress() -> None:
    client = _make_anthropic_client()
    client.messages.batches.retrieve = AsyncMock(
        return_value=SimpleNamespace(processing_status="in_progress")
    )
    adapter = AnthropicAdapter(client=client)
    result = await adapter.retrieve_batch("msgbatch_01xyz")
    assert result.status == "in_progress"


@pytest.mark.asyncio
async def test_anthropic_retrieve_batch_completed() -> None:
    client = _make_anthropic_client()
    client.messages.batches.retrieve = AsyncMock(
        return_value=SimpleNamespace(processing_status="ended")
    )

    async def _results(_batch_id: str) -> Any:
        async def gen() -> Any:
            yield SimpleNamespace(
                result=SimpleNamespace(
                    type="succeeded",
                    message=SimpleNamespace(
                        content=[SimpleNamespace(type="text", text="batched")],
                        usage=SimpleNamespace(input_tokens=11, output_tokens=4),
                        model="claude-sonnet-4-5",
                    ),
                )
            )

        return gen()

    client.messages.batches.results = _results
    adapter = AnthropicAdapter(client=client)
    result = await adapter.retrieve_batch("msgbatch_01xyz")
    assert result.status == "completed"
    assert result.results[0].text == "batched"
    assert result.results[0].total_tokens == 15


def test_anthropic_extract_text_handles_dict_blocks() -> None:
    resp = SimpleNamespace(
        content=[
            {"type": "text", "text": "alpha"},
            {"type": "tool_use", "id": "x"},
            {"type": "text", "text": " beta"},
        ]
    )
    assert _extract_anth(resp) == "alpha beta"


def test_anthropic_adapter_is_provider() -> None:
    client = _make_anthropic_client()
    assert isinstance(AnthropicAdapter(client=client), ProviderAdapter)
    assert AnthropicAdapter.name == "anthropic"


# --------------------------------------------------------------------- #
# Anthropic: sampling parameters, output ceiling, stop reasons


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "sent"),
    [
        ("claude-sonnet-5", False),
        ("claude-opus-5", False),
        ("claude-opus-5-5", False),
        ("claude-opus-4-8", False),
        ("claude-opus-4-7", False),
        ("claude-fable-5-1", False),
        ("claude-mythos-5-1", False),
        ("claude-opus-6", False),
        ("claude-sonnet-4-6", True),
        ("claude-opus-4-6", True),
        ("claude-sonnet-4-5", True),
        ("claude-opus-4-1", True),
        ("claude-haiku-4-5", True),
        ("claude-3-5-sonnet-20241022", True),
        ("us.anthropic.claude-sonnet-4-6-v1:0", True),
        ("global.anthropic.claude-sonnet-5", False),
    ],
)
async def test_anthropic_dispatch_gates_temperature(model: str, sent: bool) -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    await adapter.dispatch(model, "hi", DispatchOptions(extra={"temperature": 0.2}))
    kwargs = client.messages.create.await_args.kwargs
    assert "temperature" not in kwargs
    assert ("extra_body" in kwargs) is sent
    if sent:
        assert kwargs["extra_body"] == {"temperature": 0.2}


@pytest.mark.asyncio
async def test_anthropic_dispatch_drops_every_sampling_param_for_rejecting_model() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    await adapter.dispatch(
        "claude-sonnet-5",
        "hi",
        DispatchOptions(
            extra={"temperature": 0.2, "top_p": 0.9, "top_k": 5, "stop_sequences": ["X"]}
        ),
    )
    kwargs = client.messages.create.await_args.kwargs
    assert "temperature" not in kwargs
    assert "top_p" not in kwargs
    assert "top_k" not in kwargs
    assert "extra_body" not in kwargs
    assert kwargs["stop_sequences"] == ["X"]


@pytest.mark.asyncio
async def test_anthropic_dispatch_without_sampling_sends_no_extra_body() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    await adapter.dispatch("claude-haiku-4-5", "hi", DispatchOptions(system="s"))
    kwargs = client.messages.create.await_args.kwargs
    assert set(kwargs) == {"model", "max_tokens", "messages", "system"}


def test_anthropic_create_kwargs_keeps_caller_extra_body() -> None:
    opts = DispatchOptions(extra={"temperature": 0.2, "extra_body": {"service_tier": "auto"}})
    kwargs = _create_kwargs("claude-haiku-4-5", "hi", opts)
    assert kwargs["extra_body"] == {"service_tier": "auto", "temperature": 0.2}


def test_anthropic_create_kwargs_bind_to_installed_sdk() -> None:
    """The kwargs reach the real ``AsyncMessages.create`` signature (no
    network). anthropic 2.x has no ``temperature`` parameter; a top-level
    sampling kwarg would raise ``TypeError`` there."""
    import inspect

    messages = pytest.importorskip("anthropic.resources.messages")
    sig = inspect.signature(messages.AsyncMessages.create)
    opts = DispatchOptions(
        max_tokens=64,
        system="s",
        metadata={"user_id": "u"},
        extra={"temperature": 0.2, "top_p": 0.9, "top_k": 5, "stop_sequences": ["X"]},
    )
    for model in ("claude-haiku-4-5", "claude-sonnet-5"):
        kwargs = _create_kwargs(model, "hi", opts)
        sig.bind(None, **kwargs)  # None stands in for self


@pytest.mark.asyncio
async def test_anthropic_dispatch_batch_gates_temperature() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    opts = DispatchOptions(extra={"temperature": 0.4})
    await adapter.dispatch_batch("claude-opus-5", ["a", "b"], opts)
    requests = client.messages.batches.create.await_args.kwargs["requests"]
    assert len(requests) == 2
    for req in requests:
        assert "temperature" not in req["params"]

    await adapter.dispatch_batch("claude-haiku-4-5", ["a"], opts)
    requests = client.messages.batches.create.await_args.kwargs["requests"]
    assert requests[0]["params"]["temperature"] == 0.4


@pytest.mark.asyncio
async def test_anthropic_defaults_max_tokens_to_16000() -> None:
    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)
    await adapter.dispatch("claude-sonnet-5", "hi", DispatchOptions())
    assert client.messages.create.await_args.kwargs["max_tokens"] == 16000
    await adapter.dispatch_batch("claude-sonnet-5", ["hi"])
    requests = client.messages.batches.create.await_args.kwargs["requests"]
    assert requests[0]["params"]["max_tokens"] == 16000
    await adapter.dispatch("claude-sonnet-5", "hi", DispatchOptions(max_tokens=512))
    assert client.messages.create.await_args.kwargs["max_tokens"] == 512


def _anthropic_message(**fields: Any) -> Any:
    base: dict[str, Any] = {
        "model": "claude-opus-5",
        "content": [SimpleNamespace(type="text", text="ok")],
        "usage": SimpleNamespace(input_tokens=1, output_tokens=1),
        "stop_reason": "end_turn",
        "stop_details": None,
    }
    base.update(fields)
    return SimpleNamespace(**base)


@pytest.mark.asyncio
async def test_anthropic_refusal_raises_with_category() -> None:
    client = _make_anthropic_client(
        messages_create=AsyncMock(
            return_value=_anthropic_message(
                content=[SimpleNamespace(type="text", text="partial")],
                stop_reason="refusal",
                stop_details=SimpleNamespace(
                    type="refusal", category="cyber", explanation="declined"
                ),
            )
        )
    )
    adapter = AnthropicAdapter(client=client)
    with pytest.raises(ProviderRefusalError) as excinfo:
        await adapter.dispatch("claude-opus-5", "hi")
    assert excinfo.value.category == "cyber"
    assert excinfo.value.provider == "anthropic"
    assert excinfo.value.model == "claude-opus-5"


@pytest.mark.asyncio
async def test_anthropic_refusal_without_details_has_null_category() -> None:
    client = _make_anthropic_client(
        messages_create=AsyncMock(return_value=_anthropic_message(stop_reason="refusal"))
    )
    with pytest.raises(ProviderRefusalError) as excinfo:
        await AnthropicAdapter(client=client).dispatch("claude-opus-5", "hi")
    assert excinfo.value.category is None


@pytest.mark.asyncio
async def test_anthropic_max_tokens_stop_is_reported_on_result() -> None:
    client = _make_anthropic_client(
        messages_create=AsyncMock(
            return_value=_anthropic_message(
                content=[SimpleNamespace(type="text", text="cut off")],
                stop_reason="max_tokens",
            )
        )
    )
    result = await AnthropicAdapter(client=client).dispatch("claude-sonnet-5", "hi")
    assert result.stop_reason == "max_tokens"
    assert result.text == "cut off"


@pytest.mark.asyncio
async def test_anthropic_end_turn_is_reported_on_result() -> None:
    client = _make_anthropic_client(
        messages_create=AsyncMock(return_value=_anthropic_message())
    )
    result = await AnthropicAdapter(client=client).dispatch("claude-sonnet-5", "hi")
    assert result.stop_reason == "end_turn"


def _ended_batch_client(message: Any) -> Any:
    client = _make_anthropic_client()
    client.messages.batches.retrieve = AsyncMock(
        return_value=SimpleNamespace(processing_status="ended")
    )

    async def _results(_batch_id: str) -> Any:
        async def gen() -> Any:
            yield SimpleNamespace(
                result=SimpleNamespace(type="succeeded", message=message)
            )

        return gen()

    client.messages.batches.results = _results
    return client


@pytest.mark.asyncio
async def test_anthropic_retrieve_batch_fails_refused_result() -> None:
    client = _ended_batch_client(
        _anthropic_message(
            content=[],
            stop_reason="refusal",
            stop_details=SimpleNamespace(type="refusal", category="bio"),
        )
    )
    result = await AnthropicAdapter(client=client).retrieve_batch("msgbatch_01")
    assert result.status == "failed"
    assert result.results is None
    assert "refus" in (result.error or "").lower()
    assert "bio" in (result.error or "")


@pytest.mark.asyncio
async def test_anthropic_retrieve_batch_reports_max_tokens_stop() -> None:
    client = _ended_batch_client(
        _anthropic_message(
            content=[SimpleNamespace(type="text", text="cut")],
            stop_reason="max_tokens",
        )
    )
    result = await AnthropicAdapter(client=client).retrieve_batch("msgbatch_01")
    assert result.status == "completed"
    assert result.results[0].stop_reason == "max_tokens"
    assert result.results[0].text == "cut"


# --------------------------------------------------------------------- #
# Per-adapter max_tokens defaults (DispatchOptions.max_tokens is None)


@pytest.mark.asyncio
async def test_openai_applies_1024_when_max_tokens_is_none() -> None:
    client = _make_openai_client()
    await OpenAIAdapter(client=client).dispatch("gpt-4o", "hi", DispatchOptions())
    assert client.chat.completions.create.await_args.kwargs["max_tokens"] == 1024


class _RecordingHttp:
    def __init__(self, payload: Any) -> None:
        self._payload = payload
        self.calls: list[dict[str, Any]] = []

    async def post(self, url: str, **kwargs: Any) -> Any:
        self.calls.append({"url": url, **kwargs})
        return SimpleNamespace(
            status_code=200, text="", json=lambda: self._payload
        )


@pytest.mark.asyncio
async def test_gemini_applies_1024_when_max_tokens_is_none() -> None:
    http = _RecordingHttp({"candidates": [{"content": {"parts": [{"text": "x"}]}}]})
    await GeminiAdapter(api_key="k", client=http).dispatch(
        "gemini-3.8-flash", "hi", DispatchOptions()
    )
    assert http.calls[0]["json"]["generationConfig"]["maxOutputTokens"] == 1024


@pytest.mark.asyncio
async def test_ollama_applies_1024_when_max_tokens_is_none() -> None:
    http = _RecordingHttp({"message": {"content": "x"}})
    await OllamaAdapter(host="http://localhost:11434", client=http).dispatch(
        "llama3.1", "hi", DispatchOptions()
    )
    assert http.calls[0]["json"]["options"]["num_predict"] == 1024


# --------------------------------------------------------------------- #
# OpenAI


def _fake_openai_response() -> Any:
    return SimpleNamespace(
        id="chatcmpl_01abc",
        model="gpt-4.1-mini",
        choices=[
            SimpleNamespace(
                index=0,
                message=SimpleNamespace(role="assistant", content="hi from oai"),
                finish_reason="stop",
            )
        ],
        usage=SimpleNamespace(prompt_tokens=10, completion_tokens=3, total_tokens=13),
    )


def _make_openai_client(*, completions_create: Any = None, batches_create: Any = None, files_create: Any = None) -> Any:
    client = SimpleNamespace()
    client.chat = SimpleNamespace(
        completions=SimpleNamespace(
            create=completions_create or AsyncMock(return_value=_fake_openai_response()),
        )
    )
    client.batches = SimpleNamespace(
        create=batches_create
        or AsyncMock(return_value=SimpleNamespace(id="batch_01xyz", status="validating")),
    )
    client.files = SimpleNamespace(
        create=files_create
        or AsyncMock(return_value=SimpleNamespace(id="file_01abc", purpose="batch")),
    )
    return client


@pytest.mark.asyncio
async def test_openai_dispatch_returns_flattened_text() -> None:
    client = _make_openai_client()
    adapter = OpenAIAdapter(client=client)
    result = await adapter.dispatch("gpt-4.1-mini", "hi")
    assert result.text == "hi from oai"
    assert result.model == "gpt-4.1-mini"
    assert result.provider == "openai"
    assert result.input_tokens == 10
    assert result.output_tokens == 3
    kwargs = client.chat.completions.create.await_args.kwargs
    assert kwargs["model"] == "gpt-4.1-mini"
    assert kwargs["messages"] == [{"role": "user", "content": "hi"}]


@pytest.mark.asyncio
async def test_openai_dispatch_includes_system_message() -> None:
    client = _make_openai_client()
    adapter = OpenAIAdapter(client=client)
    await adapter.dispatch(
        "gpt-4.1-mini",
        "hi",
        DispatchOptions(system="be concise"),
    )
    kwargs = client.chat.completions.create.await_args.kwargs
    assert kwargs["messages"][0] == {"role": "system", "content": "be concise"}
    assert kwargs["messages"][1] == {"role": "user", "content": "hi"}


@pytest.mark.asyncio
async def test_openai_dispatch_batch_uploads_jsonl() -> None:
    files_create = AsyncMock(
        return_value=SimpleNamespace(id="file_uploaded", purpose="batch")
    )
    batches_create = AsyncMock(
        return_value=SimpleNamespace(id="batch_01xyz", status="validating")
    )
    client = _make_openai_client(
        files_create=files_create,
        batches_create=batches_create,
    )
    adapter = OpenAIAdapter(client=client)
    handle = await adapter.dispatch_batch(
        "gpt-4.1-mini",
        ["one", "two"],
    )
    assert handle.batch_id == "batch_01xyz"
    assert handle.prompt_count == 2

    files_create.assert_awaited_once()
    file_kwargs = files_create.await_args.kwargs
    assert file_kwargs["purpose"] == "batch"
    # The file argument is a (name, bytes, mime) tuple — verify the
    # JSONL body has one line per prompt.
    file_arg = file_kwargs["file"]
    body = file_arg[1].read().decode("utf-8")
    lines = [ln for ln in body.splitlines() if ln.strip()]
    assert len(lines) == 2
    import json

    first = json.loads(lines[0])
    assert first["custom_id"] == "req-0"
    assert first["method"] == "POST"
    assert first["url"] == "/v1/chat/completions"
    assert first["body"]["messages"] == [{"role": "user", "content": "one"}]

    batches_create.assert_awaited_once()
    batch_kwargs = batches_create.await_args.kwargs
    assert batch_kwargs["input_file_id"] == "file_uploaded"
    assert batch_kwargs["endpoint"] == "/v1/chat/completions"
    assert batch_kwargs["completion_window"] == "24h"


@pytest.mark.asyncio
async def test_openai_retrieve_batch_in_progress() -> None:
    client = _make_openai_client()
    client.batches.retrieve = AsyncMock(
        return_value=SimpleNamespace(status="in_progress")
    )
    adapter = OpenAIAdapter(client=client)
    result = await adapter.retrieve_batch("batch_01xyz")
    assert result.status == "in_progress"


@pytest.mark.asyncio
async def test_openai_retrieve_batch_completed_parses_jsonl() -> None:
    import json

    output_line = json.dumps(
        {
            "custom_id": "req-0",
            "response": {
                "body": {
                    "choices": [{"message": {"content": "batched reply"}}],
                    "usage": {
                        "prompt_tokens": 8,
                        "completion_tokens": 3,
                        "total_tokens": 11,
                    },
                    "model": "gpt-4.1-mini",
                }
            },
        }
    )
    client = _make_openai_client()
    client.batches.retrieve = AsyncMock(
        return_value=SimpleNamespace(
            status="completed", output_file_id="out_file_1"
        )
    )
    client.files.content = AsyncMock(
        return_value=SimpleNamespace(text=output_line + "\n")
    )
    adapter = OpenAIAdapter(client=client)
    result = await adapter.retrieve_batch("batch_01xyz")
    assert result.status == "completed"
    assert result.results[0].text == "batched reply"
    assert result.results[0].total_tokens == 11


def test_openai_extract_text_handles_dict_message() -> None:
    resp = SimpleNamespace(
        choices=[{"message": {"role": "assistant", "content": "from-dict"}}]
    )
    assert _extract_oai(resp) == "from-dict"


def test_openai_adapter_is_provider() -> None:
    client = _make_openai_client()
    assert isinstance(OpenAIAdapter(client=client), ProviderAdapter)
    assert OpenAIAdapter.name == "openai"


# --------------------------------------------------------------------- #
# Integration with the scheduler


@pytest.mark.asyncio
async def test_provider_runs_under_scheduler() -> None:
    """Smoke: a provider call wrapped in defer() round-trips through the
    scheduler and produces a receipt with the right provider stamped on
    it (once the v0.3 enrichment lands; for now we at least verify the
    call body returns the dispatch result).
    """
    from datetime import UTC, datetime, timedelta

    from tidegap import DeferOptions, Scheduler, mock_grid_feed

    client = _make_anthropic_client()
    adapter = AnthropicAdapter(client=client)

    async def call() -> str:
        result = await adapter.dispatch("claude-sonnet-4-5", "ping")
        return result.text

    s = Scheduler(feed=mock_grid_feed())
    try:
        text = await s.defer(
            call,
            DeferOptions(
                deadline=(datetime.now(UTC) + timedelta(milliseconds=300)).isoformat()
            ),
        )
        assert text == "hello, world"
        rec = s.list_tasks()[0]
        assert rec.status == "completed"
        assert rec.receipt is not None
    finally:
        await s.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna", "GPT-6-sol"])
async def test_openai_gpt6_sends_max_completion_tokens(model: str) -> None:
    client = _make_openai_client()
    await OpenAIAdapter(client=client).dispatch(
        model, "hi", DispatchOptions(max_tokens=64, extra={"temperature": 0.7})
    )
    kwargs = client.chat.completions.create.await_args.kwargs
    assert kwargs["max_completion_tokens"] == 64
    assert "max_tokens" not in kwargs
    assert kwargs["temperature"] == 0.7
