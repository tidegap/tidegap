"""A stranded Batch poll is polled again (batch 27 U8, AE6).

A tick killed during a Batch poll leaves a plain row ``running`` with its
batch id. The next tick sends it back to ``submitted`` at the head of the
Batch-poll sweep once its deadline plus a 5-minute grace has passed, and
polls it in that sweep. The shared fixture
``packages/core-ts/test/fixtures/stranded-batch-polls.json`` holds the grace,
the clock and the rows; ``packages/core-ts/test/stranded-batch-polls.test.ts``
runs the Node core on the same file. The clock is injected: no sleeps.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

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
from tidegap.scheduler import _STRANDED_POLL_GRACE
from tidegap.types import ProviderCallSpec

FIXTURE: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "core-ts"
        / "test"
        / "fixtures"
        / "stranded-batch-polls.json"
    ).read_text()
)
NOW = datetime.fromisoformat(FIXTURE["now"].replace("Z", "+00:00"))
ROWS: list[dict[str, Any]] = FIXTURE["rows"]
PAST = next(row for row in ROWS if row["after"] == "completed")
BODY = json.dumps(ProviderCallSpec(provider="anthropic", model="m", prompt="hi").to_dict())


@pytest.fixture
def fixed_now(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tidegap.scheduler._now_utc", lambda: NOW)


def _insert(db: Path, row: dict[str, Any], status: str = "running") -> None:
    """A Batch row submitted two days before ``NOW``."""
    enqueued = (NOW - timedelta(days=2)).isoformat()
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.execute(
            "INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, region, "
            "body_json, deadline, batch_id, job_id, deadline_kind) "
            "VALUES (?, ?, ?, ?, 'DE', ?, ?, ?, ?, 'absolute')",
            (
                row["task_id"],
                status,
                enqueued,
                enqueued,
                BODY,
                row["deadline"],
                row["batch_id"],
                row["job_id"],
            ),
        )


def _events(db: Path, task_id: str) -> list[str]:
    with contextlib.closing(sqlite3.connect(db)) as conn:
        rows = conn.execute(
            "SELECT kind FROM task_events WHERE task_id = ? ORDER BY id", (task_id,)
        ).fetchall()
    return [r[0] for r in rows]


class PollAdapter(ProviderAdapter):
    """A Batch adapter whose poll returns the result ``text``. With a
    ``gate``, each poll waits until the gate opens."""

    name = "anthropic"

    def __init__(self, text: str, gate: asyncio.Event | None = None) -> None:
        self.polled: list[str] = []
        self.started = asyncio.Event()
        self._text = text
        self._gate = gate

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        raise AssertionError("a stranded poll makes no sync call")

    async def dispatch_batch(
        self, model: str, prompts: list[str], options: DispatchOptions | None = None
    ) -> BatchHandle:
        raise AssertionError("a stranded poll submits no batch")

    async def retrieve_batch(self, batch_id: str) -> BatchRetrieveResult:
        self.polled.append(batch_id)
        self.started.set()
        if self._gate is not None:
            await self._gate.wait()
        return BatchRetrieveResult(
            status="completed",
            results=[
                BatchResultItem(
                    text=self._text, model="m", input_tokens=10, output_tokens=5, total_tokens=15
                )
            ],
        )


def test_the_grace_matches_the_shared_fixture() -> None:
    assert timedelta(milliseconds=FIXTURE["grace_ms"]) == _STRANDED_POLL_GRACE


async def test_one_tick_frees_and_polls_only_a_plain_row_past_its_deadline_and_grace(
    tmp_path: Path, fixed_now: None
) -> None:
    db = tmp_path / "queue.db"
    adapter = PollAdapter("polled")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        for row in ROWS:
            _insert(db, row)
        result = await s.tick({"anthropic": adapter})
        after = {}
        for row in ROWS:
            record = await s.load_persisted_task(row["task_id"])
            assert record is not None
            after[row["task_id"]] = record
    assert {k: r.status for k, r in after.items()} == {row["task_id"]: row["after"] for row in ROWS}
    assert adapter.polled == FIXTURE["polled"]
    assert [(e.task_id, e.status) for e in result.results] == [(PAST["task_id"], "completed")]
    done = after[PAST["task_id"]]
    assert done.receipt is not None and done.batch_id == PAST["batch_id"]
    assert _events(db, PAST["task_id"]) == ["completed"]


async def test_a_row_this_scheduler_is_polling_is_not_freed(tmp_path: Path, fixed_now: None) -> None:
    db = tmp_path / "queue.db"
    gate = asyncio.Event()
    adapter = PollAdapter("polled", gate)
    other = PollAdapter("second")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, PAST, status="submitted")
        first = asyncio.create_task(s.tick({"anthropic": adapter}))
        await asyncio.wait_for(adapter.started.wait(), timeout=5)
        # A second tick of the same scheduler while the first polls the row.
        second = await s.tick({"anthropic": other})
        during = await s.load_persisted_task(PAST["task_id"])
        gate.set()
        await asyncio.wait_for(first, timeout=5)
        done = await s.load_persisted_task(PAST["task_id"])
    assert second.results == []
    assert other.polled == []
    assert during is not None and during.status == "running"
    assert adapter.polled == [PAST["batch_id"]]
    assert done is not None and done.status == "completed"


async def test_two_pollers_on_a_freed_row_land_one_completion(
    tmp_path: Path, fixed_now: None
) -> None:
    """Another process still polls a row past its deadline: this tick frees
    and completes it; the other poll's late result is dropped."""
    db = tmp_path / "queue.db"
    gate = asyncio.Event()
    late = PollAdapter("late", gate)
    first = PollAdapter("first")
    async with (
        Scheduler(feed=mock_grid_feed(), db_path=str(db)) as other,
        Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s,
    ):
        _insert(db, PAST, status="submitted")
        other_tick = asyncio.create_task(other.tick({"anthropic": late}))
        await asyncio.wait_for(late.started.wait(), timeout=5)
        result = await s.tick({"anthropic": first})
        gate.set()
        other_result = await asyncio.wait_for(other_tick, timeout=5)
        row = await s.load_persisted_task(PAST["task_id"])
    assert [e.status for e in result.results] == ["completed"]
    assert [e.status for e in other_result.results] == ["failed"]
    assert "result dropped" in (other_result.results[0].error or "")
    assert row is not None and row.status == "completed"
    assert row.result["text"] == "first"
    assert _events(db, PAST["task_id"]) == ["completed"]


async def test_a_free_whose_write_fails_leaves_the_cached_row_running(
    tmp_path: Path, fixed_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = tmp_path / "queue.db"
    adapter = PollAdapter("polled")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, PAST)
        assert s._store is not None

        async def busy(*_args: Any, **_kwargs: Any) -> bool:
            raise sqlite3.OperationalError("database is locked")

        monkeypatch.setattr(s._store, "transition_if", busy)
        result = await s.tick({"anthropic": adapter})
        cached = s.get_task(PAST["task_id"])
        row = await s.load_persisted_task(PAST["task_id"])
    assert result.results == []
    assert adapter.polled == []
    assert cached is not None and cached.status == "running"
    assert row is not None and row.status == "running"
