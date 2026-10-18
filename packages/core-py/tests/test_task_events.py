"""Task events (audit trail) written by the Python core.

Same ``task_events`` table as the TS core: the ticker records
``dispatched`` on claim and ``completed`` / ``failed`` / ``cancelled`` on
terminal writes. The TS store reads these rows (see
``packages/core-ts/test/task-events.test.ts``).
"""

from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tidegap import DeferOptions, ProviderCallSpec, Scheduler, mock_grid_feed
from tidegap.providers.base import DispatchOptions, DispatchResult, ProviderAdapter
from tidegap.scheduler import _SCHEMA

TS_STORE = Path(__file__).resolve().parents[2] / "core-ts" / "src" / "storage" / "sqlite.ts"


class _Adapter(ProviderAdapter):
    name = "anthropic"

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None
    ) -> DispatchResult:
        if self.error is not None:
            raise self.error
        return DispatchResult(
            text="ok", model=model, provider="anthropic", input_tokens=1, output_tokens=1
        )


def _events(db: Path, task_id: str) -> list[tuple[str, str, dict[str, object]]]:
    with sqlite3.connect(db) as conn:
        rows = conn.execute(
            "SELECT kind, actor, details FROM task_events WHERE task_id = ? ORDER BY at, id",
            (task_id,),
        ).fetchall()
    return [(k, a, json.loads(d)) for k, a, d in rows]


async def _due(s: Scheduler, task_id: str) -> None:
    rec = await s.load_persisted_task(task_id)
    assert rec is not None
    rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    await s._store.upsert(rec)  # type: ignore[union-attr]
    s._tasks[rec.task_id] = rec  # type: ignore[index]


def _deadline() -> str:
    return (datetime.now(UTC) + timedelta(hours=6)).isoformat()


def _ddl(text: str) -> str:
    m = re.search(r"CREATE TABLE IF NOT EXISTS task_events.*?END;", text, re.S)
    assert m is not None
    return " ".join(m.group(0).split())


def test_ddl_matches_the_ts_core() -> None:
    assert _ddl(_SCHEMA) == _ddl(TS_STORE.read_text(encoding="utf-8"))


@pytest.mark.asyncio
async def test_tick_records_dispatched_then_completed(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="claude-x", prompt="hi")
        await s.enqueue_provider_call(spec, DeferOptions(deadline=_deadline(), task_id="ev:1"))
        await _due(s, "ev:1")
        assert _events(db, "ev:1") == []
        await s.tick({"anthropic": _Adapter()})
    assert _events(db, "ev:1") == [
        ("dispatched", "tick", {"provider": "anthropic", "model": "claude-x"}),
        ("completed", "tick", {"provider": "anthropic", "model": "claude-x"}),
    ]


@pytest.mark.asyncio
async def test_tick_records_failed_with_the_error(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="claude-x", prompt="hi")
        await s.enqueue_provider_call(spec, DeferOptions(deadline=_deadline(), task_id="ev:2"))
        await _due(s, "ev:2")
        err = ValueError("bad request\nsecond line")
        await s.tick({"anthropic": _Adapter(err)})
    kinds = [(k, a) for k, a, _ in _events(db, "ev:2")]
    assert kinds == [("dispatched", "tick"), ("failed", "tick")]
    assert _events(db, "ev:2")[-1][2]["error"] == "bad request"


@pytest.mark.asyncio
async def test_actor_resets_after_tick(tmp_path: Path) -> None:
    db = tmp_path / "queue.db"
    async with Scheduler(feed=mock_grid_feed(), db_path=str(db)) as s:
        spec = ProviderCallSpec(provider="anthropic", model="claude-x", prompt="hi")
        await s.enqueue_provider_call(spec, DeferOptions(deadline=_deadline(), task_id="ev:3"))
        await s.tick({"anthropic": _Adapter()})
        await s.cancel_task("ev:3")
    assert [(k, a) for k, a, _ in _events(db, "ev:3")] == [("cancelled", "system")]
