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

import asyncio
import contextlib
import json
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tidegap import Scheduler, TaskCancelledError, mock_grid_feed
from tidegap.grid import GridFeed
from tidegap.providers.base import (
    BatchHandle,
    BatchResultItem,
    BatchRetrieveResult,
    DispatchOptions,
    DispatchResult,
    ProviderAdapter,
)
from tidegap.scheduler import _PENDING_STATUSES, _UNFINISHED_STATUSES, _TaskStore
from tidegap.types import (
    CarbonReceipt,
    DeferOptions,
    GridForecast,
    GridForecastEntry,
    GridSource,
    ProviderCallSpec,
    TaskRecord,
)

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


def _insert(
    db: Path,
    task_id: str,
    status: str,
    *,
    deadline_hours: float = 3,
    batch_id: str | None = None,
) -> None:
    """A provider-call row in ``status``, due now, with a deadline 3 h out
    (over 24 h makes it a Batch row)."""
    terminal = status in ("completed", "failed", "cancelled")
    with contextlib.closing(sqlite3.connect(db)) as conn, conn:
        conn.execute(
            "INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, completed_at, "
            "region, error, body_json, deadline, batch_id, deadline_kind) "
            "VALUES (?, ?, ?, ?, ?, 'DE', ?, ?, ?, ?, 'absolute')",
            (
                task_id,
                status,
                _iso(timedelta(minutes=-10)),
                _iso(timedelta(minutes=-1)),
                _iso(timedelta(minutes=-1)) if terminal else None,
                "boom" if status == "failed" else None,
                BODY,
                _iso(timedelta(hours=deadline_hours)),
                batch_id,
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
        elif status == "cancelled":
            row.completed_at = _iso()
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
    writes = {name: spec["accepts"] for name, spec in FIXTURE["writes"].items()}
    assert writes == {
        "schedule": FIXTURE["pending"],
        "closure_dispatch": FIXTURE["pending"],
        "pre_call": ["running", "scheduled"],
        "result": ["running"],
        "fail_while_planning": FIXTURE["pending"],
        "fail": FIXTURE["unfinished"],
    }
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


# ---- U7: the dispatch writes ------------------------------------------- #


class RacingAdapter(ProviderAdapter):
    """A Batch-capable adapter: while the call named by ``race["call"]`` is in
    flight, another process writes ``race["other_writer"]`` on the row."""

    name = "anthropic"

    def __init__(self, db: Path, race: dict[str, str]) -> None:
        self._db = db
        self._race = race

    async def _other_process(self) -> None:
        await _other_process_writes(self._db, TASK, self._race["other_writer"])

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        await self._other_process()
        if self._race["call"] == "fails":
            raise ValueError("provider refused the call")
        return DispatchResult(
            text="ours", model=model, provider=self.name, input_tokens=3, output_tokens=2
        )

    async def dispatch_batch(
        self, model: str, prompts: list[str], options: DispatchOptions | None = None
    ) -> BatchHandle:
        await self._other_process()
        if self._race["call"] == "routed_fallback":
            raise ValueError("batch endpoint rejected the request")
        return BatchHandle(
            batch_id="batch-ours", provider=self.name, model=model, prompt_count=len(prompts)
        )

    async def retrieve_batch(self, batch_id: str) -> BatchRetrieveResult:
        await self._other_process()
        return BatchRetrieveResult(
            status="completed",
            results=[BatchResultItem(text="ours", model="m", input_tokens=3, output_tokens=2)],
        )


ROUTING: dict[str, Any] = {
    "considered": [{"provider": "anthropic", "model": "m", "score": 1.0}],
    "chosen": "anthropic:m",
}


@pytest.mark.parametrize(
    "race",
    FIXTURE["dispatch_races"],
    ids=lambda r: f"{r['call']}-while-{r['other_writer']}",
)
async def test_a_dispatch_result_never_overwrites_another_process_write(
    tmp_path: Path, race: dict[str, str]
) -> None:
    """The row keeps what the other process wrote during the call; the tick
    reports the result as dropped."""
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        if race["call"] == "poll":
            _insert(db, TASK, "submitted", deadline_hours=48, batch_id="batch-theirs")
        else:
            batch = race["call"] in ("submit", "routed_fallback")
            _insert(db, TASK, "scheduled", deadline_hours=48 if batch else 3)
        if race["call"] == "routed_fallback":
            with contextlib.closing(sqlite3.connect(db)) as conn, conn:
                conn.execute(
                    "UPDATE tasks SET routing_decision = ? WHERE task_id = ?",
                    (json.dumps(ROUTING), TASK),
                )
        result = await s.tick({"anthropic": RacingAdapter(db, race)})
        row = await s.load_persisted_task(TASK)
    assert row is not None
    assert row.status == race["after"]
    events = _events(db, TASK)
    assert "failed" not in events
    if race["after"] == "completed":
        assert row.result == "theirs"
        assert row.receipt == FIRST_RECEIPT
        assert events.count("completed") == 1
    if race["call"] == "submit":
        assert row.batch_id is None
    assert [e.status for e in result.results] == ["failed"]
    if race["call"] == "submit":
        assert "batch batch-ours is not stored" in (result.results[0].error or "")
    if race["call"] == "routed_fallback":
        # The sync call after the failed submit is never made.
        assert "before dispatch; not sent" in (result.results[0].error or "")


async def test_fail_on_a_row_another_process_completed_writes_nothing(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s.enqueue_provider_call(spec, DeferOptions(deadline=_iso(timedelta(hours=3)), task_id=TASK))
        cached = s.get_task(TASK)
        assert cached is not None and cached.status == "scheduled"
        await _other_process_writes(db, TASK, "completed")
        assert not await s._fail(TASK, RuntimeError("late failure"))
        row = await s.load_persisted_task(TASK)
    assert row is not None
    assert row.status == "completed"
    assert row.result == "theirs"
    assert _events(db, TASK) == ["completed"]


class HookedFeed(GridFeed):
    """The mock feed, with ``hook`` run once inside the first forecast fetch:
    another process writes while this scheduler awaits the forecast."""

    source: GridSource = "mock"

    def __init__(self, hook: Callable[[], Awaitable[None]]) -> None:
        self._inner = mock_grid_feed()
        self._hook: Callable[[], Awaitable[None]] | None = hook

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        hook, self._hook = self._hook, None
        if hook is not None:
            await hook()
        return await self._inner.fetch_forecast(region, hours)


async def test_a_closure_another_process_cancelled_before_its_window_never_runs(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.db"
    ran: list[int] = []
    s: Scheduler

    async def cancel_from_another_process() -> None:
        # The enqueue's background insert lands first; then the cancel.
        await asyncio.gather(*s._background)
        await _other_process_writes(db, TASK, "cancelled")

    async with Scheduler(feed=HookedFeed(cancel_from_another_process), db_path=str(db)) as s:
        # A deadline inside the current hour: the window is now.
        awaiter = s.defer(
            lambda: ran.append(1),
            DeferOptions(deadline=_iso(timedelta(milliseconds=300)), task_id=TASK),
        )
        with pytest.raises(TaskCancelledError):
            await asyncio.wait_for(awaiter, timeout=5)
        row = await s.load_persisted_task(TASK)
    assert ran == []
    assert row is not None and row.status == "cancelled"
    assert _events(db, TASK) == ["cancelled"]


async def test_a_budget_failure_after_the_forecast_leaves_a_row_another_process_claimed(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.db"

    async def claim_from_another_process() -> None:
        await _other_process_writes(db, TASK, "running")

    async with Scheduler(feed=HookedFeed(claim_from_another_process), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        record = await s.enqueue_provider_call(
            spec,
            DeferOptions(
                deadline=_iso(timedelta(hours=3)), task_id=TASK, carbon_budget_g=0.000001
            ),
        )
        row = await s.load_persisted_task(TASK)
    assert record.status == "running"
    assert row is not None and row.status == "running" and row.error is None
    assert _events(db, TASK) == []


async def test_a_schedule_write_after_the_forecast_keeps_another_process_run_now(
    tmp_path: Path,
) -> None:
    db = tmp_path / "queue.db"
    run_now_at = _iso()

    async def run_now_from_another_process() -> None:
        # The Node runNow: scheduled for now, out of the window picker.
        with contextlib.closing(sqlite3.connect(db)) as conn, conn:
            conn.execute(
                "UPDATE tasks SET status = 'scheduled', scheduled_for = ?, "
                "intensity_source = 'expedited' WHERE task_id = ?",
                (run_now_at, TASK),
            )

    async with Scheduler(feed=HookedFeed(run_now_from_another_process), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        record = await s.enqueue_provider_call(
            spec, DeferOptions(deadline=_iso(timedelta(hours=3)), task_id=TASK)
        )
        row = await s.load_persisted_task(TASK)
    assert row is not None
    assert (row.status, row.scheduled_for, row.intensity_source) == (
        "scheduled",
        run_now_at,
        "expedited",
    )
    assert record.scheduled_for == run_now_at


class FixedFeed(GridFeed):
    """A forecast with the clean hour next (``NOW`` sits at 10:07:30Z), so a
    closure's window is ahead and its schedule loop writes ``scheduled``.
    ``hook`` runs once inside the first fetch."""

    source: GridSource = "mock"

    def __init__(self, hook: Callable[[], Awaitable[None]] | None = None) -> None:
        self.hook = hook

    async def fetch_forecast(self, region: str, hours: int) -> GridForecast:
        hook, self.hook = self.hook, None
        if hook is not None:
            await hook()
        entries = [
            GridForecastEntry(
                datetime=(NOW.replace(minute=0, second=0) + timedelta(hours=h)).isoformat(),
                carbon_intensity_g_co2_per_kwh=g,
                band="average",
            )
            for h, g in ((0, 900.0), (1, 50.0), (2, 900.0))
        ]
        return GridForecast(
            region=region, source="mock", generated_at=NOW.isoformat(), entries=entries
        )


NOW = datetime(2026, 11, 2, 10, 7, 30, tzinfo=UTC)


def _record_scheduled_writes(
    s: Scheduler, monkeypatch: pytest.MonkeyPatch
) -> tuple[list[bool], asyncio.Event]:
    """Each write of a ``scheduled`` closure row: whether it landed, and an
    event set when one is made (the loop then sleeps toward 11:00)."""
    wrote = asyncio.Event()
    hits: list[bool] = []
    write_if = s._write_if

    async def recording(record: TaskRecord, *args: Any, **kwargs: Any) -> bool:
        hit = await write_if(record, *args, **kwargs)
        if record.task_id == TASK and (record.status == "scheduled" or not hit):
            hits.append(hit)
            wrote.set()
        return hit

    monkeypatch.setattr(s, "_write_if", recording)
    return hits, wrote


def _defer_closure(s: Scheduler, ran: list[int]) -> asyncio.Future[Any]:
    deadline = (NOW + timedelta(hours=3)).isoformat()
    return asyncio.ensure_future(
        s.defer(lambda: ran.append(1), DeferOptions(deadline=deadline, task_id=TASK))
    )


async def test_a_closure_schedule_write_ignores_a_timing_change_by_another_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Status only, as the TS ``schedule``: a deadline another process wrote
    during the forecast fetch does not strand the closure or reject its
    awaiter. The re-plan after an ``update_deadline`` reads the stored
    timing before its fetch."""
    monkeypatch.setattr("tidegap.scheduler._now_utc", lambda: NOW)
    db = tmp_path / "queue.db"
    ran: list[int] = []

    async def move_deadline_from_another_process() -> None:
        with contextlib.closing(sqlite3.connect(db)) as conn, conn:
            conn.execute(
                "UPDATE tasks SET deadline = ? WHERE task_id = ?",
                ((NOW + timedelta(hours=5)).isoformat(), TASK),
            )

    feed = FixedFeed()
    async with Scheduler(feed=feed, db_path=str(db)) as s:
        hits, wrote = _record_scheduled_writes(s, monkeypatch)
        awaiter = _defer_closure(s, ran)
        await asyncio.wait_for(wrote.wait(), timeout=5)
        wrote.clear()
        feed.hook = move_deadline_from_another_process
        await s.update_deadline(TASK, (NOW + timedelta(hours=4)).isoformat())
        await asyncio.wait_for(wrote.wait(), timeout=5)
        row = await s.load_persisted_task(TASK)
        assert hits == [True, True]
        assert not awaiter.done()
        assert TASK in s._bodies
        await s.cancel_task(TASK)
        with pytest.raises(TaskCancelledError):
            await awaiter
    assert row is not None and row.status == "scheduled"
    assert ran == []


async def test_update_deadline_on_a_closure_another_process_cancelled_rejects_its_awaiter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("tidegap.scheduler._now_utc", lambda: NOW)
    db = tmp_path / "queue.db"
    ran: list[int] = []
    async with Scheduler(feed=FixedFeed(), db_path=str(db)) as s:
        _hits, wrote = _record_scheduled_writes(s, monkeypatch)
        awaiter = _defer_closure(s, ran)
        await asyncio.wait_for(wrote.wait(), timeout=5)
        await _other_process_writes(db, TASK, "cancelled")
        with pytest.raises(RuntimeError, match="is 'cancelled'"):
            await s.update_deadline(TASK, (NOW + timedelta(hours=5)).isoformat())
        with pytest.raises(TaskCancelledError):
            await asyncio.wait_for(awaiter, timeout=5)
        assert TASK not in s._bodies
    assert ran == []
    assert _events(db, TASK) == ["cancelled"]


async def test_update_deadline_refuses_when_another_process_runs_the_task_now_meanwhile(
    tmp_path: Path,
) -> None:
    """The first write lands; another process runs the task now during the
    forecast fetch, so the schedule write misses and the update is refused."""
    db = tmp_path / "queue.db"
    run_now_at = _iso()

    async def run_now_from_another_process() -> None:
        with contextlib.closing(sqlite3.connect(db)) as conn, conn:
            conn.execute(
                "UPDATE tasks SET status = 'scheduled', scheduled_for = ?, "
                "intensity_source = 'expedited' WHERE task_id = ?",
                (run_now_at, TASK),
            )

    feed = HookedFeed(run_now_from_another_process)
    feed._hook = None
    async with Scheduler(feed=feed, db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        await s.enqueue_provider_call(spec, DeferOptions(deadline=_iso(timedelta(hours=3)), task_id=TASK))
        feed._hook = run_now_from_another_process
        with pytest.raises(RuntimeError, match="update_deadline"):
            await s.update_deadline(TASK, _iso(timedelta(hours=5)))
        row = await s.load_persisted_task(TASK)
    assert row is not None
    assert (row.status, row.scheduled_for, row.intensity_source) == (
        "scheduled",
        run_now_at,
        "expedited",
    )


async def test_enqueue_provider_call_never_overwrites_a_row_another_process_inserted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another process inserts the same id between the duplicate check and
    the insert: its row stays, and this enqueue is refused."""
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        assert s._store is not None
        _insert(db, TASK, "running")

        async def not_there_yet(task_id: str) -> TaskRecord | None:
            return None

        monkeypatch.setattr(s._store, "load", not_there_yet)
        spec = ProviderCallSpec(provider="anthropic", model="m", prompt="hi")
        with pytest.raises(ValueError, match="already in the queue"):
            await s.enqueue_provider_call(spec, DeferOptions(deadline=_iso(timedelta(hours=3)), task_id=TASK))
        monkeypatch.undo()
        row = await s.load_persisted_task(TASK)
        assert s.get_task(TASK) is None
    assert row is not None and row.status == "running"
