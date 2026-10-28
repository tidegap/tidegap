// Tests for scripts/qa/docs-drift-jobs.mjs (node --test): the pass and failure paths of
// the K15, K16 and K17 jobs drift rules, on small fixture pages and a fake core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jobLimitProblems, jobsSurfaceProblems, nightWindowProblems } from "./docs-drift-jobs.mjs";

const NIGHT = `"every night" is 'daily' with window '22:00-08:00'`;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const cap = (d) => d[0].toUpperCase() + d.slice(1);

// The schedule_task surface and guaranteeText, cut down to what K15 and K17 read.
const CORE = {
  TOOL_SURFACE: [
    {
      name: "schedule_task",
      description: "Queue an AI task or recurring job.",
      params: [
        { name: "prompt", description: "The task." },
        { name: "repeat", values: ["none", "daily", "weekdays", "weekly", "every_n_hours", "quota_reset"], description: `A job, e.g. ${NIGHT}.` },
        { name: "every_hours", min: 2, max: 168 },
        { name: "days", values: DAYS },
        { name: "window" },
        { name: "time_zone" },
      ],
    },
  ],
  MIN_EVERY_HOURS: 2,
  MAX_EVERY_HOURS: 168,
  guaranteeText({ cadence: c, window: w }) {
    if (c.kind === "hours") return `runs at least every ${c.every} h, never sooner than ${c.every / 2} h after the last run`;
    const days = c.kind === "weekly" ? `every ${c.days.map(cap).join(" and ")}` : c.kind === "weekdays" ? "every weekday (Mon-Fri)" : "every day";
    return w ? `runs ${days} between ${w.start} and ${w.end}` : `runs once ${days}, any time of day`;
  },
  AGENTS_BLOCK: 'For "every night", run `tidegap defer --daily --window 22:00-08:00 "<task>"`.',
};

const PAGE = `### Cadence and windows {#jobs-cadence}

| Cadence | Meaning |
| --- | --- |
| \`daily\` | Once a day. |
| \`weekdays\` | Once on each day from Monday to Friday. |
| \`weekly\` | Once on each listed day. |
| every N hours | At least every N hours, N from 2 to 168. |

"Every night" is \`daily\` with the window \`22:00-08:00\`.

- \`runs every day between 22:00 and 08:00\`
- \`runs once every weekday (Mon-Fri), any time of day\`
- \`runs every Mon and Thu between 09:00 and 17:00\`
- \`runs at least every 6 h, never sooner than 3 h after the last run\`

### Agents and schedule_task {#jobs-agents}

| Parameter | Meaning |
| --- | --- |
| \`repeat\` | \`daily\`, \`weekdays\`, \`weekly\` or \`every_n_hours\`. |
| \`every_hours\` | N for \`every_n_hours\`, 2 to 168. |
| \`days\` | Days for \`weekly\`: \`mon\` to \`sun\`. |
| \`window\` | Local hours, \`HH:MM-HH:MM\`. |
| \`time_zone\` | IANA zone. |

The older \`repeat: quota_reset\` still starts a series.

### Surfaces {#jobs-surfaces}
`;
const TOOLS = "- `schedule_task` with `repeat` set to `daily`, `weekdays`, `weekly` or `every_n_hours` creates a job.";

const k15 = ({ page = PAGE, tools = TOOLS } = {}) => jobsSurfaceProblems({ page, pageName: "jobs.md", tools, toolsName: "tools.md", core: CORE });

/** Replace one exact span; fails when the fixture no longer has it, so a mutation never runs vacuously. */
function edit(text, from, to) {
  assert.ok(text.includes(from), `fixture has ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

test("K15: a page and a tool surface that agree pass", () => {
  assert.deepEqual(k15(), []);
});

test("K15: a monthly row in the cadence table fails", () => {
  const page = edit(PAGE, "| every N hours |", "| `monthly` | Once a month. |\n| every N hours |");
  assert.deepEqual(k15({ page }), ["cadence table: docs daily monthly weekdays weekly vs code daily weekdays weekly"]);
});

test("K15: weekly missing from the tools-page list fails", () => {
  const tools = edit(TOOLS, "`weekdays`, `weekly` or", "`weekdays` or");
  assert.deepEqual(k15({ tools }), ["tools.md repeat values: docs daily every_n_hours weekdays vs code daily every_n_hours weekdays weekly"]);
});

test("K15: `repeat: quota_resets` fails", () => {
  const page = edit(PAGE, "`repeat: quota_reset`", "`repeat: quota_resets`");
  assert.deepEqual(k15({ page }), ["`repeat: quota_resets` is not a repeat value"]);
});

test("K15: a 2 to 336 range fails in the parameter row and the cadence table", () => {
  const page = PAGE.replaceAll("2 to 168", "2 to 336");
  assert.notEqual(page, PAGE);
  assert.deepEqual(k15({ page }), ["every_hours row does not say 2 to 168", "jobs.md cadence table does not say N from 2 to 168"]);
});

test("K15: a missing every-N-hours guarantee sentence fails", () => {
  const page = edit(PAGE, "- `runs at least every 6 h, never sooner than 3 h after the last run`\n", "");
  assert.deepEqual(k15({ page }), ["jobs.md quotes no guarantee sentence for: every N hours"]);
});

test("K15: a tools page without the `repeat` set to ... creates sentence fails", () => {
  const tools = edit(TOOLS, "with `repeat` set to `daily`, `weekdays`, `weekly` or `every_n_hours` creates a job", "queues a task");
  assert.deepEqual(k15({ tools }), ['tools.md has no "`repeat` set to ... creates" list']);
});

test("K15: a renamed every N hours cadence row fails", () => {
  const page = edit(PAGE, "| every N hours |", "| Every N hours |");
  assert.deepEqual(k15({ page }), ['jobs.md cadence table has no "every N hours" row']);
});

test("K15: a quoted guarantee sentence that differs from guaranteeText fails", () => {
  const page = edit(PAGE, "never sooner than 3 h", "never sooner than 2 h");
  assert.deepEqual(k15({ page }), [
    'quoted "runs at least every 6 h, never sooner than 2 h after the last run" vs guaranteeText "runs at least every 6 h, never sooner than 3 h after the last run"',
  ]);
});

test("K15: a trailing space after the row pipe and a backticked cross-reference in the repeat row pass", () => {
  let page = edit(PAGE, "| IANA zone. |", "| IANA zone. | ");
  page = edit(page, "or `every_n_hours`. |", "or `every_n_hours`. For `weekly`, set `days`. |");
  assert.deepEqual(k15({ page }), []);
});

// The jobs page sentences each K16 claim reads, as the page words them.
const LIMITS = `Output is capped (10 MiB); errors keep their last 4 KiB. The time limit is 5 minutes by default.

The LLM step reads the scrubbed output (the last 200 KiB) with a prompt you write.

The scrub matches exact values (at least 4 characters).

Each run has caps: a command time limit (5 minutes), an LLM time limit (10 minutes), an LLM budget (1 USD) and an output cap.

A failed run gets one retry 30 minutes later. After three failed slots in a row, the job pauses.

The page's API takes at most 60 job writes (create, edit, remove) and 20 previews per minute for each token.
`;
const LIMIT_CODE = {
  core: {
    DEFAULT_JOB_CAPS: {
      commandTimeoutMs: 5 * 60_000,
      llmTimeoutMs: 10 * 60_000,
      maxBudgetUsd: 1,
      outputCapBytes: 10 * 1024 ** 2,
      summarizeInputCapBytes: 200 * 1024,
    },
    JOB_RETRY_DELAY_MS: 30 * 60_000,
    JOB_AUTO_PAUSE_FAILURES: 3,
    SCRUB_MIN_LENGTH: 4,
  },
  api: { JOB_WRITES_PER_MINUTE: 60, JOB_PREVIEWS_PER_MINUTE: 20 },
  shell: { STDERR_TAIL_BYTES: 4 * 1024 },
};
const k16 = ({ page = LIMITS, core = LIMIT_CODE.core, api = LIMIT_CODE.api, shell = LIMIT_CODE.shell } = {}) =>
  jobLimitProblems({ page, pageName: "jobs.md", core, api, shell });

test("K16: every claim present and equal passes", () => {
  assert.deepEqual(k16(), []);
});

test("K16: a changed number gives docs N vs code M", () => {
  const page = edit(LIMITS, "one retry 30 minutes", "one retry 45 minutes");
  assert.deepEqual(k16({ page }), ["retry delay (minutes): docs 45 vs code 30"]);
});

test("K16: a second statement of the same limit that disagrees fails", () => {
  const page = edit(LIMITS, "command time limit (5 minutes)", "command time limit (6 minutes)");
  assert.deepEqual(k16({ page }), ["command time limit (minutes): docs 6 vs code 5"]);
});

test("K16: a deleted claim does not state it", () => {
  const page = edit(LIMITS, " and 20 previews per minute", "");
  assert.deepEqual(k16({ page }), ["jobs.md does not state the previews per minute (20)"]);
});

test("K16: a missing or non-positive code value gives code has no ...", () => {
  assert.deepEqual(k16({ api: { JOB_WRITES_PER_MINUTE: 60 } }), ["code has no previews per minute"]);
  assert.deepEqual(k16({ core: { ...LIMIT_CODE.core, JOB_AUTO_PAUSE_FAILURES: 0 } }), ["code has no auto-pause failed slots"]);
});

test("K16: number words parse", () => {
  assert.deepEqual(k16({ page: edit(LIMITS, "at least 4 characters", "at least four characters") }), []);
  assert.deepEqual(k16({ page: edit(LIMITS, "After three failed", "After four failed") }), ["auto-pause failed slots: docs 4 vs code 3"]);
});

test("K16: the stderr tail claim reads 'errors keep their last 4 KiB' as 4", () => {
  assert.deepEqual(k16({ shell: { STDERR_TAIL_BYTES: 8 * 1024 } }), ["stderr tail (KiB): docs 4 vs code 8"]);
  assert.deepEqual(k16({ shell: {} }), ["code has no stderr tail (KiB)"]);
});

test("K16: a stated 8 KiB stderr tail against a code value of 4 KiB fails", () => {
  const page = edit(LIMITS, "errors keep their last 4 KiB", "errors keep their last 8 KiB");
  assert.deepEqual(k16({ page }), ["stderr tail (KiB): docs 8 vs code 4"]);
});

test("K16: the stderr tail and the summarize input claims do not read each other's sentence", () => {
  const noTail = edit(LIMITS, "; errors keep their last 4 KiB", "");
  assert.deepEqual(k16({ page: noTail }), ["jobs.md does not state the stderr tail (KiB) (4)"]);
  const noSummarize = edit(LIMITS, " (the last 200 KiB)", "");
  assert.deepEqual(k16({ page: noSummarize }), ["jobs.md does not state the summarize input (KiB) (200)"]);
});

const FILES = [
  ["jobs.md", '"Every night" is `daily` with the window `22:00-08:00`. It can cross midnight: `22:00-06:00`.'],
  ["defer.md", 'Say "every night" with no hours: offer `22:00-08:00`.'],
  ["SKILL.md", "Every night: `tidegap defer --repeat daily --window 22:00-08:00 <task>`."],
];
const k17 = ({ core = CORE, files = FILES } = {}) => nightWindowProblems({ core, files });

test("K17: one window everywhere passes", () => {
  assert.deepEqual(k17(), []);
});

test("K17: a different window in one source fails and names it", () => {
  const files = [...FILES.slice(0, 1), ["defer.md", 'Say "every night" with no hours: offer `23:00-07:00`.'], ...FILES.slice(2)];
  assert.deepEqual(k17({ files }), ["defer.md: night window 23:00-07:00 vs schedule_task 22:00-08:00"]);
});

test("K17: a --daily --window copy-paste command with a different window fails", () => {
  const core = { ...CORE, AGENTS_BLOCK: 'For "every night", run this.\n\n```\ntidegap defer --daily --window 01:00-05:00 "<task>"\n```' };
  assert.deepEqual(k17({ core }), ["core AGENTS_BLOCK: night window 01:00-05:00 vs schedule_task 22:00-08:00"]);
});

test("K17: a source with no night window fails", () => {
  const files = [...FILES.slice(0, 2), ["SKILL.md", "Recurring work: ask for the hours."]];
  assert.deepEqual(k17({ files }), ["SKILL.md names no night window"]);
});

test('K17: tool text without the "every night" sentence fails', () => {
  const [tool] = CORE.TOOL_SURFACE;
  const params = tool.params.map((p) => (p.name === "repeat" ? { ...p, description: "A job." } : p));
  const core = { ...CORE, TOOL_SURFACE: [{ ...tool, params }] };
  assert.deepEqual(k17({ core }), [
    `schedule_task text has no "every night" is 'daily' with window 'HH:MM-HH:MM'`,
    "schedule_task text names no night window",
  ]);
});
