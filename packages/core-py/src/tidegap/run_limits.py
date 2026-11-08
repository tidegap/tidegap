"""The run-limits registry — the Python twin of ``packages/core-ts/src/run-limits.ts``.

The one place that names each run limit and retry setting, its
``~/.tidegap/config`` keys, its per-runner defaults, the value grammar, the
settings read and the precedence resolver; plus the failure classifier and
the retry planner.

Precedence for each limit, first match wins: the task's or job's own value
(``task``), the per-runner setting ``<KEY>_<RUNNER>`` (``setting:<runner>``),
the all-runners setting ``<KEY>`` (``setting``), the built-in default for the
runner (``default``).

``none`` switches a time limit off; ``0`` is refused, so one character never
means both "nothing" and "no limit". For retries ``0`` means no automatic
retry, and a retry delay takes neither.

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
RunLimitName = Literal["command_timeout", "llm_timeout", "retries", "retry_delay"]
RunLimitKind = Literal["time_limit", "delay", "count"]

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
#: The most automatic retries a setting or a task can ask for.
MAX_RETRIES = 10

_EVERY_RUNNER = ("command", "claude-code", "anthropic", "openai", "gemini", "ollama")


@dataclass(frozen=True)
class RunLimitDefinition:
    name: RunLimitName
    #: ``time_limit``: a duration in ms or ``none``; ``delay``: a duration in
    #: ms, ``none`` refused; ``count``: a whole number from 0 to 10.
    kind: RunLimitKind
    #: The all-runners key in ``~/.tidegap/config``.
    key: str
    #: The CLI flag and setting name.
    cli_name: str
    #: The key of the row's or job's caps that holds a per-task value.
    caps_key: str
    #: Built-in default per runner, in ms (a count for ``count``). The runners
    #: listed are the ones the setting applies to.
    defaults: Mapping[str, int]
    #: Whether ``<KEY>_<RUNNER>`` keys are read.
    per_runner: bool
    #: The default every writer stored before caps carried ``capsVersion``: on
    #: caps without the marker, a stored value equal to it counts as unset.
    #: Only the time limits had one.
    legacy_default_ms: int | None = None


RUN_LIMITS: tuple[RunLimitDefinition, ...] = (
    RunLimitDefinition(
        name="command_timeout",
        kind="time_limit",
        key="TIDEGAP_COMMAND_TIMEOUT",
        cli_name="command-timeout",
        caps_key="commandTimeoutMs",
        defaults={"command": 30 * _MINUTE_MS},
        per_runner=False,
        legacy_default_ms=5 * _MINUTE_MS,
    ),
    RunLimitDefinition(
        name="llm_timeout",
        kind="time_limit",
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
    RunLimitDefinition(
        name="retries",
        kind="count",
        key="TIDEGAP_RETRIES",
        cli_name="retries",
        caps_key="retries",
        defaults=dict.fromkeys(_EVERY_RUNNER, 1),
        per_runner=True,
    ),
    RunLimitDefinition(
        name="retry_delay",
        kind="delay",
        key="TIDEGAP_RETRY_DELAY",
        cli_name="retry-delay",
        caps_key="retryDelayMs",
        defaults=dict.fromkeys(_EVERY_RUNNER, 30 * _MINUTE_MS),
        per_runner=True,
    ),
)


def run_limit_definition(name: str) -> RunLimitDefinition:
    """The registry entry of ``name``."""
    return next(d for d in RUN_LIMITS if d.name == name)


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


RETRIES_ERROR = "Retries must be a whole number from 0 to 10; 0 turns automatic retries off."
RETRY_DELAY_ERROR = (
    "A retry delay must be a duration from 1s to 7d, such as 90s, 30m or 2h; 0 and none are refused."
)


def parse_retries(text: str) -> int:
    """Parse a retry count: a whole number from 0 to 10. Raises
    :class:`DurationError` with :data:`RETRIES_ERROR`."""
    value = _js_trim(text)
    if not re.fullmatch("[0-9]+", value):
        raise DurationError(RETRIES_ERROR)
    n = int(value)
    if n > MAX_RETRIES:
        raise DurationError(RETRIES_ERROR)
    return n


def parse_retry_delay(text: str) -> int:
    """Parse a retry delay: the duration grammar without ``none``. Raises
    :class:`DurationError` with :data:`RETRY_DELAY_ERROR`."""
    try:
        value = parse_duration(text)
    except DurationError:
        raise DurationError(RETRY_DELAY_ERROR) from None
    if value == "none":
        raise DurationError(RETRY_DELAY_ERROR)
    return value


def parse_run_limit_value(definition: RunLimitDefinition, text: str) -> DurationValue:
    """Parse a value of a setting by its kind; raises :class:`DurationError` with the setting's sentence."""
    if definition.kind == "count":
        return parse_retries(text)
    if definition.kind == "delay":
        return parse_retry_delay(text)
    return parse_duration(text)


def format_run_limit_value(definition: RunLimitDefinition, value: DurationValue) -> str:
    """A value of a setting as a person reads and writes it: ``30m``, ``none``, ``2``."""
    return str(value) if definition.kind == "count" else format_duration(value)


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
            values[key] = parse_run_limit_value(definition, value)
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


def _is_retry_count(value: Any) -> bool:
    """A whole number from 0 to :data:`MAX_RETRIES` (a float such as ``2.0`` counts, as in JSON)."""
    return _is_number(value) and math.isfinite(value) and value == int(value) and 0 <= value <= MAX_RETRIES


def _task_value(definition: RunLimitDefinition, caps: Mapping[str, Any]) -> DurationValue | None:
    """A stored per-task value, or ``None`` when it is unset or not a valid value of the setting."""
    stored = caps.get(definition.caps_key)
    if definition.kind == "count":
        return int(stored) if _is_retry_count(stored) else None
    if stored == "none":
        return "none" if definition.kind == "time_limit" else None
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


def resolve_task_run_limits(
    spec: Mapping[str, Any], settings: RunLimitSettings
) -> dict[str, ResolvedRunLimit]:
    """The limits of one run of a row: a model call's for its runner; a
    command's for the ``command`` runner, plus its summarize step's LLM limit
    for the summarize provider. ``spec`` is the row's stored body.
    """
    caps = spec.get("caps")
    caps = caps if isinstance(caps, Mapping) else None
    provider = spec.get("provider")
    out = resolve_run_limits(caps, settings, provider) if isinstance(provider, str) else {}
    summarize = spec.get("summarize")
    if provider == "command" and isinstance(summarize, Mapping):
        step = summarize.get("provider")
        if isinstance(step, str):
            llm = resolve_run_limits(caps, settings, step).get("llm_timeout")
            if llm is not None:
                out["llm_timeout"] = llm
    return out


def duration_seconds(value: DurationValue) -> float | int | Literal["none"]:
    """A time limit as event details carry it: seconds, or ``"none"``."""
    if value == "none":
        return "none"
    seconds = value / _SECOND_MS
    return int(seconds) if float(seconds).is_integer() else seconds


def run_limits_details(limits: Mapping[str, ResolvedRunLimit]) -> dict[str, dict[str, Any]]:
    """The ``limits`` details of a ``dispatched`` event: each effective time
    limit, in seconds or ``"none"``, and its source (the Node core's shape).
    """
    out: dict[str, dict[str, Any]] = {}
    for definition in RUN_LIMITS:
        limit = limits.get(definition.name)
        if limit is None:
            continue
        if definition.kind == "count":
            out[definition.name] = {"value": limit.value, "source": limit.source}
        else:
            out[definition.name] = {"value_s": duration_seconds(limit.value), "source": limit.source}
    return out


#: Why a run failed, as the retry policy reads it. ``timeout``, ``exit``,
#: ``transient`` and ``interrupted`` may retry; ``permanent``,
#: ``after_command`` and ``batch_submit_interrupted`` never do.
FailureClass = Literal[
    "timeout",
    "exit",
    "transient",
    "interrupted",
    "permanent",
    "after_command",
    "batch_submit_interrupted",
]

FAILURE_CLASSES: tuple[FailureClass, ...] = (
    "timeout",
    "exit",
    "transient",
    "interrupted",
    "permanent",
    "after_command",
    "batch_submit_interrupted",
)

_RETRYABLE: frozenset[str] = frozenset({"timeout", "exit", "transient", "interrupted"})


def is_retryable_failure(cls: str) -> bool:
    """True for a class whose failure may retry."""
    return cls in _RETRYABLE


def classify_failure(facts: Mapping[str, Any]) -> FailureClass:
    """The class of a failure from its facts (the Node core's ``FailureFacts``
    keys: ``status``, ``permanent``, ``stopped_by``, ``steps``, ``exit``,
    ``interrupted``). An unmarked unknown error is ``transient``: one more
    attempt costs less than a lost task.
    """
    steps = facts.get("steps")
    steps = steps if isinstance(steps, list | tuple) else ()
    interrupted = facts.get("interrupted")
    stopped_by = facts.get("stopped_by")
    if interrupted == "batch_submit":
        return "batch_submit_interrupted"
    if "prompt" in steps:
        return "after_command"
    if interrupted == "run":
        return "interrupted"
    if facts.get("permanent") is True or stopped_by == "budget":
        return "permanent"
    if stopped_by in ("command_timeout", "llm_timeout"):
        return "timeout"
    status = facts.get("status")
    if _is_number(status) and 400 <= status < 500 and status != 429:
        return "permanent"
    if facts.get("exit") is True or "command" in steps:
        return "exit"
    return "transient"


#: The sentence a final failure's error ends with when no retry fits before the deadline.
NO_TIME_LEFT_TEXT = "no time left before the deadline for a retry"


def plan_retry(
    *,
    attempt: int,
    retries: int,
    delay_ms: int,
    failed_at: int,
    deadline: int | None = None,
    not_before: int | None = None,
) -> dict[str, Any]:
    """The next attempt after attempt ``attempt`` (1-based) failed at
    ``failed_at``: ``{"retry_at": ms}``, or ``{"final": reason}`` with
    ``no_retries_left`` or ``no_time_left``. Retry k waits
    ``delay_ms * 2**(k-1)``, a later ``not_before`` wins, and the start must
    not pass ``deadline``. Times in ms since the epoch.
    """
    if attempt > retries:
        return {"final": "no_retries_left"}
    retry_at = max(failed_at + delay_ms * 2 ** (attempt - 1), not_before or 0)
    if deadline is not None and retry_at > deadline:
        return {"final": "no_time_left"}
    return {"retry_at": retry_at}


def attempt_number(events: Any) -> int:
    """The number of the attempt a run of a task is: one plus the
    ``attempt_failed`` events since the newest ``created`` event or manual
    retry (a ``rescheduled`` event with reason ``retry``). ``events`` are
    oldest first, each with ``kind`` and ``details`` (mappings or objects).
    """
    failed = 0
    for event in reversed(list(events)):
        kind = event.get("kind") if isinstance(event, Mapping) else getattr(event, "kind", None)
        details = event.get("details") if isinstance(event, Mapping) else getattr(event, "details", None)
        if kind == "created":
            break
        if kind == "rescheduled" and isinstance(details, Mapping) and details.get("reason") == "retry":
            break
        if kind == "attempt_failed":
            failed += 1
    return failed + 1


def final_failure_error(error: str, attempts: int, reason: str | None = None) -> str:
    """The error a final failure stores: the run's error, then the attempt
    count when more than one ran, then the no-time reason."""
    counted = f" (after {attempts} attempts)" if attempts > 1 else ""
    no_time = f" ({NO_TIME_LEFT_TEXT})" if reason == "no_time_left" else ""
    return f"{error}{counted}{no_time}"
