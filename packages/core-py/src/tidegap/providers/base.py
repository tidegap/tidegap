"""Provider adapter interface.

A provider adapter abstracts the differences between LLM vendors so the
scheduler can route a deferred task to a sync endpoint *or* a batch
endpoint without the caller needing to know which one will be picked.

Both adapters in v0.2 (:class:`tidegap.providers.AnthropicAdapter`,
:class:`tidegap.providers.OpenAIAdapter`) implement this surface.
Adapters are *lazy* about importing the vendor SDK so that:

- ``import tidegap.providers.anthropic`` succeeds even if the
  ``anthropic`` package isn't installed.
- The first time a caller actually constructs the adapter (or invokes
  it) we raise a clear, actionable error.

This pattern matches what the official Anthropic and OpenAI quickstarts
show users, but bundled behind one common surface.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

#: Output ceiling an adapter applies when ``DispatchOptions.max_tokens`` is
#: ``None``. The Anthropic adapter overrides it with its own, larger default.
DEFAULT_MAX_TOKENS = 1024


@dataclass(slots=True)
class DispatchOptions:
    """Per-call knobs for provider adapters.

    Parameters
    ----------
    max_tokens:
        Maximum tokens the provider should generate. ``None`` lets each
        adapter apply its own default: 16000 for Anthropic, 1024 for
        OpenAI, Gemini and Ollama.
    system:
        Optional system prompt.
    metadata:
        Free-form key/value pairs forwarded as the provider's
        ``metadata`` field where supported.
    extra:
        Vendor-specific knobs the caller wants passed straight through
        (e.g. ``temperature``, ``stop_sequences``).
    """

    max_tokens: int | None = None
    system: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ModelUsage:
    """The tokens one model used in a run (KTD9).

    ``input_tokens`` counts fresh input plus cache writes; cache reads are
    not counted.
    """

    model: str
    input_tokens: int
    output_tokens: int


@dataclass(slots=True)
class DispatchResult:
    """Normalized adapter response.

    Both providers' SDKs return rich domain objects; we keep them in
    ``raw`` for advanced callers but expose a flattened ``text`` field
    so simple agent code doesn't have to know each SDK's shape.
    """

    text: str
    model: str
    provider: str
    raw: Any = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    batch_id: str | None = None
    stop_reason: str | None = None
    """Why the model stopped, as the provider reported it (Anthropic
    ``stop_reason``: ``"end_turn"``, ``"max_tokens"``, ...). ``"max_tokens"``
    means ``text`` is truncated. ``None`` when the provider reports none."""


class ProviderRefusalError(RuntimeError):
    """The provider declined the request (Anthropic ``stop_reason:
    "refusal"``).

    The call returned HTTP 200, but its content is not an answer, so it
    must not be recorded as a completed task. Carries no HTTP status, so
    the scheduler does not retry it.
    """

    def __init__(self, provider: str, model: str, category: str | None) -> None:
        message = f"{provider} refused the request for {model}"
        if category:
            message += f" (category: {category})"
        super().__init__(message)
        self.provider = provider
        self.model = model
        #: Refusal category from ``stop_details.category`` (``"cyber"``,
        #: ``"bio"``, ...), or ``None``.
        self.category = category


@dataclass(slots=True)
class BatchHandle:
    """Receipt for an enqueued batch.

    Batch APIs return *eventually* (24h SLA at both Anthropic and
    OpenAI), so the dispatch call yields a handle the scheduler can
    poll. The scheduler routes deadline > 24h tasks here automatically
    (status ``"submitted"``), then polls :meth:`ProviderAdapter.retrieve_batch`
    from ``tick()`` until results land (status ``"completed"``).
    """

    batch_id: str
    provider: str
    model: str
    prompt_count: int
    raw: Any = None


@dataclass(slots=True)
class BatchResultItem:
    """One per-request result parsed out of a completed batch."""

    text: str
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    stop_reason: str | None = None
    """Provider stop reason for this request; ``"max_tokens"`` means truncated."""


@dataclass(slots=True)
class BatchRetrieveResult:
    """Result of polling a submitted batch via
    :meth:`ProviderAdapter.retrieve_batch`.

    The scheduler only ever submits single-prompt batches, so ``results``
    carries at most one entry; the scheduler takes ``results[0]``.
    """

    status: str
    """One of ``"in_progress"`` | ``"completed"`` | ``"failed"`` |
    ``"expired"``."""
    results: list[BatchResultItem] | None = None
    """Per-request results, present when ``status == "completed"``."""
    error: str | None = None
    """Human-readable error when ``status`` is ``"failed"`` / ``"expired"``."""


class ProviderAdapter(ABC):
    """Common adapter surface for LLM vendors."""

    #: Stable string identifier for the provider, used in carbon
    #: receipts (``receipt.provider``). Must be lowercase.
    name: str

    @abstractmethod
    async def dispatch(
        self,
        model: str,
        prompt: str,
        options: DispatchOptions | None = None,
    ) -> DispatchResult:
        """Send a single prompt through the provider's sync API."""

    async def dispatch_batch(
        self,
        model: str,
        prompts: list[str],
        options: DispatchOptions | None = None,
    ) -> BatchHandle:
        """Submit a batch of prompts to the provider's batch API.

        Optional: a provider whose Batch API does not map cleanly onto this
        submit → poll → results contract (Gemini) or that has no batch API at
        all (local Ollama) leaves this — and :meth:`retrieve_batch` — as the
        base stubs, which raise. The scheduler feature-detects a real
        ``retrieve_batch`` override before routing a task through the batch
        path (:func:`tidegap.scheduler._has_batch_support`), so a sync-only
        adapter is never asked to batch.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not implement dispatch_batch"
        )

    async def retrieve_batch(self, batch_id: str) -> BatchRetrieveResult:
        """Poll a submitted batch by id.

        Returns the batch's current status and, when completed, the
        parsed per-request results (text + usage). The scheduler calls
        this from ``tick()`` on every ``submitted`` task until it observes
        a terminal status. Base implementation raises
        :class:`NotImplementedError`; the scheduler feature-detects a real
        override before routing a task through the batch path.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not implement retrieve_batch"
        )


__all__ = [
    "DEFAULT_MAX_TOKENS",
    "BatchHandle",
    "BatchResultItem",
    "BatchRetrieveResult",
    "DispatchOptions",
    "DispatchResult",
    "ModelUsage",
    "ProviderAdapter",
    "ProviderRefusalError",
]
