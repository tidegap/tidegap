"""One ledger, two writers (KTD2): both cores report the same carbon budget.

The rows and the expected usage live in the TS package,
``packages/core-ts/test/fixtures/mixed-ledger-receipts.json``, which
``packages/core-ts/test/mixed-ledger-receipts.test.ts`` also reads. Each
receipt is stored as given: camelCase for a Node row, snake_case with nulls
for a Python one.
"""

from __future__ import annotations

import contextlib
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from tidegap import CarbonBudgetConfig, Scheduler, mock_grid_feed
from tidegap.budget import CarbonBudgetWindowKind
from tidegap.scheduler import _TaskStore

# parents[2] == <repo>/packages, then down into core-ts/test/fixtures.
FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "core-ts"
    / "test"
    / "fixtures"
    / "mixed-ledger-receipts.json"
)
FIXTURE: dict[str, Any] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


async def _ledger(path: Path) -> None:
    store = _TaskStore(str(path))
    await store.connect()
    await store.close()
    with contextlib.closing(sqlite3.connect(path)) as conn, conn:
        for row in FIXTURE["rows"]:
            conn.execute(
                "INSERT INTO tasks (task_id, status, enqueued_at, completed_at, region, "
                "receipt_json) VALUES (?, 'completed', ?, ?, 'FR', ?)",
                (row["taskId"], FIXTURE["at"], FIXTURE["at"], json.dumps(row["receipt"])),
            )


@pytest.mark.parametrize("window_kind", ["daily", "weekly"])
async def test_budget_status_over_the_shared_mixed_ledger_fixture(
    tmp_path: Path, window_kind: CarbonBudgetWindowKind
) -> None:
    db = tmp_path / "queue.db"
    await _ledger(db)
    expected = FIXTURE["expected"][window_kind]
    async with Scheduler(
        feed=mock_grid_feed(),
        db_path=str(db),
        signing=False,
        carbon_budget=CarbonBudgetConfig(window_kind, 1_000_000),
    ) as s:
        status = await s.get_carbon_budget_status(
            datetime.fromisoformat(FIXTURE["at"].replace("Z", "+00:00"))
        )
    assert status is not None
    assert status.window_start == expected["windowStart"]
    assert status.task_count == expected["taskCount"]
    assert status.used_g == pytest.approx(expected["usedG"])
