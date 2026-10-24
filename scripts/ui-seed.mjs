#!/usr/bin/env node
// Seed a throwaway ledger for trying `tidegap ui` (v2) by hand or in a browser
// smoke run. Writes a realistic mix relative to now: an overdue task, an
// unread failure, scheduled tasks over four days (one weekly series, one
// quota-reset series), a running and a batch-submitted task, and finished
// work with a receipt, a reply chain, a cancelled run and a task that came
// from a Claude Code session (so the detail shows the resume command).
//
//   node scripts/ui-seed.mjs            seed, print the ledger path
//   node scripts/ui-seed.mjs --serve    seed, then serve `tidegap ui` on it
//   node scripts/ui-seed.mjs --empty    an empty ledger (empty states)
//   --db <path>                         write a NEW ledger here instead of a
//                                       temp dir (refuses an existing file
//                                       and anything under ~/.tidegap)
//   --port <n>                          port for --serve
//
// --serve runs the built CLI (`pnpm build` first) with HOME pointed at the
// temp dir and provider and grid secrets removed from the environment, so
// the forecast is the synthetic mock and "Start dispatcher" can never send
// a seeded prompt to a real provider.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreEntry = join(root, "packages/core-ts/dist/index.js");
const cliEntry = join(root, "packages/cli/dist/index.js");
if (!existsSync(coreEntry) || !existsSync(cliEntry)) {
  console.error("ui-seed: build first (pnpm build).");
  process.exit(1);
}
const { TaskStore, LAST_TICK_META_KEY } = await import(pathToFileURL(coreEntry).href);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// Seed rows are throwaway prompts: they must never land in a real ledger,
// where a running dispatcher would send them to a provider.
if (option("--db")) {
  const target = resolve(option("--db"));
  // ~/.tidegap, and the 0.17 ~/.ebb-ai, which can still hold a real ledger.
  const homes = [resolve(homedir(), ".tidegap"), resolve(homedir(), ".ebb-ai")];
  const inside = homes.some((h) => {
    const rel = relative(h, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (existsSync(target) || inside) {
    console.error(`ui-seed: refusing ${target}: --db must name a new file outside ${homes.join(" and ")}.`);
    process.exit(1);
  }
}
// The temp dir holds the ledger (no --db) and the --serve HOME. Without
// --serve it stays: the printed path is for the user to open.
const dir = !option("--db") || flag("--serve") ? mkdtempSync(join(tmpdir(), "tidegap-ui-seed-")) : undefined;
const dbPath = option("--db") ? resolve(option("--db")) : join(dir, "queue.db");
mkdirSync(dirname(dbPath), { recursive: true });

const HOUR = 3_600_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
/** Local `hour`:00 on the day `days` from today. */
const at = (days, hour, minute = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};
/** `hoursAhead` from now (today unless the evening is late). */
const laterToday = (hoursAhead) => now + hoursAhead * HOUR;

const body = (provider, model, prompt, extra = {}) =>
  JSON.stringify({ type: "provider_call", provider, model, prompt, maxTokens: 1024, ...extra });

const CWD = "/Users/you/projects/tidegap";
const SESSION = "3f2a9c1e-5b7d-4e2a-9f10-6c8d2b4a7e91";

function receipt(id, { ranAt, intensity, grams, provider, model, signed = true, est }) {
  return {
    taskId: id,
    ranAt: iso(ranAt),
    region: "FR",
    estimatedCarbonGCo2: est ?? grams * 1.12,
    actualCarbonGCo2: grams,
    deltaPct: Math.round(((grams - (est ?? grams * 1.12)) / (est ?? grams * 1.12)) * 1000) / 10,
    provider,
    model,
    durationMs: 8200,
    totalTokens: 1840,
    intensityGCo2PerKwh: intensity,
    gridSource: "mock",
    ...(signed ? { signature: "seed-signature-not-real", signerPublicKey: "seed", signedAt: iso(ranAt) } : {}),
  };
}

function tasks() {
  const weekly = "seed-weekly-limits";
  const quota = "seed-quota-refactor";
  const rows = [];
  const add = (r) => rows.push({ region: "FR", enqueuedAt: iso(now - 26 * HOUR), originHost: "mcp", originCwd: CWD, ...r });

  // Needs attention: overdue (its hour passed, no tick ran) and an unread failure.
  add({
    taskId: "seed-overdue",
    status: "scheduled",
    scheduledFor: iso(now - 3 * HOUR),
    deadline: iso(now + 5 * HOUR),
    bodyJson: body("anthropic", "claude-sonnet-4-5", "Compile the weekly usage report for the team: tokens per project, cost, and the three biggest prompts."),
  });
  add({
    taskId: "seed-failed",
    status: "failed",
    scheduledFor: iso(now - 7 * HOUR),
    completedAt: iso(now - 6.5 * HOUR),
    deadline: iso(now - 5 * HOUR),
    error: "provider error: 429 rate_limit_error — Number of request tokens has exceeded your per-minute rate limit.",
    originHost: "openclaw",
    bodyJson: body("openai", "gpt-5-mini", "Summarize the unread GitHub notifications from the last two days and group them by repository."),
  });

  // Scheduled over four days.
  add({
    taskId: "seed-translate",
    status: "scheduled",
    scheduledFor: iso(laterToday(2)),
    deadline: iso(at(0, 23, 59) > now + 3 * HOUR ? at(0, 23, 59) : at(1, 12)),
    estimatedCarbonGCo2: 0.38,
    bodyJson: body("anthropic", "claude-sonnet-4-5", "Translate README.md into Ukrainian. Keep code blocks, links and headings unchanged."),
    originSessionId: SESSION,
  });
  add({
    taskId: weekly,
    seriesId: weekly,
    repeat: "weekly",
    status: "completed",
    scheduledFor: iso(at(-7, 4)),
    completedAt: iso(at(-7, 4, 2)),
    deadline: iso(at(-7, 9)),
    readAt: iso(at(-7, 9)),
    title: "Check my weekly limit list",
    result: { text: "Weekly limits:\n- Anthropic: 61% used, resets Mon 09:00\n- OpenAI: 18% used\n- Gemini: no usage" },
    receipt: receipt(weekly, { ranAt: at(-7, 4, 2), intensity: 64, grams: 0.21, provider: "anthropic", model: "claude-haiku-4-5" }),
    bodyJson: body("anthropic", "claude-haiku-4-5", "Check my weekly limit list and tell me how much of each provider's quota is left."),
  });
  add({
    taskId: `${weekly}~2`,
    seriesId: weekly,
    repeat: "weekly",
    status: "scheduled",
    scheduledFor: iso(laterToday(5)),
    deadline: iso(at(0, 23, 59) > now + 6 * HOUR ? at(0, 23, 59) : at(1, 9)),
    notBefore: iso(at(-1, 9)),
    estimatedCarbonGCo2: 0.2,
    title: "Check my weekly limit list",
    bodyJson: body("anthropic", "claude-haiku-4-5", "Check my weekly limit list and tell me how much of each provider's quota is left."),
  });
  add({
    taskId: quota,
    seriesId: quota,
    repeat: "quota_reset",
    status: "scheduled",
    deadlineKind: "quota_reset",
    quotaProvider: "claude",
    scheduledFor: iso(at(1, 3)),
    deadline: iso(at(1, 8)),
    estimatedCarbonGCo2: 0.9,
    bodyJson: body("anthropic", "claude-sonnet-4-5", "Refactor the helpers in packages/cli/src/commands/queue.ts: split rendering from IO and add tests for each renderer."),
  });
  add({
    taskId: "seed-digest",
    status: "scheduled",
    scheduledFor: iso(at(2, 14)),
    deadline: iso(at(2, 18)),
    bodyJson: body("gemini", "gemini-2.5-flash", "Write a digest of this week's carbon-intensity news for the newsletter, 200 words."),
    originHost: "library",
  });
  add({
    taskId: "seed-audit",
    status: "queued",
    scheduledFor: iso(at(3, 11)),
    deadline: iso(at(3, 20)),
    bodyJson: body("anthropic", "claude-opus-4-1", "Audit the dependency tree for packages with known CVEs and draft upgrade notes."),
  });

  // In flight.
  add({
    taskId: "seed-running",
    status: "running",
    scheduledFor: iso(now - 2 * 60_000),
    deadline: iso(now + 2 * HOUR),
    bodyJson: body("ollama", "llama3.2", "Classify the 40 open issues by area and severity."),
  });
  add({
    taskId: "seed-batch",
    status: "submitted",
    scheduledFor: iso(now - HOUR),
    deadline: iso(at(2, 9)),
    batchId: "batch_seed",
    bodyJson: body("anthropic", "claude-haiku-4-5", "Generate alt text for the 120 images in docs/images."),
  });

  // Finished.
  add({
    taskId: "seed-done",
    status: "completed",
    scheduledFor: iso(now - 4 * HOUR),
    completedAt: iso(now - 3.9 * HOUR),
    deadline: iso(now - 2 * HOUR),
    originSessionId: SESSION,
    result: {
      text:
        "Here is the release checklist for 0.17.0:\n\n1. Date the CHANGELOG heading.\n2. Bump package.json and the lockfile together.\n3. Run the full gate: build, typecheck, test, check:versions.\n4. Tag the release commit.\n5. Publish npm packages, then PyPI.\n6. Post the release notes.\n\nThe UI v2 work lands in this release, so the notes should lead with the Agenda and the Journal.",
      raw: { id: "msg_seed_1", type: "message", stop_reason: "end_turn", usage: { input_tokens: 412, output_tokens: 1428 } },
    },
    receipt: receipt("seed-done", { ranAt: now - 3.9 * HOUR, intensity: 118, grams: 0.41, provider: "anthropic", model: "claude-sonnet-4-5" }),
    bodyJson: body("anthropic", "claude-sonnet-4-5", "Draft the release checklist for tidegap 0.17.0 based on CONTRIBUTING.md."),
  });
  add({
    taskId: "seed-parent",
    status: "completed",
    scheduledFor: iso(at(-1, 3)),
    completedAt: iso(at(-1, 3, 4)),
    deadline: iso(at(-1, 9)),
    readAt: iso(at(-1, 10)),
    result: { text: "The three slowest tests are in tick.test.ts; each waits on a real 2 s timer." },
    receipt: receipt("seed-parent", { ranAt: at(-1, 3, 4), intensity: 72, grams: 0.18, provider: "anthropic", model: "claude-haiku-4-5", signed: false }),
    bodyJson: body("anthropic", "claude-haiku-4-5", "Which tests in packages/cli are the slowest, and why?"),
  });
  add({
    taskId: "seed-reply",
    parentTaskId: "seed-parent",
    status: "completed",
    scheduledFor: iso(at(-1, 11)),
    completedAt: iso(at(-1, 11, 1)),
    deadline: iso(at(-1, 12)),
    title: "Re: Which tests in packages/cli are the slowest",
    result: { text: "Use vi.useFakeTimers() in those three tests and advance by 2 s; the suite drops from 9 s to 3 s." },
    receipt: receipt("seed-reply", { ranAt: at(-1, 11, 1), intensity: 230, grams: 0.33, provider: "anthropic", model: "claude-haiku-4-5" }),
    bodyJson: body("anthropic", "claude-haiku-4-5", "How do I make them fast without changing behaviour?", {
      messages: [
        { role: "user", content: "Which tests in packages/cli are the slowest, and why?" },
        { role: "assistant", content: "The three slowest tests are in tick.test.ts; each waits on a real 2 s timer." },
      ],
    }),
  });
  add({
    taskId: "seed-cancelled",
    status: "cancelled",
    scheduledFor: iso(at(-1, 22)),
    completedAt: iso(at(-1, 18)),
    deadline: iso(at(0, 6)),
    bodyJson: body("openai", "gpt-5", "Rewrite the landing page hero copy in three tones."),
  });
  add({
    taskId: "seed-old",
    status: "completed",
    scheduledFor: iso(at(-3, 2)),
    completedAt: iso(at(-3, 2, 5)),
    deadline: iso(at(-3, 8)),
    readAt: iso(at(-3, 9)),
    originHost: "openclaw",
    result: { text: "No broken links found in docs/ (212 checked)." },
    receipt: receipt("seed-old", { ranAt: at(-3, 2, 5), intensity: 540, grams: 1.9, provider: "openai", model: "gpt-5-mini" }),
    bodyJson: body("openai", "gpt-5-mini", "Check every link in docs/ and list the broken ones."),
  });
  add({
    taskId: "seed-failed-old",
    status: "failed",
    scheduledFor: iso(at(-2, 5)),
    completedAt: iso(at(-2, 5, 1)),
    deadline: iso(at(-2, 9)),
    readAt: iso(at(-2, 9)),
    error: "provider error: 400 invalid_request_error — max_tokens is too large for this model.",
    bodyJson: body("anthropic", "claude-opus-4-1", "Write a long-form design review of the scheduler module."),
  });
  return rows;
}

const store = new TaskStore({ dbPath });
let count = 0;
if (!flag("--empty")) {
  for (const r of tasks()) {
    const { readAt, ...row } = r;
    store.upsert(row);
    if (readAt) store.markRead(row.taskId, readAt);
    count++;
  }
  // The last tick ran three hours ago: the page shows the stale-dispatcher banner.
  store.setMeta(LAST_TICK_META_KEY, iso(now - 3 * HOUR));
}
store.close();

console.log(`ui-seed: ${count} tasks in ${dbPath}`);
if (!flag("--serve")) {
  console.log(`Try it:  node scripts/ui-seed.mjs --serve   (mock forecast, provider secrets stripped)`);
  console.log(`   or:   tidegap ui --db ${dbPath}   (your real environment: Start dispatcher would use your provider keys)`);
  process.exit(0);
}

// Serve with a scrubbed environment: no provider or grid secrets, HOME in
// the temp dir (no ~/.tidegap/.env, no installed daemon, logs stay here).
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/API_KEY|TOKEN|SECRET|PASSWORD|WATTTIME|ELECTRICITY|EIA_|OLLAMA|EBB_|TIDEGAP_/i.test(k)),
);
env.HOME = join(dir, "home");
mkdirSync(env.HOME, { recursive: true });
const argv = [cliEntry, "ui", "--no-open", "--db", dbPath, "--region", "FR"];
if (option("--port")) argv.push("--port", option("--port"));
const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "inherit", "inherit"] });
const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// A served seed is throwaway: the temp dir goes with the server.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
child.on("exit", (code) => process.exit(code ?? 0));
