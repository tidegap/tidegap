"""Floating recurring jobs: Python ledger parity (U4) and the jobs exception.

The Python port never materializes, sweeps or runs jobs. It must still open
a ledger the TS core migrated, keep ``tasks.job_id`` on its writes, and
hold every job row (whatever its provider and the adapters) and every
``command`` or ``claude-code`` row it has no adapter for, for the Node
daemon. Each tick reports them in ``TickResult`` and logs one warning.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tests.test_batch import BatchAdapter
from tidegap import ProviderCallSpec, Scheduler, mock_grid_feed
from tidegap.providers.base import BatchHandle, DispatchOptions, DispatchResult, ProviderAdapter
from tidegap.scheduler import _TaskStore

# The TS-only jobs table, as the TS core creates it (abridged to the
# NOT NULL columns; this port never reads it).
TS_JOBS_TABLE = """
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
  cadence TEXT NOT NULL, time_zone TEXT NOT NULL, runner TEXT NOT NULL,
  template_json TEXT NOT NULL, caps_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO jobs VALUES ('job-0000000a', 'Mail digest', 'active', 'daily',
  'Europe/Berlin', 'command', '{}', '{}', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z');
"""

CAPS = {
    "commandTimeoutMs": 300000,
    "llmTimeoutMs": 600000,
    "maxBudgetUsd": 1,
    "outputCapBytes": 10485760,
    "summarizeInputCapBytes": 204800,
}


def _past() -> str:
    return (datetime.now(UTC) - timedelta(minutes=1)).isoformat()


def _future(hours: int = 6) -> str:
    return (datetime.now(UTC) + timedelta(hours=hours)).isoformat()


def _insert_task(
    path: Path,
    task_id: str,
    body: dict[str, object],
    job_id: str | None,
    *,
    status: str = "scheduled",
    deadline_hours: int = 6,
    batch_id: str | None = None,
) -> None:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(
            "INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, region, "
            "body_json, deadline, batch_id, job_id) VALUES (?, ?, ?, ?, 'DE', ?, ?, ?, ?)",
            (
                task_id,
                status,
                _past(),
                _past(),
                json.dumps(body),
                _future(deadline_hours),
                batch_id,
                job_id,
            ),
        )


def _sql(path: Path, sql: str, *params: object) -> None:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(sql, params)


def _tables(path: Path) -> set[str]:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _node_lines(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if "for the Node daemon" in r.getMessage()]


def _llm_body(provider: str = "anthropic", prompt: str = "summarize my mail") -> dict[str, object]:
    return {
        "type": "provider_call",
        "provider": provider,
        "model": "claude-sonnet-5",
        "prompt": prompt,
        "tools": [],
        "caps": CAPS,
    }


def _events(path: Path, task_id: str) -> list[str]:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        return [r[0] for r in conn.execute("SELECT kind FROM task_events WHERE task_id = ?", (task_id,))]


def _status(path: Path, task_id: str) -> tuple[str, str | None]:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        row = conn.execute("SELECT status, job_id FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    return row[0], row[1]


async def _create_ledger(path: Path) -> None:
    store = _TaskStore(str(path))
    await store.connect()
    await store.close()


async def test_python_created_ledger_has_job_id_column_and_index(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        cols = {r[0] for r in conn.execute("SELECT name FROM pragma_table_info('tasks')")}
        indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "job_id" in cols
    assert "tasks_job_idx" in indexes
    # The jobs table belongs to the TS core.
    assert "jobs" not in tables


async def test_ts_migrated_ledger_opens_and_a_python_write_keeps_job_id(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript(TS_JOBS_TABLE)
    body = {"type": "provider_call", "provider": "anthropic", "model": "claude-x", "prompt": "hi"}
    _insert_task(path, "job-0000000a~1", body, "job-0000000a")
    store = _TaskStore(str(path))
    await store.connect()
    try:
        record = await store.load("job-0000000a~1")
        assert record is not None
        record.status = "cancelled"
        await store.upsert(record)
    finally:
        await store.close()
    assert _status(path, "job-0000000a~1") == ("cancelled", "job-0000000a")
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        assert conn.execute("SELECT title FROM jobs").fetchone() == ("Mail digest",)


async def test_tick_leaves_a_command_occurrence_scheduled(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    body = {
        "type": "provider_call",
        "provider": "command",
        "model": "none",
        "prompt": "",
        "command": {"run": "echo hi", "secrets": []},
        "caps": CAPS,
    }
    _insert_task(path, "job-0000000a~1", body, "job-0000000a")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({})
    assert result.failed == 0
    assert result.inspected == 0
    assert result.held_for_node == ["job-0000000a~1"]
    assert _status(path, "job-0000000a~1") == ("scheduled", "job-0000000a")
    assert "failed" not in _events(path, "job-0000000a~1")


async def test_tick_leaves_a_claude_code_occurrence_scheduled(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    body = {
        "type": "provider_call",
        "provider": "claude-code",
        "model": "claude-sonnet-5",
        "prompt": "summarize my mail",
        "tools": [],
        "caps": CAPS,
    }
    _insert_task(path, "job-0000000c~1", body, "job-0000000c")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({})
    assert result.failed == 0
    assert result.inspected == 0
    assert result.held_for_node == ["job-0000000c~1"]
    assert _status(path, "job-0000000c~1") == ("scheduled", "job-0000000c")
    assert "failed" not in _events(path, "job-0000000c~1")


class _RecordingAdapter(ProviderAdapter):
    """A stand-in adapter that records the prompts it runs."""

    def __init__(self, name: str = "claude-code") -> None:
        self.name = name
        self.prompts: list[str] = []

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        self.prompts.append(prompt)
        return DispatchResult(text="ok", model=model, provider=self.name)

    async def dispatch_batch(
        self, model: str, prompts: list[str], options: DispatchOptions | None = None
    ) -> BatchHandle:
        raise NotImplementedError


async def test_tick_holds_a_due_anthropic_job_run_for_node(tmp_path: Path) -> None:
    # AE1: an adapter for the provider does not make a job run runnable here.
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-0000000e~1", _llm_body("anthropic"), "job-0000000e")
    adapter = _RecordingAdapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
    assert adapter.prompts == []
    assert result.inspected == 0
    assert result.held_for_node == ["job-0000000e~1"]
    assert _status(path, "job-0000000e~1") == ("scheduled", "job-0000000e")
    events = _events(path, "job-0000000e~1")
    assert "failed" not in events
    assert "dispatched" not in events


async def test_tick_holds_a_claude_code_job_run_even_with_an_adapter(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-0000000d~1", _llm_body("claude-code"), "job-0000000d")
    adapter = _RecordingAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"claude-code": adapter})
    assert adapter.prompts == []
    assert result.held_for_node == ["job-0000000d~1"]
    assert _status(path, "job-0000000d~1") == ("scheduled", "job-0000000d")


async def test_tick_runs_a_claude_code_row_without_job_id_when_an_adapter_serves_it(
    tmp_path: Path,
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "cc-1", _llm_body("claude-code"), None)
    adapter = _RecordingAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"claude-code": adapter})
    assert result.failed == 0
    assert adapter.prompts == ["summarize my mail"]
    assert result.held_for_node == []
    assert _status(path, "cc-1") == ("completed", None)


async def test_tick_holds_a_claude_code_row_without_job_id_and_without_adapter(
    tmp_path: Path,
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "cc-2", _llm_body("claude-code"), None)
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({})
    assert result.inspected == 0
    assert result.held_for_node == ["cc-2"]
    assert _status(path, "cc-2") == ("scheduled", None)


async def test_tick_does_not_batch_submit_a_job_run(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-0000000f~1", _llm_body("anthropic"), "job-0000000f", deadline_hours=30)
    adapter = BatchAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
    assert adapter.batch_calls == []
    assert adapter.dispatch_calls == []
    assert result.batch_submitted == 0
    assert result.held_for_node == ["job-0000000f~1"]
    assert _status(path, "job-0000000f~1") == ("scheduled", "job-0000000f")


async def test_tick_does_not_poll_a_submitted_job_run(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(
        path,
        "job-00000010~1",
        _llm_body("anthropic"),
        "job-00000010",
        status="submitted",
        deadline_hours=30,
        batch_id="batch-xyz",
    )
    adapter = BatchAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
    assert adapter.retrieve_calls == []
    assert result.inspected == 0
    assert result.held_for_node == ["job-00000010~1"]
    assert _status(path, "job-00000010~1") == ("submitted", "job-00000010")


async def test_a_job_row_inserted_during_the_tick_is_not_claimed(tmp_path: Path) -> None:
    # A Node sweep can insert a due job run after the tick read its held
    # set; the claim itself refuses rows that have a job_id.
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "batch-1", _llm_body("anthropic"), None, deadline_hours=30)

    class _InsertingBatchAdapter(BatchAdapter):
        async def dispatch_batch(
            self, model: str, prompts: list[str], options: DispatchOptions | None = None
        ) -> BatchHandle:
            _insert_task(path, "job-00000011~1", _llm_body("anthropic"), "job-00000011")
            return await super().dispatch_batch(model, prompts, options)

    adapter = _InsertingBatchAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
    assert result.batch_submitted == 1
    assert adapter.dispatch_calls == []
    assert _status(path, "job-00000011~1") == ("scheduled", "job-00000011")
    assert "dispatched" not in _events(path, "job-00000011~1")
    assert result.held_for_node == ["job-00000011~1"]


async def test_a_submitted_job_row_inserted_during_the_tick_is_not_polled(
    tmp_path: Path,
) -> None:
    # The poll sweep's claim refuses a submitted job run that a Node sweep
    # inserted after the tick read its held set.
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "batch-2", _llm_body("anthropic"), None, deadline_hours=30)

    class _InsertingBatchAdapter(BatchAdapter):
        async def dispatch_batch(
            self, model: str, prompts: list[str], options: DispatchOptions | None = None
        ) -> BatchHandle:
            _insert_task(
                path,
                "job-0000001a~1",
                _llm_body("anthropic"),
                "job-0000001a",
                status="submitted",
                deadline_hours=30,
                batch_id="batch-job",
            )
            return await super().dispatch_batch(model, prompts, options)

    adapter = _InsertingBatchAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
    assert result.batch_submitted == 1
    assert adapter.retrieve_calls == []
    assert _status(path, "job-0000001a~1") == ("submitted", "job-0000001a")
    assert result.held_for_node == ["job-0000001a~1"]


async def test_a_job_run_with_a_future_not_before_is_not_in_the_not_before_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-00000012~1", _llm_body("anthropic"), "job-00000012")
    _sql(
        path,
        "UPDATE tasks SET not_before = ? WHERE task_id = ?",
        _future(2),
        "job-00000012~1",
    )
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with caplog.at_level(logging.WARNING, logger="tidegap.scheduler"):
            result = await sched.tick({"anthropic": _RecordingAdapter("anthropic")})
    assert result.held_for_node == ["job-00000012~1"]
    assert [r for r in caplog.records if "not_before" in r.getMessage()] == []


async def test_active_jobs_counts_only_active_jobs(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript(TS_JOBS_TABLE)
        conn.execute(
            "INSERT INTO jobs VALUES ('job-0000000b', 'Paused', 'paused', 'daily', "
            "'Europe/Berlin', 'command', '{}', '{}', '2026-10-20T00:00:00Z', "
            "'2026-10-20T00:00:00Z')"
        )
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({})
    assert result.active_jobs == 1


async def test_a_python_ledger_reports_no_active_jobs_and_gets_no_jobs_table(
    tmp_path: Path,
) -> None:
    path = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({})
    assert result.active_jobs == 0
    assert "jobs" not in _tables(path)


async def test_node_last_tick_at_comes_from_the_meta_table(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        assert (await sched.tick({})).node_last_tick_at is None
        _sql(path, "INSERT INTO meta (key, value) VALUES ('last_tick_at', '2026-10-28T04:00:00.000Z')")
        assert (await sched.tick({})).node_last_tick_at == "2026-10-28T04:00:00.000Z"


async def test_tick_logs_one_warning_naming_what_it_leaves(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.executescript(TS_JOBS_TABLE)
    _insert_task(path, "job-00000013~1", _llm_body("anthropic", "secret prompt"), "job-00000013")
    _insert_task(path, "cc-3", _llm_body("claude-code", "other secret prompt"), None)
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with caplog.at_level(logging.WARNING, logger="tidegap.scheduler"):
            result = await sched.tick({})
    assert result.held_for_node == ["cc-3", "job-00000013~1"]
    assert result.active_jobs == 1
    lines = _node_lines(caplog)
    assert len(lines) == 1
    assert lines[0].levelno == logging.WARNING
    msg = lines[0].getMessage()
    assert "1 job run(s)" in msg
    assert "1 command/claude-code task(s)" in msg
    assert "1 active job(s)" in msg
    assert "none recorded" in msg
    assert "`tidegap install`" in msg
    assert "`tidegap status`" in msg
    assert "secret prompt" not in msg


async def test_the_warning_stays_a_warning_after_a_recent_node_tick(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    recent = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()
    _sql(path, "INSERT INTO meta (key, value) VALUES ('last_tick_at', ?)", recent)
    _insert_task(path, "job-00000014~1", _llm_body("anthropic"), "job-00000014")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with caplog.at_level(logging.WARNING, logger="tidegap.scheduler"):
            await sched.tick({})
    lines = _node_lines(caplog)
    assert len(lines) == 1
    assert lines[0].levelno == logging.WARNING
    assert recent in lines[0].getMessage()


async def test_a_tick_with_nothing_left_for_node_logs_nothing(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with caplog.at_level(logging.DEBUG, logger="tidegap.scheduler"):
            result = await sched.tick({})
    assert result.held_for_node == []
    assert _node_lines(caplog) == []


async def test_a_held_row_the_node_daemon_finished_is_not_reported_again(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-00000015~1", _llm_body("claude-code"), "job-00000015")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        first = await sched.tick({})
        assert first.held_for_node == ["job-00000015~1"]
        _sql(path, "UPDATE tasks SET status = 'completed' WHERE task_id = ?", "job-00000015~1")
        caplog.clear()
        with caplog.at_level(logging.WARNING, logger="tidegap.scheduler"):
            second = await sched.tick({})
    assert second.held_for_node == []
    assert _node_lines(caplog) == []


async def test_a_failed_ledger_read_after_the_sweeps_still_reports_the_held_rows(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-00000019~1", _llm_body("anthropic"), "job-00000019")

    async def _locked(self: _TaskStore) -> int:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(_TaskStore, "active_job_count", _locked)
    adapter = _RecordingAdapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with caplog.at_level(logging.WARNING, logger="tidegap.scheduler"):
            result = await sched.tick({"anthropic": adapter})
    error = "OperationalError: database is locked"
    assert adapter.prompts == []
    assert result.held_for_node == ["job-00000019~1"]
    assert result.node_report_error == error
    assert result.to_dict()["node_report_error"] == error
    lines = _node_lines(caplog)
    assert len(lines) == 1
    msg = lines[0].getMessage()
    assert error in msg
    assert "held 1 task(s)" in msg
    assert "`tidegap install`" in msg
    assert _status(path, "job-00000019~1") == ("scheduled", "job-00000019")


async def test_tick_result_to_dict_has_the_node_fields(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({})
    d = result.to_dict()
    assert d["held_for_node"] == []
    assert d["active_jobs"] == 0
    assert d["node_last_tick_at"] is None
    assert d["node_report_error"] is None


async def test_expedite_and_retry_refuse_a_command_occurrence(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    body = {
        "type": "provider_call",
        "provider": "command",
        "model": "none",
        "prompt": "",
        "command": {"run": "echo hi", "secrets": []},
        "caps": CAPS,
    }
    _insert_task(path, "job-0000000b~1", body, "job-0000000b")
    _insert_task(path, "cmd-1", body, None)
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with pytest.raises(RuntimeError, match="only the Node daemon runs jobs"):
            await sched.expedite_task("job-0000000b~1", {})
        with pytest.raises(RuntimeError, match="runs a shell command"):
            await sched.expedite_task("cmd-1", {})
    assert _status(path, "job-0000000b~1") == ("scheduled", "job-0000000b")
    assert "failed" not in _events(path, "job-0000000b~1")
    assert _status(path, "cmd-1") == ("scheduled", None)


def _row(path: Path, task_id: str) -> tuple[object, ...]:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        return tuple(conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone())


async def test_expedite_refuses_a_job_run(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-00000016~1", _llm_body("anthropic"), "job-00000016")
    before, events = _row(path, "job-00000016~1"), _events(path, "job-00000016~1")
    adapter = _RecordingAdapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with pytest.raises(RuntimeError) as err:
            await sched.expedite_task("job-00000016~1", {"anthropic": adapter})
    assert "`tidegap queue run-now job-00000016~1`" in str(err.value)
    assert "`tidegap jobs run job-00000016`" in str(err.value)
    assert adapter.prompts == []
    assert _row(path, "job-00000016~1") == before
    assert _events(path, "job-00000016~1") == events


async def test_retry_refuses_a_failed_job_run(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-00000017~1", _llm_body("anthropic"), "job-00000017", status="failed")
    before = _row(path, "job-00000017~1")
    adapter = _RecordingAdapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with pytest.raises(RuntimeError) as err:
            await sched.retry_task("job-00000017~1", {"anthropic": adapter})
    # Node refuses run-now on a failed row; the job retries it itself.
    assert "run-now" not in str(err.value)
    assert "`tidegap jobs run job-00000017`" in str(err.value)
    assert adapter.prompts == []
    assert _row(path, "job-00000017~1") == before
    assert _status(path, "job-00000017~1") == ("failed", "job-00000017")


async def test_expedite_names_only_jobs_run_for_a_submitted_job_run(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(
        path,
        "job-0000001b~1",
        _llm_body("anthropic"),
        "job-0000001b",
        status="submitted",
        deadline_hours=30,
        batch_id="batch-sub",
    )
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with pytest.raises(RuntimeError) as err:
            await sched.expedite_task("job-0000001b~1", {"anthropic": BatchAdapter()})
    assert "run-now" not in str(err.value)
    assert "`tidegap jobs run job-0000001b`" in str(err.value)
    assert _status(path, "job-0000001b~1") == ("submitted", "job-0000001b")


async def test_cancel_still_cancels_a_job_run(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "job-00000018~1", _llm_body("anthropic"), "job-00000018")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        record = await sched.cancel_task("job-00000018~1")
    assert record.status == "cancelled"
    assert _status(path, "job-00000018~1") == ("cancelled", "job-00000018")


async def test_expedite_still_runs_a_row_without_job_id(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _create_ledger(path)
    _insert_task(path, "plain-1", _llm_body("anthropic"), None)
    adapter = _RecordingAdapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        record = await sched.expedite_task("plain-1", {"anthropic": adapter})
    assert adapter.prompts == ["summarize my mail"]
    assert record.status == "completed"
    assert _status(path, "plain-1") == ("completed", None)


def test_from_dict_accepts_job_extra_keys() -> None:
    spec = ProviderCallSpec.from_dict(
        {
            "type": "provider_call",
            "provider": "claude-code",
            "model": "default",
            "prompt": "summarize",
            "command": {"run": "echo hi", "secrets": ["MAIL_TOKEN"]},
            "summarize": {"provider": "claude-code"},
            "caps": CAPS,
            "tools": [],
        }
    )
    assert spec.provider == "claude-code"
    assert spec.prompt == "summarize"
