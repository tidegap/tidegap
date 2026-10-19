"""Aggregate carbon-budget alerts (ROADMAP item 4).

Python mirror of ``packages/core-ts/test/budget.test.ts``. Covers the pure
helpers (window math, usage, status), config loading (file + env override),
the DB marker (idempotent + multi-process double-fire guard), and the
scheduler hook (fires once, idempotent across restarts, window rollover
resets, status rendering).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tidegap import (
    CarbonAlert,
    CarbonBudgetConfig,
    CarbonReceipt,
    DeferOptions,
    ProviderCallSpec,
    Scheduler,
    TaskRecord,
    carbon_budget_status,
    carbon_budget_usage,
    load_carbon_budget_config,
    mock_grid_feed,
    receipt_carbon_g,
    window_bounds,
)
from tidegap.providers.base import BatchHandle, DispatchOptions, DispatchResult, ProviderAdapter
from tidegap.scheduler import _TaskStore


class FakeAdapter(ProviderAdapter):
    name = "anthropic"

    async def dispatch(
        self, model: str, prompt: str, options: DispatchOptions | None = None,
    ) -> DispatchResult:
        # No usage tokens — the receipt then uses the model's typical energy
        # estimate (a non-trivial gram figure), mirroring the TS fake adapter.
        return DispatchResult(text=f"echo:{prompt}", model=model, provider="anthropic")

    async def dispatch_batch(
        self, model: str, prompts: list[str], options: DispatchOptions | None = None,
    ) -> BatchHandle:
        return BatchHandle(batch_id="b1", provider="anthropic", size=len(prompts))


def _completed_row(task_id: str, ran_at: str, actual_g: float) -> TaskRecord:
    return TaskRecord(
        task_id=task_id,
        status="completed",
        enqueued_at=ran_at,
        region="US-CAL-CISO",
        receipt=CarbonReceipt(
            task_id=task_id,
            ran_at=ran_at,
            region="US-CAL-CISO",
            estimated_carbon_g_co2=actual_g,
            actual_carbon_g_co2=actual_g,
        ),
    )


# --------------------------------------------------------------------- #
# Pure helpers


def test_window_bounds_daily() -> None:
    start, end = window_bounds("daily", datetime(2026, 7, 17, 13, 45, tzinfo=UTC))
    assert start == datetime(2026, 7, 17, tzinfo=UTC)
    assert end == datetime(2026, 7, 18, tzinfo=UTC)


def test_window_bounds_weekly_monday_start() -> None:
    # 2026-07-17 is Friday -> week starts Monday 2026-07-13.
    start, end = window_bounds("weekly", datetime(2026, 7, 17, 13, 45, tzinfo=UTC))
    assert start == datetime(2026, 7, 13, tzinfo=UTC)
    assert end == datetime(2026, 7, 20, tzinfo=UTC)


def test_window_bounds_monthly() -> None:
    start, end = window_bounds("monthly", datetime(2026, 7, 17, tzinfo=UTC))
    assert start == datetime(2026, 7, 1, tzinfo=UTC)
    assert end == datetime(2026, 8, 1, tzinfo=UTC)


def test_receipt_carbon_g_prefers_actual() -> None:
    r = CarbonReceipt(task_id="t", ran_at="x", region="r", estimated_carbon_g_co2=5, actual_carbon_g_co2=7)
    assert receipt_carbon_g(r) == 7
    r2 = CarbonReceipt(task_id="t", ran_at="x", region="r", estimated_carbon_g_co2=5)
    assert receipt_carbon_g(r2) == 5
    assert receipt_carbon_g(None) == 0


def test_carbon_budget_usage_window_filter() -> None:
    at = datetime(2026, 7, 17, 12, tzinfo=UTC)
    rows = [
        _completed_row("a", "2026-07-17T01:00:00.000Z", 10),
        _completed_row("b", "2026-07-17T23:00:00.000Z", 4),
        _completed_row("c", "2026-07-16T23:00:00.000Z", 100),  # prev day
    ]
    usage = carbon_budget_usage(rows, "daily", at)
    assert usage.used_g == 14
    assert usage.task_count == 2
    assert usage.window_start == "2026-07-17T00:00:00.000Z"


def test_carbon_budget_status_percent_and_exceeded() -> None:
    at = datetime(2026, 7, 17, 12, tzinfo=UTC)
    rows = [_completed_row("a", "2026-07-17T01:00:00.000Z", 75)]
    status = carbon_budget_status(rows, CarbonBudgetConfig("daily", 100), at, False)
    assert status.used_g == 75
    assert status.pct == 75
    assert status.exceeded is False
    rows.append(_completed_row("b", "2026-07-17T02:00:00.000Z", 40))
    over = carbon_budget_status(rows, CarbonBudgetConfig("daily", 100), at, True)
    assert over.used_g == 115
    assert over.exceeded is True
    assert over.alerted is True


# --------------------------------------------------------------------- #
# Config loading


def test_load_config_none_when_unset(tmp_path: Path) -> None:
    assert load_carbon_budget_config(path=str(tmp_path / "missing"), env={}) is None


def test_load_config_from_file(tmp_path: Path) -> None:
    p = tmp_path / "config"
    p.write_text("# budget\nTIDEGAP_CARBON_BUDGET_G=500\nTIDEGAP_CARBON_BUDGET_WINDOW=weekly\n")
    cfg = load_carbon_budget_config(path=str(p), env={})
    assert cfg == CarbonBudgetConfig("weekly", 500)


def test_load_config_defaults_daily(tmp_path: Path) -> None:
    p = tmp_path / "config"
    p.write_text("TIDEGAP_CARBON_BUDGET_G=250\n")
    cfg = load_carbon_budget_config(path=str(p), env={})
    assert cfg is not None
    assert cfg.window_kind == "daily"


def test_load_config_env_overrides_file(tmp_path: Path) -> None:
    p = tmp_path / "config"
    p.write_text("TIDEGAP_CARBON_BUDGET_G=500\nTIDEGAP_CARBON_BUDGET_WINDOW=weekly\n")
    cfg = load_carbon_budget_config(
        path=str(p),
        env={"TIDEGAP_CARBON_BUDGET_G": "999", "TIDEGAP_CARBON_BUDGET_WINDOW": "monthly"},
    )
    assert cfg == CarbonBudgetConfig("monthly", 999)


def test_load_config_disabled_on_bad_threshold(tmp_path: Path) -> None:
    p = tmp_path / "config"
    p.write_text("TIDEGAP_CARBON_BUDGET_G=0\n")
    assert load_carbon_budget_config(path=str(p), env={}) is None
    assert load_carbon_budget_config(path=str(tmp_path / "x"), env={"TIDEGAP_CARBON_BUDGET_G": "abc"}) is None


# --------------------------------------------------------------------- #
# DB marker


@pytest.mark.asyncio
async def test_marker_records_once(tmp_path: Path) -> None:
    store = _TaskStore(str(tmp_path / "queue.db"))
    await store.connect()
    try:
        ws = "2026-07-17T00:00:00.000Z"
        assert await store.record_budget_alert("daily", ws, 100, 120, "t-1", "now") is True
        assert await store.record_budget_alert("daily", ws, 100, 130, "t-2", "now") is False
        assert await store.has_budget_alert("daily", ws, 100) is True
        # Rollover (new window) fires again; a different threshold is distinct.
        assert await store.record_budget_alert("daily", "2026-07-18T00:00:00.000Z", 100, 120, "t-3", "now") is True
        assert await store.record_budget_alert("daily", ws, 50, 120, "t-4", "now") is True
    finally:
        await store.close()


@pytest.mark.asyncio
async def test_marker_multi_process_guard(tmp_path: Path) -> None:
    db = str(tmp_path / "queue.db")
    a = _TaskStore(db)
    b = _TaskStore(db)
    await a.connect()
    await b.connect()
    try:
        ws = "2026-07-17T00:00:00.000Z"
        assert await a.record_budget_alert("daily", ws, 100, 120, "t-1", "now") is True
        # The second handle sees the marker and does NOT re-fire.
        assert await b.record_budget_alert("daily", ws, 100, 130, "t-2", "now") is False
        assert await b.has_budget_alert("daily", ws, 100) is True
    finally:
        await a.close()
        await b.close()


# --------------------------------------------------------------------- #
# Scheduler hook


def _soon() -> str:
    return (datetime.now(UTC) + timedelta(seconds=1)).isoformat()


async def _enqueue_due(s: Scheduler, task_id: str) -> str:
    spec = ProviderCallSpec(provider="anthropic", model="claude-x", prompt="hi")
    rec = await s.enqueue_provider_call(spec, DeferOptions(deadline=_soon(), task_id=task_id))
    rec.scheduled_for = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    await s._store.upsert(rec)  # type: ignore[union-attr]
    s._tasks[rec.task_id] = rec  # type: ignore[index]
    return rec.task_id


@pytest.mark.asyncio
async def test_scheduler_fires_once_then_never(tmp_path: Path) -> None:
    db = str(tmp_path / "queue.db")
    alerts: list[CarbonAlert] = []
    async with Scheduler(
        feed=mock_grid_feed(),
        db_path=db,
        signing=False,
        carbon_budget=CarbonBudgetConfig("daily", 0.0001),
        on_carbon_alert=lambda a: alerts.append(a),
    ) as s:
        tid = await _enqueue_due(s, "t-cross")
        result = await s.tick({"anthropic": FakeAdapter()})
        assert result.dispatched == 1
        assert len(alerts) == 1
        assert alerts[0].window_kind == "daily"
        assert alerts[0].task_id_that_crossed == tid
        assert alerts[0].actual_g >= 0.0001
        # A second tick (nothing new completes) must not re-fire.
        await s.tick({"anthropic": FakeAdapter()})
        assert len(alerts) == 1


@pytest.mark.asyncio
async def test_scheduler_no_fire_under_threshold(tmp_path: Path) -> None:
    db = str(tmp_path / "queue.db")
    alerts: list[CarbonAlert] = []
    async with Scheduler(
        feed=mock_grid_feed(),
        db_path=db,
        signing=False,
        carbon_budget=CarbonBudgetConfig("daily", 1_000_000),
        on_carbon_alert=lambda a: alerts.append(a),
    ) as s:
        await _enqueue_due(s, "t-under")
        await s.tick({"anthropic": FakeAdapter()})
        assert alerts == []


@pytest.mark.asyncio
async def test_scheduler_idempotent_across_restart(tmp_path: Path) -> None:
    db = str(tmp_path / "queue.db")
    first: list[CarbonAlert] = []
    async with Scheduler(
        feed=mock_grid_feed(), db_path=db, signing=False,
        carbon_budget=CarbonBudgetConfig("daily", 0.0001),
        on_carbon_alert=lambda a: first.append(a),
    ) as s1:
        await _enqueue_due(s1, "t-a")
        await s1.tick({"anthropic": FakeAdapter()})
        assert len(first) == 1

    # Fresh scheduler on the same ledger: the marker already exists.
    second: list[CarbonAlert] = []
    async with Scheduler(
        feed=mock_grid_feed(), db_path=db, signing=False,
        carbon_budget=CarbonBudgetConfig("daily", 0.0001),
        on_carbon_alert=lambda a: second.append(a),
    ) as s2:
        await _enqueue_due(s2, "t-b")
        await s2.tick({"anthropic": FakeAdapter()})
        assert second == []


@pytest.mark.asyncio
async def test_scheduler_status(tmp_path: Path) -> None:
    db = str(tmp_path / "queue.db")
    async with Scheduler(
        feed=mock_grid_feed(), db_path=db, signing=False,
        carbon_budget=CarbonBudgetConfig("daily", 0.0001),
        on_carbon_alert=lambda a: None,
    ) as s:
        empty = await s.get_carbon_budget_status()
        assert empty is not None
        assert empty.task_count == 0
        await _enqueue_due(s, "t-s")
        await s.tick({"anthropic": FakeAdapter()})
        status = await s.get_carbon_budget_status()
        assert status is not None
        assert status.task_count == 1
        assert status.exceeded is True
        assert status.alerted is True


@pytest.mark.asyncio
async def test_scheduler_status_none_without_budget(tmp_path: Path) -> None:
    async with Scheduler(feed=mock_grid_feed(), db_path=str(tmp_path / "q.db"), signing=False) as s:
        assert await s.get_carbon_budget_status() is None


def test_017_ebb_keys_in_file_are_not_read_and_named_once(tmp_path, monkeypatch, capsys):
    from tidegap import _env

    monkeypatch.setattr(_env, "_reported", set())
    p = tmp_path / "config"
    p.write_text("EBB_CARBON_BUDGET_G=500\nEBB_CARBON_BUDGET_WINDOW=weekly\n")
    assert load_carbon_budget_config(path=str(p), env={}) is None
    assert load_carbon_budget_config(path=str(p), env={}) is None
    err = capsys.readouterr().err.strip().splitlines()
    assert len(err) == 2
    assert "EBB_CARBON_BUDGET_G" in err[0] and "TIDEGAP_CARBON_BUDGET_G" in err[0]
    assert "EBB_CARBON_BUDGET_WINDOW" in err[1]


def test_tidegap_key_is_used_next_to_an_ebb_key_in_file(tmp_path):
    p = tmp_path / "config"
    p.write_text("EBB_CARBON_BUDGET_G=500\nTIDEGAP_CARBON_BUDGET_G=300\n")
    cfg = load_carbon_budget_config(path=str(p), env={})
    assert cfg is not None and cfg.threshold_g == 300


def test_ebb_env_is_not_read_and_named_once(tmp_path, monkeypatch, capsys):
    from tidegap import _env

    monkeypatch.setattr(_env, "_reported", set())
    monkeypatch.delenv("TIDEGAP_CARBON_BUDGET_G", raising=False)
    monkeypatch.delenv("TIDEGAP_CARBON_BUDGET_WINDOW", raising=False)
    monkeypatch.delenv("EBB_CARBON_BUDGET_WINDOW", raising=False)
    monkeypatch.setenv("EBB_CARBON_BUDGET_G", "40")
    assert load_carbon_budget_config(path=str(tmp_path / "absent")) is None
    assert load_carbon_budget_config(path=str(tmp_path / "absent")) is None
    err = capsys.readouterr().err.strip().splitlines()
    assert len(err) == 1 and "EBB_CARBON_BUDGET_G" in err[0] and "no longer read" in err[0]
    monkeypatch.setenv("TIDEGAP_CARBON_BUDGET_G", "70")
    cfg = load_carbon_budget_config(path=str(tmp_path / "absent"))
    assert cfg is not None and cfg.threshold_g == 70


# --------------------------------------------------------------------- #
# Fresh home: the ledger directory does not exist yet


@pytest.mark.asyncio
async def test_connect_creates_missing_ledger_dir(tmp_path: Path) -> None:
    ledger_dir = tmp_path / "home" / ".tidegap"
    store = _TaskStore(str(ledger_dir / "queue.db"))
    await store.connect()
    await store.close()
    assert (ledger_dir / "queue.db").exists()
    assert ledger_dir.stat().st_mode & 0o777 == 0o700


@pytest.mark.asyncio
async def test_connect_keeps_existing_ledger_dir(tmp_path: Path) -> None:
    ledger_dir = tmp_path / ".tidegap"
    ledger_dir.mkdir(mode=0o700)
    (ledger_dir / "keep.txt").write_text("keep")
    db = str(ledger_dir / "queue.db")
    store = _TaskStore(db)
    await store.connect()
    try:
        ws = "2026-10-19T00:00:00.000Z"
        assert await store.record_budget_alert("daily", ws, 100, 120, "t-1", "now") is True
    finally:
        await store.close()
    again = _TaskStore(db)
    await again.connect()
    try:
        assert await again.has_budget_alert("daily", "2026-10-19T00:00:00.000Z", 100) is True
    finally:
        await again.close()
    assert (ledger_dir / "keep.txt").read_text() == "keep"
