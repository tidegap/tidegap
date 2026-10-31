"""Compare-and-set task writes in the Python core (batch 27 U6, U7).

Every Python write to an existing ledger row is compare-and-set on the
statuses its Node twin accepts. One shared fixture,
``packages/core-ts/test/fixtures/task-transition-guards.json``, lists them;
``packages/core-ts/test/task-transition-guards.test.ts`` drives the Node
twins with the same file.

A race test has two writers on one ledger: "another process" writes the row
between this scheduler's read and its write, through its own connection.
The stale write must miss, so the row keeps what the other process stored.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tidegap import Scheduler, mock_grid_feed
from tidegap.providers.base import DispatchOptions, DispatchResult, ProviderAdapter
from tidegap.scheduler import _PENDING_STATUSES, _UNFINISHED_STATUSES, _TaskStore
from tidegap.types import CarbonReceipt, ProviderCallSpec, TaskRecord

FIXTURE: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "core-ts"
        / "test"
        / "fixtures"
        / "task-transition-guards.json"
    ).read_text()
)
STATUSES: list[str] = FIXTURE["statuses"]
ACTIONS: dict[str, dict[str, Any]] = FIXTURE["actions"]
TASK = "tt:row"
BODY = json.dumps(ProviderCallSpec(provider="anthropic", model="m", prompt="hi").to_dict())


class RecordingAdapter(ProviderAdapter):
    """A sync adapter that records each call."""

    name = "anthropic"

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        self.calls.append(prompt)
        return DispatchResult(
            text="ours", model=model, provider=self.name, input_tokens=3, output_tokens=2
        )


def _iso(delta: timedelta = timedelta()) -> str:
    return (datetime.now(UTC) + delta).isoformat()


def _insert(db: Path, task_id: str, status: str) -> None:
    """A provider-call row in ``status``, due now, with a deadline 3 h out."""
    terminal = status in ("completed", "failed", "cancelled")
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.execute(
            "INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, completed_at, "
            "region, error, body_json, deadline, deadline_kind) "
            "VALUES (?, ?, ?, ?, ?, 'DE', ?, ?, ?, 'absolute')",
            (
                task_id,
                status,
                _iso(timedelta(minutes=-10)),
                _iso(timedelta(minutes=-1)),
                _iso(timedelta(minutes=-1)) if terminal else None,
                "boom" if status == "failed" else None,
                BODY,
                _iso(timedelta(hours=3)),
            ),
        )


def _events(db: Path, task_id: str) -> list[str]:
    with contextlib.closing(sqlite3.connect(db)) as conn:
        rows = conn.execute(
            "SELECT kind FROM task_events WHERE task_id = ? ORDER BY id", (task_id,)
        ).fetchall()
    return [row[0] for row in rows]


FIRST_RECEIPT = CarbonReceipt(
    task_id=TASK,
    ran_at="2026-11-02T10:00:00+00:00",
    region="DE",
    estimated_carbon_g_co2=1.5,
    actual_carbon_g_co2=1.25,
    delta_pct=-16.7,
)


async def _other_process_writes(db: Path, task_id: str, status: str) -> None:
    """Another process moves the row to ``status`` through its own connection,
    as the Node daemon would: a claim (``running``), a completion with its
    receipt (``completed``), or a retry (``scheduled``)."""
    async with _TaskStore(str(db)) as other:
        row = await other.load(task_id)
        assert row is not None
        row.status = status  # type: ignore[assignment]
        if status == "completed":
            row.completed_at = _iso()
            row.result = "theirs"
            row.receipt = FIRST_RECEIPT
        elif status == "scheduled":
            row.error = None
            row.completed_at = None
            row.scheduled_for = _iso()
        await other.upsert(row)


async def _act(s: Scheduler, action: str, adapter: RecordingAdapter) -> TaskRecord:
    adapters: dict[str, ProviderAdapter | None] = {"anthropic": adapter}
    if action == "cancel":
        return await s.cancel_task(TASK)
    if action == "expedite":
        return await s.expedite_task(TASK, adapters)
    if action == "update_deadline":
        return await s.update_deadline(TASK, _iso(timedelta(hours=5)))
    if action == "retry":
        return await s.retry_task(TASK, adapters)
    raise AssertionError(action)


def test_the_status_sets_match_the_shared_fixture() -> None:
    assert list(_PENDING_STATUSES) == FIXTURE["pending"]
    assert list(_UNFINISHED_STATUSES) == FIXTURE["unfinished"]
    assert {spec["python"] for spec in ACTIONS.values()} == {
        "cancel_task",
        "expedite_task",
        "update_deadline",
        "retry_task",
    }


@pytest.mark.parametrize(
    ("action", "status"), [(a, s) for a in ACTIONS for s in STATUSES]
)
async def test_each_action_writes_exactly_the_statuses_the_fixture_lists(
    tmp_path: Path, action: str, status: str
) -> None:
    """A fresh process (nothing cached) acts on a ledger row in ``status``."""
    db = tmp_path / "queue.db"
    adapter = RecordingAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, TASK, status)
        before = await s.load_persisted_task(TASK)
        try:
            await _act(s, action, adapter)
            raised = False
        except RuntimeError:
            raised = True
        row = await s.load_persisted_task(TASK)
    assert before is not None and row is not None
    accepted = status in ACTIONS[action]["accepts"]
    if action == "cancel":
        assert not raised
        assert row.status == ("cancelled" if accepted else status)
        return
    assert raised is not accepted
    if not accepted:
        assert row.status == status
        assert row.deadline == before.deadline
        assert adapter.calls == []
    elif action == "update_deadline":
        assert row.status == "scheduled"
        assert row.deadline != before.deadline
    else:
        assert adapter.calls == ["hi"]
        assert row.status == "completed"


@pytest.mark.parametrize(
    "race", FIXTURE["races"], ids=lambda r: f"{r['action']}-{r['read']}-to-{r['ledger']}"
)
async def test_an_action_on_a_stale_read_leaves_the_other_process_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, race: dict[str, str]
) -> None:
    """AE4, AE5: this scheduler reads the row as ``read``; another process
    then writes ``ledger``; this scheduler's write misses."""
    db = tmp_path / "queue.db"
    adapter = RecordingAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, TASK, race["read"])
        read = s._lookup_record
        reads = 0

        async def read_then_other_process_writes(task_id: str) -> TaskRecord | None:
            nonlocal reads
            record = await read(task_id)
            reads += 1
            if reads == 1:
                await _other_process_writes(db, task_id, race["ledger"])
            return record

        monkeypatch.setattr(s, "_lookup_record", read_then_other_process_writes)
        events_before = _events(db, TASK)
        if race["outcome"] == "refused":
            refusal = {
                "expedite": "just claimed by another process",
                "retry": "just claimed by another process",
                "update_deadline": f"is {race['ledger']!r}",
            }[race["action"]]
            with pytest.raises(RuntimeError, match=refusal):
                await _act(s, race["action"], adapter)
        else:
            returned = await _act(s, race["action"], adapter)
            assert returned.status == race["ledger"]
            assert returned.receipt == FIRST_RECEIPT
            assert returned.result == "theirs"
        row = await s.load_persisted_task(TASK)
    assert adapter.calls == []
    assert row is not None
    assert row.status == race["ledger"]
    # The only new event is the other process's own write.
    new_events = _events(db, TASK)[len(events_before) :]
    assert new_events == (["completed"] if race["ledger"] == "completed" else [])


async def test_a_cancel_that_hits_writes_one_cancelled_event(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, TASK, "scheduled")
        first = await s.cancel_task(TASK)
        second = await s.cancel_task(TASK)
    assert first.status == second.status == "cancelled"
    assert _events(db, TASK) == ["cancelled"]


async def test_a_cancel_that_misses_twice_returns_the_row_the_ledger_holds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each read is stale: another process moves the row between the read and
    the write, twice. The cancel then returns the row as the ledger holds it."""
    db = tmp_path / "queue.db"
    moves = iter(["queued", "scheduled"])
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, TASK, "scheduled")
        lookup = s._lookup_record

        async def read_then_other_process_writes(task_id: str) -> TaskRecord | None:
            record = await lookup(task_id)
            status = next(moves, None)
            if status is not None:
                await _other_process_writes(db, task_id, status)
            return record

        monkeypatch.setattr(s, "_lookup_record", read_then_other_process_writes)
        returned = await s.cancel_task(TASK)
        row = await s.load_persisted_task(TASK)
    assert returned.status == "scheduled"
    assert row is not None and row.status == "scheduled"
    assert _events(db, TASK) == []


async def test_a_cancel_whose_write_fails_leaves_the_cached_row_as_it_was(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        _insert(db, TASK, "scheduled")
        assert s._store is not None

        async def busy(*_args: Any, **_kwargs: Any) -> bool:
            raise sqlite3.OperationalError("database is locked")

        monkeypatch.setattr(s._store, "transition_if", busy)
        with pytest.raises(sqlite3.OperationalError):
            await s.cancel_task(TASK)
        cached = s.get_task(TASK)
    assert cached is not None and cached.status == "scheduled"
    assert cached.completed_at is None


async def test_a_scheduler_without_a_ledger_still_cancels_and_expedites() -> None:
    adapter = RecordingAdapter()
    async with Scheduler(feed=mock_grid_feed()) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        one = await s.enqueue_provider_call(spec)
        two = await s.enqueue_provider_call(spec)
        assert (await s.cancel_task(one.task_id)).status == "cancelled"
        assert (await s.expedite_task(two.task_id, {"anthropic": adapter})).status == "completed"
    assert adapter.calls == ["hi"]


async def test_transition_if_guards_status_and_timing_and_inserts_only_when_asked(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.db"
    async with _TaskStore(str(db)) as store:
        _insert(db, TASK, "scheduled")
        row = await store.load(TASK)
        assert row is not None
        timing = await store.timing_of(TASK)
        assert timing is not None and timing["not_before"] is None

        row.status = "running"
        assert not await store.transition_if(row, ("queued",))
        stale = {**timing, "scheduled_for": _iso(timedelta(hours=1))}
        assert not await store.transition_if(row, ("scheduled",), stale)
        loaded = await store.load(TASK)
        assert loaded is not None and loaded.status == "scheduled"
        # NULL matches NULL in the timing guard.
        assert await store.transition_if(row, ("scheduled",), timing)
        loaded = await store.load(TASK)
        assert loaded is not None and loaded.status == "running"

        # A moved occurrence of a quota_reset series keeps its label (the TS rule).
        with contextlib.closing(sqlite3.connect(db)) as conn, conn:
            conn.execute(
                "UPDATE tasks SET repeat = 'quota_reset', quota_provider = 'anthropic' "
                "WHERE task_id = ?",
                (TASK,),
            )
        series = await store.load(TASK)
        assert series is not None and series.deadline_kind == "absolute"
        series.status = "cancelled"
        assert await store.transition_if(series, ("running",))
        loaded = await store.load(TASK)
        assert loaded is not None and loaded.quota_provider == "anthropic"

        absent = TaskRecord(task_id="tt:absent", status="queued", enqueued_at=_iso(), region="DE")
        assert not await store.transition_if(absent, ("queued",))
        assert await store.load("tt:absent") is None
        assert await store.transition_if(absent, ("queued",), insert_if_absent=True)
        assert await store.load("tt:absent") is not None
