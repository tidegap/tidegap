"""Batch API routing tests (audit §0.1 + P1), through PUBLIC paths only.

The audit flagged that the Batch API was previously unreachable from any
public entry point and only ever exercised by hand-forging unreachable
states. These tests drive the real ``enqueue_provider_call`` → ``tick``
submit → ``tick`` poll → complete flow with a fake batch-capable adapter.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tidegap import Scheduler, mock_grid_feed
from tidegap.providers.base import (
    BatchHandle,
    BatchResultItem,
    BatchRetrieveResult,
    DispatchOptions,
    DispatchResult,
    ProviderAdapter,
)
from tidegap.scheduler import _TaskStore
from tidegap.types import DeferOptions, ProviderCallSpec

pytestmark = pytest.mark.asyncio


class BatchAdapter(ProviderAdapter):
    """Fake adapter with the full batch surface (dispatch + dispatch_batch
    + retrieve_batch). ``retrieve_status`` scripts what the next poll
    returns; ``retrieve_usage`` controls the completed usage tokens.
    """

    name = "anthropic"

    def __init__(self, name: str = "anthropic") -> None:
        self.name = name
        self.dispatch_calls: list[tuple[str, str]] = []
        self.batch_calls: list[tuple[str, list[str]]] = []
        self.retrieve_calls: list[str] = []
        # A queue of statuses to return on successive retrieve_batch calls.
        self.retrieve_sequence: list[str] = ["completed"]
        self.retrieve_usage = (10, 5)
        self.completed_text = "batch-result"
        self.completed_stop_reason: str | None = None

    async def dispatch(
        self,
        model: str,
        prompt: str,
        options: DispatchOptions | None = None,
    ) -> DispatchResult:
        self.dispatch_calls.append((model, prompt))
        return DispatchResult(
            text=f"sync:{prompt}",
            model=model,
            provider=self.name,
            input_tokens=3,
            output_tokens=2,
        )

    async def dispatch_batch(
        self,
        model: str,
        prompts: list[str],
        options: DispatchOptions | None = None,
    ) -> BatchHandle:
        self.batch_calls.append((model, prompts))
        return BatchHandle(
            batch_id="batch-xyz",
            provider=self.name,
            model=model,
            prompt_count=len(prompts),
        )

    async def retrieve_batch(self, batch_id: str) -> BatchRetrieveResult:
        self.retrieve_calls.append(batch_id)
        status = (
            self.retrieve_sequence.pop(0)
            if self.retrieve_sequence
            else "completed"
        )
        if status == "in_progress":
            return BatchRetrieveResult(status="in_progress")
        if status in ("failed", "expired"):
            return BatchRetrieveResult(status=status, error=f"batch {status}")
        inp, out = self.retrieve_usage
        return BatchRetrieveResult(
            status="completed",
            results=[
                BatchResultItem(
                    text=self.completed_text,
                    model="m",
                    input_tokens=inp,
                    output_tokens=out,
                    total_tokens=inp + out,
                    stop_reason=self.completed_stop_reason,
                )
            ],
        )


class SyncOnlyAdapter(ProviderAdapter):
    """Adapter with no batch support (only the sync surface)."""

    name = "anthropic"

    def __init__(self) -> None:
        self.dispatch_calls: list[tuple[str, str]] = []

    async def dispatch(
        self,
        model: str,
        prompt: str,
        options: DispatchOptions | None = None,
    ) -> DispatchResult:
        self.dispatch_calls.append((model, prompt))
        return DispatchResult(text="sync", model=model, provider=self.name)

    async def dispatch_batch(
        self,
        model: str,
        prompts: list[str],
        options: DispatchOptions | None = None,
    ) -> BatchHandle:
        raise NotImplementedError

    # No retrieve_batch override → _has_batch_support returns False.


def _deadline(hours: float) -> str:
    return (datetime.now(UTC) + timedelta(hours=hours)).isoformat()


async def test_batch_submit_poll_complete_lifecycle() -> None:
    """60h deadline, preferBatch default, full adapter → three ticks:
    submit → in_progress → completed with real usage {10,5}."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hello")
        await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:1")
        )
        adapter = BatchAdapter()
        adapter.retrieve_sequence = ["in_progress", "completed"]

        # Tick 1: submit.
        r1 = await s.tick({"anthropic": adapter})
        assert r1.batch_submitted == 1
        assert len(adapter.batch_calls) == 1
        assert len(adapter.dispatch_calls) == 0
        rec = s.get_task("bt:1")
        assert rec.status == "submitted"
        assert rec.batch_id == "batch-xyz"

        # Tick 2: retrieve → in_progress, stays submitted.
        r2 = await s.tick({"anthropic": adapter})
        assert r2.batch_polled == 1
        assert r2.dispatched == 0
        assert s.get_task("bt:1").status == "submitted"

        # Tick 3: retrieve → completed with usage {10,5}.
        r3 = await s.tick({"anthropic": adapter})
        assert r3.dispatched == 1
        rec = s.get_task("bt:1")
        assert rec.status == "completed"
        assert rec.receipt is not None
        assert rec.receipt.total_tokens == 15
        assert rec.receipt.intensity_g_co2_per_kwh is not None
        assert rec.receipt.grid_source is not None
        assert rec.receipt.energy_source is not None
        assert rec.result is not None
        assert rec.result.get("text") == "batch-result"


async def test_batch_result_cut_off_by_max_tokens_keeps_stop_reason() -> None:
    """R10: a truncated batch answer is stored with its stop_reason."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="long")
        await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:maxtok")
        )
        adapter = BatchAdapter()
        adapter.completed_stop_reason = "max_tokens"
        await s.tick({"anthropic": adapter})  # submit
        await s.tick({"anthropic": adapter})  # retrieve → completed
        rec = s.get_task("bt:maxtok")
        assert rec.status == "completed"
        assert rec.result is not None
        assert rec.result.get("stop_reason") == "max_tokens"


async def test_short_deadline_uses_sync_path() -> None:
    """3h deadline → sync path, dispatch_batch never called."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        rec = await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(3), task_id="bt:short")
        )
        rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s._tasks[rec.task_id] = rec  # type: ignore[index]
        adapter = BatchAdapter()
        result = await s.tick({"anthropic": adapter})
        assert result.batch_submitted == 0
        assert len(adapter.batch_calls) == 0
        assert len(adapter.dispatch_calls) == 1
        assert s.get_task("bt:short").status == "completed"


async def test_prefer_batch_false_uses_sync_at_window() -> None:
    """prefer_batch=False + 60h → sync at the scheduled window (a tick
    before the window does nothing)."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(
            provider="anthropic", model="m", prompt="hi", prefer_batch=False
        )
        rec = await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:nobatch")
        )
        adapter = BatchAdapter()
        # Force the window into the future — nothing should happen.
        rec.scheduled_for = (datetime.now(UTC) + timedelta(hours=10)).isoformat()
        s._tasks[rec.task_id] = rec  # type: ignore[index]
        r1 = await s.tick({"anthropic": adapter})
        assert r1.batch_submitted == 0
        assert r1.inspected == 0
        assert len(adapter.batch_calls) == 0
        assert len(adapter.dispatch_calls) == 0

        # Move the window to now → sync dispatch.
        rec = s.get_task("bt:nobatch")
        rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s._tasks[rec.task_id] = rec  # type: ignore[index]
        r2 = await s.tick({"anthropic": adapter})
        assert r2.dispatched == 1
        assert len(adapter.batch_calls) == 0
        assert len(adapter.dispatch_calls) == 1


async def test_adapter_without_batch_falls_back_to_sync() -> None:
    """A 60h deadline but an adapter without batch support → sync path."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        rec = await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:syncadp")
        )
        # Window due so the sync sweep runs it.
        rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        s._tasks[rec.task_id] = rec  # type: ignore[index]
        adapter = SyncOnlyAdapter()
        result = await s.tick({"anthropic": adapter})
        assert result.batch_submitted == 0
        assert len(adapter.dispatch_calls) == 1
        assert s.get_task("bt:syncadp").status == "completed"


async def test_batch_failed_then_retry_dispatches_sync() -> None:
    """retrieve → failed → task failed; retry_task re-dispatches sync
    successfully and clears batch_id."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:fail")
        )
        adapter = BatchAdapter()
        adapter.retrieve_sequence = ["failed"]

        await s.tick({"anthropic": adapter})  # submit
        assert s.get_task("bt:fail").status == "submitted"
        r2 = await s.tick({"anthropic": adapter})  # poll → failed
        assert r2.failed == 1
        rec = s.get_task("bt:fail")
        assert rec.status == "failed"

        # retry_task re-dispatches synchronously.
        rec = await s.retry_task("bt:fail", {"anthropic": adapter})
        assert rec.status == "completed"
        assert rec.batch_id is None
        assert len(adapter.dispatch_calls) == 1


async def test_expedite_on_submitted_raises() -> None:
    """expedite on a submitted task → clear error mentioning the batch id."""
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:exp")
        )
        adapter = BatchAdapter()
        adapter.retrieve_sequence = ["in_progress"]
        await s.tick({"anthropic": adapter})  # submit
        assert s.get_task("bt:exp").status == "submitted"
        with pytest.raises(RuntimeError, match="already submitted"):
            await s.expedite_task("bt:exp", {"anthropic": adapter})


async def test_racing_ticks_complete_submitted_row_once(tmp_path: Path) -> None:
    """Two schedulers on the same DB polling the same submitted row →
    exactly one completion (claim test)."""
    db = str(tmp_path / "queue.db")
    async with Scheduler(feed=mock_grid_feed(), db_path=db) as s1:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s1.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:race")
        )
        adapter = BatchAdapter()
        await s1.tick({"anthropic": adapter})  # submit
        assert s1.get_task("bt:race").status == "submitted"

    # Two fresh schedulers on the same DB race the poll.
    async with Scheduler(feed=mock_grid_feed(), db_path=db) as sa, Scheduler(
        feed=mock_grid_feed(), db_path=db
    ) as sb:
        adapter_a = BatchAdapter()
        adapter_b = BatchAdapter()
        ra, rb = await sa.tick({"anthropic": adapter_a}), None
        rb = await sb.tick({"anthropic": adapter_b})
        # Exactly one scheduler completed the row.
        completions = ra.dispatched + rb.dispatched
        assert completions == 1


async def test_cross_language_ts_submitted_row_completed_by_py(
    tmp_path: Path,
) -> None:
    """A row written by the TS port's schema (status=submitted, batch_id set)
    round-trips through PY ``_row_to_record`` and is completed by a PY tick.

    We reproduce the exact TS column layout (packages/core-ts/src/storage/
    sqlite.ts) with a raw sqlite3 write — a verified equivalent of what
    ``@tidegap/core`` writes to a shared ``queue.db`` — then read + poll it
    with the Python scheduler.
    """
    db = str(tmp_path / "queue.db")
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE tasks (
          task_id           TEXT PRIMARY KEY,
          status            TEXT NOT NULL,
          enqueued_at       TEXT NOT NULL,
          scheduled_for     TEXT,
          completed_at      TEXT,
          region            TEXT NOT NULL,
          carbon_budget_g   REAL,
          result_json       TEXT,
          error             TEXT,
          receipt_json      TEXT,
          intensity_source  TEXT,
          body_json         TEXT,
          estimated_carbon_g REAL,
          deadline          TEXT,
          batch_id          TEXT
        );
        """
    )
    body = (
        '{"type":"provider_call","provider":"anthropic",'
        '"model":"m","prompt":"hello"}'
    )
    dl = (datetime.now(UTC) + timedelta(hours=60)).isoformat()
    conn.execute(
        "INSERT INTO tasks (task_id, status, enqueued_at, region, body_json, "
        "deadline, batch_id) VALUES (?,?,?,?,?,?,?)",
        ("xl-ts", "submitted", dl, "US-CAL-CISO", body, dl, "ts-batch-1"),
    )
    conn.commit()
    conn.close()

    async with Scheduler(feed=mock_grid_feed(), db_path=db) as s:
        rec = await s.load_persisted_task("xl-ts")
        assert rec is not None
        assert rec.status == "submitted"
        assert rec.batch_id == "ts-batch-1"
        adapter = BatchAdapter()
        adapter.completed_text = "done-by-py"
        result = await s.tick({"anthropic": adapter})
        assert result.dispatched == 1
        done = await s.load_persisted_task("xl-ts")
        assert done.status == "completed"
        assert done.receipt.total_tokens == 15
        assert done.result.get("text") == "done-by-py"


async def test_legacy_row_without_deadline_skips_batch(tmp_path: Path) -> None:
    """A row with a persisted status=scheduled + body_json but NULL
    deadline (legacy) is not batch-routed; it takes the sync due path."""
    db = str(tmp_path / "queue.db")
    async with Scheduler(feed=mock_grid_feed(), db_path=db) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:legacy")
        )
        # Simulate a legacy row: clear the deadline column + set a due window.
        due = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
        conn = sqlite3.connect(db)
        conn.execute(
            "UPDATE tasks SET deadline = NULL, scheduled_for = ? "
            "WHERE task_id = ?",
            (due, "bt:legacy"),
        )
        conn.commit()
        conn.close()
        # Drop the in-memory copy so tick re-hydrates from the DB.
        s._tasks.clear()  # type: ignore[attr-defined]

        adapter = BatchAdapter()
        result = await s.tick({"anthropic": adapter})
        assert result.batch_submitted == 0
        assert len(adapter.batch_calls) == 0
        assert len(adapter.dispatch_calls) == 1
        assert (await s.load_persisted_task("bt:legacy")).status == "completed"


# The error a Node forced stop writes on a row whose Batch submit was in
# flight, and one row failed with it. Shared with the TS suite.
INTERRUPTED_SUBMIT_FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "core-ts"
        / "test"
        / "fixtures"
        / "interrupted-batch-submit.json"
    ).read_text(encoding="utf-8")
)


@pytest.mark.parametrize("job_id", [None, "job-0000001a"])
async def test_retry_task_refuses_a_row_stopped_during_a_batch_submit(
    tmp_path: Path, job_id: str | None
) -> None:
    """The provider may hold a batch for the row: retry_task refuses it with
    the Batch-submit reason, before the job-run refusal, and runs nothing."""
    db = tmp_path / "queue.db"
    store = _TaskStore(str(db))
    await store.connect()
    await store.close()
    row = {**INTERRUPTED_SUBMIT_FIXTURE["row"], "job_id": job_id}
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.execute(
            f"INSERT INTO tasks ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
            tuple(row.values()),
        )
    adapter = BatchAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        with pytest.raises(RuntimeError) as err:
            await s.retry_task(row["task_id"], {"anthropic": adapter})
        record = await s.load_persisted_task(row["task_id"])
    assert "check the provider's batch list" in str(err.value)
    assert "jobs run" not in str(err.value)
    assert adapter.dispatch_calls == []
    assert adapter.batch_calls == []
    assert record is not None
    assert record.status == "failed"
    assert record.error == INTERRUPTED_SUBMIT_FIXTURE["error"]


async def test_expedite_and_retry_check_the_ledger_row_not_a_cached_copy(
    tmp_path: Path,
) -> None:
    """This process enqueued the row, then the Node daemon failed it during a
    Batch submit. expedite_task and retry_task check the ledger row, not the
    cached ``scheduled`` copy, so neither runs it again."""
    db = tmp_path / "queue.db"
    adapter = BatchAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_deadline(60), task_id="bt:stale")
        )
        assert s.get_task("bt:stale").status == "scheduled"
        with contextlib.closing(sqlite3.connect(db)) as conn, conn:
            conn.execute(
                "UPDATE tasks SET status = 'failed', error = ? WHERE task_id = ?",
                (INTERRUPTED_SUBMIT_FIXTURE["error"], "bt:stale"),
            )
        with pytest.raises(RuntimeError, match="'failed'"):
            await s.expedite_task("bt:stale", {"anthropic": adapter})
        with pytest.raises(RuntimeError, match="check the provider's batch list"):
            await s.retry_task("bt:stale", {"anthropic": adapter})
        record = await s.load_persisted_task("bt:stale")
    assert adapter.dispatch_calls == []
    assert adapter.batch_calls == []
    assert record is not None
    assert record.status == "failed"
    assert record.error == INTERRUPTED_SUBMIT_FIXTURE["error"]
