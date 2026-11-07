"""Typed errors raised by the scheduler.

Mirrors the TS errors in ``packages/core-ts/src/scheduler.ts`` so that
callers translating the JS examples have a 1:1 reference. Both carry
structured fields (``minimum_g_co2`` / ``budget_g_co2`` /
``received``) so callers can decide how to react without parsing the
message text.
"""

from __future__ import annotations

from typing import Any


class CarbonBudgetExceededError(Exception):
    """No candidate window meets the user-supplied carbon budget.

    Attributes
    ----------
    minimum_g_co2:
        Grams CO2e the cheapest reachable window would have emitted.
    budget_g_co2:
        Grams CO2e the caller specified as the cap.
    """

    minimum_g_co2: float
    budget_g_co2: float

    def __init__(self, minimum_g_co2: float, budget_g_co2: float) -> None:
        self.minimum_g_co2 = minimum_g_co2
        self.budget_g_co2 = budget_g_co2
        super().__init__(
            f"No window inside the deadline keeps the task under "
            f"{budget_g_co2:.1f} gCO2e. Cheapest reachable window costs "
            f"{minimum_g_co2:.1f} gCO2e."
        )


class TaskCancelledError(Exception):
    """A task was cancelled via :meth:`Scheduler.cancel_task`.

    Awaiters of :meth:`Scheduler.defer` receive this exception when the
    task is cancelled before (or while) it runs. It deliberately derives
    from :class:`Exception` — **not** :class:`asyncio.CancelledError` —
    because ``CancelledError`` is a ``BaseException`` that bypasses
    ``except Exception`` handlers, marks the *awaiting* task as cancelled,
    and unwinds ``asyncio.TaskGroup``\\ s. Cancelling a Tidegap task must
    not cancel the caller.

    Attributes
    ----------
    task_id:
        Identifier of the cancelled task.
    """

    task_id: str

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"task {task_id!r} cancelled")


class SchedulerShutdownError(Exception):
    """The scheduler shut down before a pending task could dispatch.

    Raised into every unresolved :meth:`Scheduler.defer` awaiter by
    :meth:`Scheduler.shutdown`, so ``async with Scheduler(...)`` can
    never deadlock a still-pending ``defer()``.

    Attributes
    ----------
    task_id:
        Identifier of the task whose awaiter was settled.
    """

    task_id: str

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(
            f"scheduler shut down before task {task_id!r} was dispatched"
        )


class InvalidDeadlineError(ValueError):
    """The supplied deadline could not be parsed or is already in the past.

    Inherits from :class:`ValueError` so callers using a broad
    ``except ValueError`` continue to work.

    Attributes
    ----------
    received:
        Original value the caller passed.
    """

    received: Any

    def __init__(self, received: Any) -> None:
        self.received = received
        super().__init__(
            "Invalid deadline: expected an ISO-8601 timestamp in the future, "
            f"received {received!r}"
        )


__all__ = [
    "CarbonBudgetExceededError",
    "InvalidDeadlineError",
    "SchedulerShutdownError",
    "TaskCancelledError",
]


class PermanentProviderError(RuntimeError):
    """A failure a retry of the task cannot fix: missing setup (no API key,
    no SDK) or a request the provider rejects (a 4xx answer other than 429).

    The retry policy reads ``permanent`` and fails the task at once instead
    of queuing another attempt (the TS ``permanentError``).
    """

    permanent = True


def http_error(message: str, status: int) -> RuntimeError:
    """The error of an HTTP answer that is not OK, for an adapter that calls
    the API itself: a 4xx other than 429 is permanent; anything else is a
    plain error, which the retry policy reads as transient. No status rides
    on it, so the call is not resent at once."""
    if 400 <= status < 500 and status != 429:
        return PermanentProviderError(message)
    return RuntimeError(message)
