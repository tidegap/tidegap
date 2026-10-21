"""_TaskStore must not leak its SQLite handle when connect() fails."""

from __future__ import annotations

import pytest

from tidegap import scheduler as sched
from tidegap.scheduler import _TaskStore


async def test_failed_connect_closes_connection(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[object] = []
    real_connect = sched.aiosqlite.connect

    async def spy(*args: object, **kwargs: object) -> object:
        conn = await real_connect(*args, **kwargs)
        opened.append(conn)
        return conn

    async def boom(_conn: object) -> None:
        raise RuntimeError("migration failed")

    monkeypatch.setattr(sched.aiosqlite, "connect", spy)
    monkeypatch.setattr(sched, "_ensure_task_visibility_columns", boom)

    store = _TaskStore(str(tmp_path / "queue.db"))
    with pytest.raises(RuntimeError, match="migration failed"):
        await store.connect()

    assert len(opened) == 1
    with pytest.raises(ValueError):  # aiosqlite: "no active connection"
        await opened[0].execute("select 1")  # type: ignore[attr-defined]
    assert store._conn is None


async def test_context_manager_connects_and_closes(tmp_path) -> None:
    async with _TaskStore(str(tmp_path / "queue.db")) as store:
        assert store._conn is not None
    assert store._conn is None


async def test_context_manager_keeps_a_handle_opened_before(tmp_path) -> None:
    store = _TaskStore(str(tmp_path / "queue.db"))
    await store.connect()
    async with store:
        pass
    assert store._conn is not None
    await store.close()
