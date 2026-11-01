"""Handed-off rows on a shared ledger: the Python port needs no change.

The TS core writes three new things to a ledger this port may tick: the
``handoff`` body object (``cwd``, ``profile``, ``resultPath``), one-off
``command`` rows queued by ``tidegap queue add`` (no ``job_id``,
``command.origin == "cli"``), and the ``notified`` and ``result_file``
events. This port keeps unknown body keys through its terminal writes,
holds every ``command`` row for the Node daemon, and never reads events.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from tidegap import Scheduler, mock_grid_feed
from tidegap.providers.base import BatchHandle, DispatchOptions, DispatchResult, ProviderAdapter
from tidegap.scheduler import _TaskStore

SESSION = "d76db676-78da-4dca-b20e-1328074e7009"
ORIGIN = {"agent": "claude-code", "via": "hook"}
CAPS = {
    "commandTimeoutMs": 300000,
    "llmTimeoutMs": 600000,
    "maxBudgetUsd": 1,
    "outputCapBytes": 10485760,
    "summarizeInputCapBytes": 204800,
}


class _Adapter(ProviderAdapter):
    """Records the prompts it runs and answers ``ok``."""

    def __init__(self, name: str) -> None:
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


def _iso(minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()


async def _ledger(path: Path) -> None:
    store = _TaskStore(str(path))
    await store.connect()
    await store.close()


def _insert(path: Path, task_id: str, body: dict[str, object], *, status: str = "scheduled") -> None:
    completed = _iso(-1) if status == "completed" else None
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(
            "INSERT INTO tasks (task_id, status, enqueued_at, scheduled_for, region, body_json, "
            "deadline, origin_session_id, origin_cwd, completed_at) "
            "VALUES (?, ?, ?, ?, 'DE', ?, ?, ?, '/work/app', ?)",
            (task_id, status, _iso(-5), _iso(-1), json.dumps(body), _iso(360), SESSION, completed),
        )


def _event(path: Path, task_id: str, kind: str, actor: str, details: dict[str, object]) -> None:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        conn.execute(
            "INSERT INTO task_events (task_id, at, kind, actor, details) VALUES (?, ?, ?, ?, ?)",
            (task_id, _iso(0), kind, actor, json.dumps(details)),
        )


def _row(path: Path, task_id: str) -> tuple[str, dict[str, object], str | None]:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        status, body, session = conn.execute(
            "SELECT status, body_json, origin_session_id FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
    return status, json.loads(body), session


def _events(path: Path, task_id: str) -> list[tuple[str, str, dict[str, object]]]:
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        rows = conn.execute(
            "SELECT kind, actor, details FROM task_events WHERE task_id = ? ORDER BY id", (task_id,)
        ).fetchall()
    return [(k, a, json.loads(d)) for k, a, d in rows]


def _one_off_command() -> dict[str, object]:
    return {
        "type": "provider_call",
        "provider": "command",
        "model": "none",
        "prompt": "",
        "command": {"run": "echo hello > /tmp/tg-hello.txt", "cwd": "/tmp", "secrets": [], "origin": "cli"},
        "caps": CAPS,
        "handoff": {"resultPath": "/tmp/tg-result.txt"},
        "origin": ORIGIN,
    }


async def test_a_one_off_command_row_is_held_for_node(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _ledger(path)
    _insert(path, "t-cmd", _one_off_command())
    adapter = _Adapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
    assert result.inspected == 0
    assert result.held_for_node == ["t-cmd"]
    assert adapter.prompts == []
    status, body, _ = _row(path, "t-cmd")
    assert status == "scheduled"
    assert body == _one_off_command()


async def test_handoff_keys_survive_a_python_terminal_write(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _ledger(path)
    anthropic = {
        "type": "provider_call",
        "provider": "anthropic",
        "model": "claude-sonnet-5",
        "prompt": "summarize; key sk-ant-" + "a" * 30,
        "handoff": {"resultPath": "/work/app/summary.md"},
        "origin": ORIGIN,
    }
    claude = {
        "type": "provider_call",
        "provider": "claude-code",
        "model": "default",
        "prompt": "review the change",
        "tools": ["Read", "Grep", "Glob"],
        "handoff": {"cwd": "/work/app/.worktrees/fix", "profile": "read", "resultPath": "/tmp/review.md"},
        "origin": ORIGIN,
    }
    _insert(path, "t-api", anthropic)
    _insert(path, "t-cc", claude)
    adapters = {"anthropic": _Adapter("anthropic"), "claude-code": _Adapter("claude-code")}
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick(adapters)
    assert result.failed == 0
    for task_id, written in (("t-api", anthropic), ("t-cc", claude)):
        status, body, session = _row(path, task_id)
        assert status == "completed"
        assert session == SESSION
        assert body["handoff"] == written["handoff"]
        assert body["origin"] == ORIGIN
    # The terminal write still redacts the prompt and keeps the tools.
    assert "sk-ant-" not in str(_row(path, "t-api")[1]["prompt"])
    assert _row(path, "t-cc")[1]["tools"] == ["Read", "Grep", "Glob"]


async def test_ts_written_notice_and_result_events_leave_python_writes_working(tmp_path: Path) -> None:
    path = tmp_path / "queue.db"
    await _ledger(path)
    done = {"type": "provider_call", "provider": "anthropic", "model": "m", "prompt": "p", "origin": ORIGIN}
    _insert(path, "t-done", {**done, "handoff": {"resultPath": "/tmp/r.md"}}, status="completed")
    _event(path, "t-done", "result_file", "tick", {"path": "/tmp/r.md", "written": True, "bytes": 2})
    _event(path, "t-done", "notified", "agent:claude-code", {"via": "prompt", "session_id": SESSION, "completed_at": _iso(-1)})
    _insert(path, "t-next", done)
    adapter = _Adapter("anthropic")
    async with Scheduler(feed=mock_grid_feed(), db_path=str(path)) as sched:
        result = await sched.tick({"anthropic": adapter})
        loaded = await sched.load_persisted_task("t-done")
    assert loaded is not None
    assert loaded.status == "completed"
    assert result.failed == 0
    assert adapter.prompts == ["p"]
    assert _row(path, "t-next")[0] == "completed"
    assert [k for k, _, _ in _events(path, "t-next")][-1] == "completed"
    kinds = [(k, a) for k, a, _ in _events(path, "t-done")]
    assert kinds == [("result_file", "tick"), ("notified", "agent:claude-code")]
    assert _row(path, "t-done")[0] == "completed"


def test_a_one_off_command_text_follows_the_prompt_redaction() -> None:
    from tidegap.scheduler import _redact_body_json

    key = "sk-ant-" + "b" * 30
    one_off = {**_one_off_command(), "command": {**_one_off_command()["command"], "run": f"curl -H 'x-api-key: {key}' x"}}
    out = json.loads(_redact_body_json(json.dumps(one_off)) or "{}")
    assert key not in out["command"]["run"]
    assert out["command"]["run"].startswith("curl -H 'x-api-key: [REDACTED]'")
    assert out["command"]["origin"] == "cli"
    # A command job run keeps its text: the job holds it, and runs it again.
    job_run = {**one_off, "command": {k: v for k, v in one_off["command"].items() if k != "origin"}}
    assert json.loads(_redact_body_json(json.dumps(job_run)) or "{}")["command"]["run"] == job_run["command"]["run"]
