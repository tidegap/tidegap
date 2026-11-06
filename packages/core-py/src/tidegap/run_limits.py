"""The run-limits registry — the Python twin of ``packages/core-ts/src/run-limits.ts``.

The one place that names each run limit, its ``~/.tidegap/config`` keys, its
per-runner defaults, the duration grammar, the settings read and the
precedence resolver.

Precedence for each limit, first match wins: the task's or job's own value
(``task``), the per-runner setting ``<KEY>_<RUNNER>`` (``setting:<runner>``),
the all-runners setting ``<KEY>`` (``setting``), the built-in default for the
runner (``default``).

``none`` switches a time limit off; ``0`` is refused, so one character never
means both "nothing" and "no limit".

The settings come from the config file only, read fresh at each call; there is
no environment layer. Both cores pass
``packages/core-ts/test/fixtures/run-limits-vectors.json``.
"""

from __future__ import annotations

import math
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .budget import _parse_key_values, carbon_budget_config_path

Runner = Literal["command", "claude-code", "anthropic", "openai", "gemini", "ollama"]
RunLimitName = Literal["command_timeout", "llm_timeout"]

#: A time limit in milliseconds, or ``"none"`` for no limit.
DurationValue = int | Literal["none"]

#: The caps marker of writers that store only the values a caller set.
CAPS_VERSION = 2

_SECOND_MS = 1000
_MINUTE_MS = 60 * _SECOND_MS
_HOUR_MS = 60 * _MINUTE_MS
_DAY_MS = 24 * _HOUR_MS

_MIN_DURATION_MS = _SECOND_MS
_MAX_DURATION_MS = 7 * _DAY_MS


@dataclass(frozen=True)
class RunLimitDefinition:
    name: RunLimitName
    #: The all-runners key in ``~/.tidegap/config``.
    key: str
    #: The CLI flag and setting name.
    cli_name: str
    #: The key of the row's or job's caps that holds a per-task value.
    caps_key: str
    #: Built-in default per runner, in ms. The runners listed are the ones the limit applies to.
    defaults: Mapping[str, int]
    #: Whether ``<KEY>_<RUNNER>`` keys are read.
    per_runner: bool
    #: The default every writer stored before caps carried ``capsVersion``: on
    #: caps without the marker, a stored value equal to it counts as unset.
    legacy_default_ms: int


RUN_LIMITS: tuple[RunLimitDefinition, ...] = (
    RunLimitDefinition(
        name="command_timeout",
        key="TIDEGAP_COMMAND_TIMEOUT",
        cli_name="command-timeout",
        caps_key="commandTimeoutMs",
        defaults={"command": 30 * _MINUTE_MS},
        per_runner=False,
        legacy_default_ms=5 * _MINUTE_MS,
    ),
    RunLimitDefinition(
        name="llm_timeout",
        key="TIDEGAP_LLM_TIMEOUT",
        cli_name="llm-timeout",
        caps_key="llmTimeoutMs",
        defaults={
            "claude-code": 30 * _MINUTE_MS,
            "anthropic": 10 * _MINUTE_MS,
            "openai": 10 * _MINUTE_MS,
            "gemini": 10 * _MINUTE_MS,
            "ollama": 10 * _MINUTE_MS,
        },
        per_runner=True,
        legacy_default_ms=10 * _MINUTE_MS,
    ),
)


class DurationError(ValueError):
    """A value the duration grammar refuses; the message is a fixed sentence."""


DURATION_FORM_ERROR = (
    "Use a duration from 1s to 7d, such as 90s, 30m, 1.5h or 2d, or none for no time limit."
)
DURATION_ZERO_ERROR = "0 is not a time limit; use none for no time limit."
DURATION_RANGE_ERROR = "A time limit must be from 1s to 7d; use none for no time limit."

_UNIT_MS = {"s": _SECOND_MS, "m": _MINUTE_MS, "min": _MINUTE_MS, "h": _HOUR_MS, "d": _DAY_MS}

#: The characters JavaScript's ``trim()`` and ``\s`` match (WhiteSpace and
#: LineTerminator), so both cores strip and split a value the same way.
#: Python's own ``str.strip()`` and ``\s`` differ (BOM, ``\x1c``-``\x1f``).
_JS_SPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006"
    "\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
# ASCII digits only, as in JavaScript: ``\d`` in a Python str pattern also
# matches other scripts' digits, which ``float()`` would then read.
_DURATION_RE = re.compile(f"([0-9]+(?:\\.[0-9]+)?)[{_JS_SPACE}]*(s|m|min|h|d)?")


def _js_trim(text: str) -> str:
    """``text`` stripped as JavaScript's ``String.prototype.trim()`` strips it."""
    return text.strip(_JS_SPACE)


def parse_duration(text: str) -> DurationValue:
    """Parse a time limit: a number with an optional unit ``s``, ``m`` (or
    ``min``), ``h`` or ``d``, case-insensitive, a bare number being seconds;
    from 1 second to 7 days; or ``none``. Returns milliseconds or ``"none"``;
    raises :class:`DurationError` with a fixed sentence that names ``none``.
    """
    value = _js_trim(text).lower()
    if value == "none":
        return "none"
    m = _DURATION_RE.fullmatch(value)
    if not m:
        raise DurationError(DURATION_FORM_ERROR)
    n = float(m.group(1))
    if n == 0:
        raise DurationError(DURATION_ZERO_ERROR)
    raw_ms = n * _UNIT_MS[m.group(2) or "s"]
    # A number too large for a float is out of range, as Infinity is in Node.
    if not math.isfinite(raw_ms):
        raise DurationError(DURATION_RANGE_ERROR)
    # floor(x + 0.5) rounds half up, as Math.round does in the Node core.
    ms = math.floor(raw_ms + 0.5)
    if ms < _MIN_DURATION_MS or ms > _MAX_DURATION_MS:
        raise DurationError(DURATION_RANGE_ERROR)
    return ms


def format_duration(value: DurationValue) -> str:
    """The canonical form of a time limit: the largest whole unit, else seconds; ``none`` as is."""
    if value == "none":
        return "none"
    for unit_ms, unit in ((_DAY_MS, "d"), (_HOUR_MS, "h"), (_MINUTE_MS, "m"), (_SECOND_MS, "s")):
        if value % unit_ms == 0:
            return f"{value // unit_ms}{unit}"
    return f"{value / _SECOND_MS}s"


def _runner_suffix(runner: str) -> str:
    """The config-key suffix of a runner: ``claude-code`` -> ``CLAUDE_CODE``."""
    return runner.upper().replace("-", "_")


@dataclass(frozen=True)
class IgnoredRunLimitLine:
    """One ``~/.tidegap/config`` line the read skipped, and why."""

    key: str
    value: str
    reason: str


@dataclass(frozen=True)
class RunLimitSettings:
    #: The valid values by config key, in ms or ``"none"``.
    values: Mapping[str, DurationValue] = field(default_factory=dict)
    #: Lines under a run-limit key that were skipped, in file order.
    ignored: tuple[IgnoredRunLimitLine, ...] = ()


def _suffix_error(definition: RunLimitDefinition, suffix: str) -> str | None:
    """Why a ``<KEY>_<SUFFIX>`` line is not read, or ``None`` when the suffix is a runner the limit takes."""
    if not definition.per_runner:
        return f"{definition.key} takes no runner suffix."
    names = [_runner_suffix(r) for r in definition.defaults]
    if suffix in names:
        return None
    return f"{definition.key} takes a runner suffix of {', '.join(names[:-1])} or {names[-1]}."


def run_limit_settings_from_values(pairs: Mapping[str, str]) -> RunLimitSettings:
    """The run-limit settings out of already-read KEY=VALUE pairs. Keys outside
    the registry are left alone; an empty value counts as unset; any other
    line under a run-limit key that cannot be used is listed in ``ignored``.
    """
    values: dict[str, DurationValue] = {}
    ignored: list[IgnoredRunLimitLine] = []
    for key, raw in pairs.items():
        definition = next(
            (d for d in RUN_LIMITS if key == d.key or key.startswith(f"{d.key}_")), None
        )
        if definition is None:
            continue
        value = _js_trim(raw)
        if value == "":
            continue
        key_error = (
            None
            if key == definition.key
            else _suffix_error(definition, key[len(definition.key) + 1 :])
        )
        if key_error is not None:
            ignored.append(IgnoredRunLimitLine(key, value, key_error))
            continue
        try:
            values[key] = parse_duration(value)
        except DurationError as err:
            ignored.append(IgnoredRunLimitLine(key, value, str(err)))
    return RunLimitSettings(values=values, ignored=tuple(ignored))


_reported_lines: set[str] = set()


def load_run_limit_settings(*, path: str | None = None) -> RunLimitSettings:
    """Read the run-limit settings from ``~/.tidegap/config`` (or ``path``). A
    missing or unreadable file gives no settings and never raises. Each
    ignored line is reported on stderr once per process.
    """
    try:
        with open(
            path if path is not None else carbon_budget_config_path(),
            encoding="utf-8",
            errors="replace",
        ) as fh:
            contents = fh.read()
    except OSError:
        return RunLimitSettings()
    settings = run_limit_settings_from_values(_parse_key_values(contents))
    for line in settings.ignored:
        line_id = f"{line.key}={line.value}"
        if line_id in _reported_lines:
            continue
        _reported_lines.add(line_id)
        print(f"tidegap: ~/.tidegap/config: {line.key} ignored: {line.reason}", file=sys.stderr)
    return settings


@dataclass(frozen=True)
class ResolvedRunLimit:
    value: DurationValue
    #: ``task``, ``setting:<runner>``, ``setting`` or ``default``.
    source: str


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _task_value(definition: RunLimitDefinition, caps: Mapping[str, Any]) -> DurationValue | None:
    """A stored per-task value, or ``None`` when it is unset or not a limit."""
    stored = caps.get(definition.caps_key)
    if stored == "none":
        return "none"
    if not _is_number(stored) or not math.isfinite(stored) or stored <= 0:
        return None
    version = caps.get("capsVersion")
    versioned = _is_number(version) and version >= CAPS_VERSION
    if not versioned and stored == definition.legacy_default_ms:
        return None
    return stored


def resolve_run_limits(
    caps: Mapping[str, Any] | None,
    settings: RunLimitSettings,
    runner: str,
) -> dict[str, ResolvedRunLimit]:
    """Each limit that applies to ``runner``, with its value and source.

    ``caps`` is the row's spec caps or the job's caps as stored; only the keys
    the caller set count, and on caps without ``capsVersion: 2`` a value equal
    to the old stored default counts as unset.
    """
    out: dict[str, ResolvedRunLimit] = {}
    for definition in RUN_LIMITS:
        fallback = definition.defaults.get(runner)
        if fallback is None:
            continue
        own = _task_value(definition, caps) if caps else None
        per_runner = (
            settings.values.get(f"{definition.key}_{_runner_suffix(runner)}")
            if definition.per_runner
            else None
        )
        everyone = settings.values.get(definition.key)
        if own is not None:
            out[definition.name] = ResolvedRunLimit(own, "task")
        elif per_runner is not None:
            out[definition.name] = ResolvedRunLimit(per_runner, f"setting:{runner}")
        elif everyone is not None:
            out[definition.name] = ResolvedRunLimit(everyone, "setting")
        else:
            out[definition.name] = ResolvedRunLimit(fallback, "default")
    return out
