"""run_limits — the Python twin of packages/core-ts/src/run-limits.ts.

Every case comes from ``packages/core-ts/test/fixtures/run-limits-vectors.json``,
which the Node suite reads too, so the two cores parse, read and resolve the
run limits the same way.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tidegap import (
    RUN_LIMITS,
    DurationError,
    format_duration,
    load_run_limit_settings,
    parse_duration,
    resolve_run_limits,
    run_limit_settings_from_values,
)
from tidegap.budget import _parse_key_values

VECTORS: dict[str, Any] = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "core-ts"
        / "test"
        / "fixtures"
        / "run-limits-vectors.json"
    ).read_text()
)


def _settings_of(lines: list[str]) -> Any:
    return run_limit_settings_from_values(_parse_key_values("\n".join(lines)))


def _ignored(settings: Any) -> list[dict[str, str]]:
    return [{"key": i.key, "value": i.value, "reason": i.reason} for i in settings.ignored]


def _resolved(resolved: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {name: {"value": r.value, "source": r.source} for name, r in resolved.items()}


def test_registry_names_the_two_time_limits() -> None:
    assert [(d.name, d.key, d.cli_name) for d in RUN_LIMITS] == [
        ("command_timeout", "TIDEGAP_COMMAND_TIMEOUT", "command-timeout"),
        ("llm_timeout", "TIDEGAP_LLM_TIMEOUT", "llm-timeout"),
    ]
    assert RUN_LIMITS[0].defaults == {"command": 1_800_000}
    assert RUN_LIMITS[1].defaults == {
        "claude-code": 1_800_000,
        "anthropic": 600_000,
        "openai": 600_000,
        "gemini": 600_000,
        "ollama": 600_000,
    }


@pytest.mark.parametrize("vector", VECTORS["parse"], ids=lambda v: repr(v["input"]))
def test_parse_vectors(vector: dict[str, Any]) -> None:
    if "error" in vector:
        with pytest.raises(DurationError) as info:
            parse_duration(vector["input"])
        assert str(info.value) == VECTORS["errors"][vector["error"]]
        return
    value = parse_duration(vector["input"])
    assert value == vector["value"]
    assert type(value) is type(vector["value"])
    assert format_duration(value) == vector["canonical"]
    assert parse_duration(vector["canonical"]) == vector["value"]


@pytest.mark.parametrize("vector", VECTORS["settings"], ids=lambda v: v["id"])
def test_settings_vectors(vector: dict[str, Any]) -> None:
    settings = _settings_of(vector["config"])
    assert settings.values == vector["values"]
    assert _ignored(settings) == vector["ignored"]


@pytest.mark.parametrize(
    "vector", VECTORS["resolve"] + VECTORS["legacy"], ids=lambda v: v["id"]
)
def test_resolve_and_legacy_vectors(vector: dict[str, Any]) -> None:
    resolved = resolve_run_limits(
        vector.get("caps"), _settings_of(vector["config"]), vector["runner"]
    )
    assert _resolved(resolved) == vector["expected"]


def test_an_invalid_line_logs_one_warning_and_keeps_the_valid_lines(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "config"
    path.write_text("TIDEGAP_COMMAND_TIMEOUT=12m\nTIDEGAP_LLM_TIMEOUT=0\n")
    first = load_run_limit_settings(path=str(path))
    assert first.values == {"TIDEGAP_COMMAND_TIMEOUT": 720_000}
    assert [i.key for i in first.ignored] == ["TIDEGAP_LLM_TIMEOUT"]
    load_run_limit_settings(path=str(path))
    err = capsys.readouterr().err
    assert err.count("TIDEGAP_LLM_TIMEOUT ignored") == 1


def test_a_missing_or_unreadable_file_gives_the_defaults(tmp_path: Path) -> None:
    missing = load_run_limit_settings(path=str(tmp_path / "nope" / "config"))
    assert missing.values == {} and list(missing.ignored) == []
    unreadable = load_run_limit_settings(path=str(tmp_path))
    assert unreadable.values == {} and list(unreadable.ignored) == []
    assert _resolved(resolve_run_limits(None, unreadable, "anthropic")) == {
        "llm_timeout": {"value": 600_000, "source": "default"}
    }


def test_the_default_path_is_the_tidegap_config(tmp_path: Path) -> None:
    # conftest points HOME at tmp_path.
    (tmp_path / ".tidegap").mkdir()
    (tmp_path / ".tidegap" / "config").write_text("TIDEGAP_LLM_TIMEOUT=20m\n")
    assert load_run_limit_settings().values == {"TIDEGAP_LLM_TIMEOUT": 1_200_000}
