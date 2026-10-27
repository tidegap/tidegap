"""Floating recurring jobs: Python ledger parity (U4).

The Python port never materializes, sweeps or runs jobs. It must still open
a ledger the TS core migrated, keep ``tasks.job_id`` on its writes, and
leave a ``provider: "command"`` occurrence alone instead of failing it.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

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


def _insert_task(path: Path, task_id: str, body: dict[str, object], job_id: str | None) -> None:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(
            "INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, region, "
            "body_json, deadline, job_id) VALUES (?, 'scheduled', ?, ?, 'DE', ?, ?, ?)",
            (task_id, _past(), _past(), json.dumps(body), _future(), job_id),
        )


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
    assert _status(path, "job-0000000c~1") == ("scheduled", "job-0000000c")
    assert "failed" not in _events(path, "job-0000000c~1")


class _ClaudeCodeAdapter(ProviderAdapter):
    """A stand-in ``claude-code`` adapter: the hold applies only without one."""

    name = "claude-code"

    def __init__(self) -> None:
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


async def test_tick_runs_a_claude_code_occurrence_when_an_adapter_serves_it(tmp_path: Path) -> None:
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
    _insert_task(path, "job-0000000d~1", body, "job-0000000d")
    adapter = _ClaudeCodeAdapter()
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"claude-code": adapter})
    assert result.failed == 0
    assert adapter.prompts == ["summarize my mail"]
    assert _status(path, "job-0000000d~1") == ("completed", "job-0000000d")


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
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        with pytest.raises(RuntimeError, match="runs a shell command"):
            await sched.expedite_task("job-0000000b~1", {})
    assert _status(path, "job-0000000b~1") == ("scheduled", "job-0000000b")
    assert "failed" not in _events(path, "job-0000000b~1")


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
