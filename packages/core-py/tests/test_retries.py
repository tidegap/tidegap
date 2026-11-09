"""The retry funnel of the Python tick (the TS ``failRun``): a failed run of
a row this core dispatches is queued again by the retry policy with an
``attempt_failed`` event, or fails for good after the last attempt; the
attempt count is read from the events both cores write.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

import tidegap.scheduler as scheduler_mod
from tidegap import DeferOptions, ProviderCallSpec, Scheduler, mock_grid_feed
from tidegap.errors import PermanentProviderError, http_error
from tidegap.providers.base import (
    BatchHandle,
    BatchRetrieveResult,
    DispatchOptions,
    DispatchResult,
    ProviderAdapter,
)

pytestmark = pytest.mark.asyncio


class _Status(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


class _Adapter(ProviderAdapter):
    """Raises ``errors`` in turn, then answers."""

    name = "anthropic"

    def __init__(self, errors: list[Exception]) -> None:
        self.errors = list(errors)
        self.calls = 0

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return DispatchResult(text="ok", model=model, provider="anthropic", input_tokens=1, output_tokens=1)


def _events(db: Path, task_id: str) -> list[tuple[str, dict[str, object]]]:
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        rows = conn.execute(
            "SELECT kind, details FROM task_events WHERE task_id = ? ORDER BY id", (task_id,)
        ).fetchall()
    return [(k, json.loads(d)) for k, d in rows]


def _row(db: Path, task_id: str) -> dict[str, object]:
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    return dict(row)


async def _due(s: Scheduler, db: Path, task_id: str) -> None:
    """Make the row due now, as a run now does."""
    now = datetime.now(UTC)
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.execute(
            "UPDATE tasks SET scheduled_for = ?, not_before = NULL WHERE task_id = ?",
            ((now - timedelta(seconds=1)).isoformat(), task_id),
        )
    rec = await s.load_persisted_task(task_id)
    assert rec is not None
    s._tasks[task_id] = rec  # type: ignore[index]


async def _queue(s: Scheduler, db: Path, task_id: str, hours: float = 6) -> None:
    spec = ProviderCallSpec(provider="anthropic", model="m", prompt="p")
    deadline = (datetime.now(UTC) + timedelta(hours=hours)).isoformat()
    await s.enqueue_provider_call(spec, DeferOptions(deadline=deadline, task_id=task_id))
    await _due(s, db, task_id)


@pytest.fixture(autouse=True)
def _no_in_call_waits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler_mod, "_RETRY_WAITS_S", (0.0, 0.0, 0.0))


async def test_a_503_after_the_in_call_resends_queues_the_next_attempt(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await _queue(s, db, "r:503")
        adapter = _Adapter([_Status(503)] * 4)
        before = datetime.now(UTC)
        result = await s.tick({"anthropic": adapter})
        after = datetime.now(UTC)
    assert adapter.calls == 4
    assert (result.failed, result.retrying) == (0, 1)
    entry = result.results[0]
    assert entry.status == "retrying" and entry.retry_at is not None
    row = _row(db, "r:503")
    assert row["status"] == "scheduled" and row["error"] is None and row["completed_at"] is None
    # The same start the Node core plans: the failure plus the 30 minute default delay.
    not_before = datetime.fromisoformat(str(row["not_before"]))
    assert before + timedelta(minutes=30) - timedelta(seconds=1) <= not_before <= after + timedelta(minutes=30)
    assert row["not_before"] == entry.retry_at
    kinds = [k for k, _ in _events(db, "r:503")]
    assert kinds[-1] == "attempt_failed" and "failed" not in kinds
    details = _events(db, "r:503")[-1][1]
    assert details["attempt"] == 1 and details["failure_class"] == "transient"
    assert details["retry_at"] == entry.retry_at and details["error"] == "HTTP 503"


async def test_a_row_the_node_core_queued_again_counts_as_attempt_2_and_fails_for_good(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await _queue(s, db, "r:node")
        # The Node tick ran attempt 1 and queued attempt 2.
        with contextlib.closing(sqlite3.connect(db)) as conn, conn:
            conn.execute(
                "INSERT INTO task_events (task_id, at, kind, actor, details) VALUES (?, ?, 'attempt_failed', 'tick', ?)",
                ("r:node", datetime.now(UTC).isoformat(), json.dumps({"attempt": 1, "failure_class": "transient"})),
            )
        await s.tick({"anthropic": _Adapter([RuntimeError("down again")])})
    row = _row(db, "r:node")
    assert row["status"] == "failed"
    assert row["error"] == "down again (after 2 attempts)"
    failed = [d for k, d in _events(db, "r:node") if k == "failed"]
    assert failed[0]["attempts"] == 2 and failed[0]["failure_class"] == "transient"


async def test_a_401_and_missing_setup_fail_at_once(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await _queue(s, db, "r:401")
        await _queue(s, db, "r:key")
        await s.tick({"anthropic": _Adapter([_Status(401), PermanentProviderError("no API key")])})
    for task_id in ("r:401", "r:key"):
        assert _row(db, task_id)["status"] == "failed"
        failed = [d for k, d in _events(db, task_id) if k == "failed"]
        assert failed[0]["failure_class"] == "permanent" and failed[0]["attempts"] == 1


async def test_no_time_left_before_the_deadline_is_final(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await _queue(s, db, "r:late", hours=0.25)
        await s.tick({"anthropic": _Adapter([RuntimeError("busy")])})
    assert _row(db, "r:late")["error"] == "busy (no time left before the deadline for a retry)"


async def test_retry_task_starts_a_new_count_and_refuses_command_and_claude_code_rows(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await _queue(s, db, "r:manual", hours=0.25)
        await s.tick({"anthropic": _Adapter([RuntimeError("busy")])})
        await s.retry_task("r:manual", {"anthropic": _Adapter([])})
        assert [k for k, _ in _events(db, "r:manual")].count("rescheduled") == 1
        assert _row(db, "r:manual")["status"] == "completed"
        for provider, task_id in (("command", "r:cmd"), ("claude-code", "r:cc")):
            body = json.dumps({"type": "provider_call", "provider": provider, "model": "m", "prompt": "p"})
            with contextlib.closing(sqlite3.connect(db)) as conn, conn:
                conn.execute(
                    "INSERT INTO tasks (task_id, status, enqueued_at, region, body_json, error) "
                    "VALUES (?, 'failed', ?, 'DE', ?, 'boom')",
                    (task_id, datetime.now(UTC).isoformat(), body),
                )
            with pytest.raises(RuntimeError, match=f"tidegap queue retry {task_id}"):
                await s.retry_task(task_id, {})


class _BatchAdapter(_Adapter):
    """An adapter with a Batch API whose submit raises ``errors`` in turn."""

    def __init__(self, errors: list[Exception]) -> None:
        super().__init__([])
        self.submit_errors = list(errors)
        self.submits = 0

    async def dispatch_batch(
        self, model: str, prompts: list[str], options: DispatchOptions | None = None
    ) -> BatchHandle:
        self.submits += 1
        if self.submit_errors:
            raise self.submit_errors.pop(0)
        return BatchHandle(batch_id="b1", provider="anthropic", model=model, prompt_count=len(prompts))

    async def retrieve_batch(self, batch_id: str) -> BatchRetrieveResult:
        return BatchRetrieveResult(status="in_progress")


async def test_a_failed_batch_submit_is_queued_again_and_waits_for_its_retry_delay(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        await _queue(s, db, "r:batch", hours=48)
        adapter = _BatchAdapter([_Status(503)] * 4)
        result = await s.tick({"anthropic": adapter})
        assert result.retrying == 1
        submits = adapter.submits
        row = _row(db, "r:batch")
        assert row["status"] == "scheduled" and row["batch_id"] is None and row["not_before"]
        assert [k for k, _ in _events(db, "r:batch")][-1] == "attempt_failed"
        # The next tick keeps it off the Batch API until its earliest start.
        await s.tick({"anthropic": adapter})
    assert adapter.submits == submits
    assert _row(db, "r:batch")["status"] == "scheduled"


async def test_a_task_cancelled_during_its_call_without_a_ledger_stays_cancelled(tmp_path: Path) -> None:
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="p")
        deadline = (datetime.now(UTC) + timedelta(hours=6)).isoformat()
        record = await s.enqueue_provider_call(spec, DeferOptions(deadline=deadline))

        class _CancelThenFail(_Adapter):
            async def dispatch(
                self, model: str, prompt: str, options: DispatchOptions | None = None
            ) -> DispatchResult:
                await s.cancel_task(record.task_id)
                raise RuntimeError("late")

        await s.expedite_task(record.task_id, {"anthropic": _CancelThenFail([])})
        assert s._tasks[record.task_id].status == "cancelled"  # type: ignore[index]


async def test_http_errors_a_retry_cannot_fix_are_permanent() -> None:
    for status in (400, 401, 404, 409, 422):
        assert getattr(http_error("x", status), "permanent", False) is True
    for status in (408, 425, 429, 500, 503):
        assert getattr(http_error("x", status), "permanent", False) is False


async def test_the_anthropic_adapter_without_a_key_fails_as_missing_setup(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("anthropic")
    from tidegap.providers.anthropic import AnthropicAdapter

    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    with pytest.raises(PermanentProviderError, match="no API key"):
        await AnthropicAdapter().dispatch("claude-x", "hi")
    with pytest.raises(PermanentProviderError, match="no API key"):
        await AnthropicAdapter().dispatch_batch("claude-x", ["hi"])
