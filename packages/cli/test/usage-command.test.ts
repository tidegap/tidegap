/** `tidegap usage`, `tidegap usage hook` and `tidegap usage install-hook` (U4, D1). */

import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardedCommand } from "../src/commands/statusline-setup.js";
import { runUsage, runUsageInstallHook } from "../src/commands/usage.js";
import { nodeUsageFs, writeUsageCache } from "../src/usage/index.js";
import { ago as pageAgo } from "../ui/dom.js";
import type { FetchLike, UsageFs } from "../src/usage/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "usage");
const ENTRY = join(HERE, "..", "dist", "index.js");
const NOW = new Date("2026-10-17T12:00:00.000Z");

describe("tidegap usage", () => {
  let dir: string;
  let tz: string | undefined;
  const opts = (extra: Record<string, unknown> = {}) => ({
    cachePath: join(dir, "usage.json"),
    configPath: join(dir, "config"),
    env: {},
    // Log scans (Codex, spend) read this empty home, never the real one.
    home: join(dir, "home"),
    settingsPath: join(dir, "settings.json"),
    launcher: ["/opt/node/bin/node", "/opt/tidegap/dist/index.js"],
    now: NOW,
    ...extra,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-usage-cmd-"));
    tz = process.env.TZ;
    process.env.TZ = "UTC";
    writeUsageCache(
      {
        version: 1,
        claude: {
          statusline: {
            fetched_at: "2026-10-17T11:58:00.000Z",
            data: {
              five_hour: { pct: 72, resets_at: "2026-10-17T16:30:00.000Z" },
              seven_day: { pct: 40, resets_at: "2026-10-20T09:00:00.000Z" },
              scoped: [],
            },
          },
        },
      },
      join(dir, "usage.json"),
    );
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    rmSync(dir, { recursive: true, force: true });
  });

  it("--json prints usage/v1 with both windows and the line", async () => {
    const doc = JSON.parse(await runUsage(opts({ json: true })));
    expect(doc).toMatchObject({
      schema: "usage/v1",
      claude: { status: "ok", source: "statusline", five_hour: { pct: 72 }, seven_day: { pct: 40 } },
      line: "Claude 5h: 72%, resets 16:30",
    });
  });

  it("the table shows 72% and the local reset clock", async () => {
    const out = await runUsage(opts());
    expect(out).toMatch(/^5h\s+72%\s+16:30$/m);
    expect(out).toMatch(/^7d\s+40%\s+Tue 09:00$/m);
    expect(out).toMatch(/source: statusline, as of 11:58, 2 min ago/);
  });

  it("--spend adds the spend block from the logs; without it no log is read", async () => {
    const home = join(dir, "home");
    cpSync(join(FIX, "claude-projects"), join(home, ".claude", "projects"), { recursive: true });
    const read: string[] = [];
    const fs: UsageFs = { ...nodeUsageFs, readdir: (p) => (read.push(p), nodeUsageFs.readdir(p)) };
    const plain = await runUsage(opts({ home, fs }));
    expect(plain).not.toMatch(/Claude spend/);
    expect(read.filter((p) => p.includes(".claude"))).toEqual([]);

    const out = await runUsage(opts({ home, fs, spend: true }));
    expect(out).toMatch(/^Claude spend since 11:30 \(current 5 h window; API list-price estimate, not billed\)$/m);
    expect(out).toMatch(/^total\s+in 1\.0M\s+out 1\.0M\s+cache w 1\.0M\s+r 1\.0M\s+\$14\.70$/m);
    expect(out).toMatch(/^no price for: claude-mystery-9$/m);
    const doc = JSON.parse(await runUsage(opts({ home, fs, spend: true, json: true })));
    expect(doc.claude_spend.total.cost_usd).toBe(14.7022);
  });

  it("prints the Codex windows from CODEX_HOME", async () => {
    const out = await runUsage(opts({ now: new Date("2026-05-21T22:00:00.000Z"), env: { codexHome: join(FIX, "codex-home") } }));
    expect(out).toMatch(/^Codex limits \(plus, as of 21:51\)$/m);
    expect(out).toMatch(/^5h\s+33%\s+Fri 02:01$/m);
  });

  it("the reading's age turns to days at 48 rounded hours, as on the page", async () => {
    // The cached reading is from 11:58; the age line rounds hours first, then days.
    const at = (h: number) => new Date(Date.parse("2026-10-17T11:58:00.000Z") + h * 3_600_000);
    expect(await runUsage(opts({ now: at(47.4) }))).toMatch(/, 47 h ago\)$/m);
    expect(await runUsage(opts({ now: at(47.6) }))).toMatch(/, 2 days ago\)$/m);
    expect(await runUsage(opts({ now: at(59.9) }))).toMatch(/, 3 days ago\)$/m);
  });

  it("the reading's age uses the page's words (AE6)", async () => {
    const fetchedAt = Date.parse("2026-10-17T11:58:00.000Z");
    const cases: Array<[number, string]> = [
      [20, "just now"],
      [45, "1 min ago"],
      [59 * 60, "59 min ago"],
      [80 * 60, "1 h ago"],
      [47.6 * 3600, "2 days ago"],
      [59.9 * 3600, "3 days ago"],
    ];
    for (const [s, words] of cases) {
      const now = new Date(fetchedAt + s * 1000);
      expect(pageAgo(fetchedAt, now.getTime())).toBe(words);
      expect(await runUsage(opts({ now }))).toMatch(new RegExp(`, ${words}\\)$`, "m"));
    }
  });

  it("a Codex reading under a minute old whose windows all reset prints no age", async () => {
    const codexHome = join(dir, "codex-home");
    const day = join(codexHome, "sessions", "2026", "10", "17");
    mkdirSync(day, { recursive: true });
    const readAt = "2026-10-17T11:59:30.000Z";
    const resetS = Date.parse(readAt) / 1000 - 1;
    const windowOf = (m: number) => ({ used_percent: 50, window_minutes: m, resets_at: resetS });
    writeFileSync(
      join(day, "rollout-2026-10-17T11-00-00-00000000-0000-4000-8000-000000000003.jsonl"),
      [
        { timestamp: "2026-10-17T11:00:00.000Z", type: "session_meta", payload: { id: "00000000-0000-4000-8000-000000000003" } },
        {
          timestamp: readAt,
          type: "event_msg",
          payload: { type: "token_count", info: null, rate_limits: { primary: windowOf(300), secondary: windowOf(10080) } },
        },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    const out = await runUsage(opts({ cachePath: join(dir, "none.json"), env: { codexHome } }));
    expect(out).toMatch(/^Codex limits \([^)]*\): no current reading$/m);
  });

  it("a Codex reading older than both windows prints one line with its age and no rows (AE2)", async () => {
    // The fixture's reading is from 2026-05-21 21:51; no Claude cache, so no Claude rows either.
    const out = await runUsage(
      opts({ cachePath: join(dir, "none.json"), now: new Date("2026-10-30T12:00:00.000Z"), env: { codexHome: join(FIX, "codex-home") } }),
    );
    expect(out).toMatch(/^Codex limits \(plus\): no reading for 162 days$/m);
    expect(out).not.toMatch(/^(?:5h|7d)\s/m);
    expect(out).not.toMatch(/reset since seen/);
  });

  it("no reading: the cause names install-hook, then the next step for this machine's statusLine", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "~/.claude/statusline.sh" } }));
    const lines = (await runUsage(opts({ cachePath: join(dir, "none.json") }))).split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "Claude limits: unavailable: no reading from Claude Code yet; run tidegap usage install-hook (it keeps your status line), or set TIDEGAP_USAGE_OAUTH=1 in ~/.tidegap/config",
      "Claude Code status line: not connected (your own statusLine; the hook wraps it, so it keeps working). To connect, run: /opt/node/bin/node /opt/tidegap/dist/index.js usage install-hook",
    ]);
    // A reading: no next-step line.
    expect(await runUsage(opts())).not.toMatch(/Claude Code status line/);
  });

  it("an expired token prints the cause and the last good value with its age", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("must not fetch");
    };
    const out = await runUsage(
      opts({
        now: new Date("2026-10-17T13:00:00.000Z"),
        configPath: join(FIX, "..", "..", "..", "missing-config"),
        env: { oauth: "1" },
        fetch,
        credentials: {
          platform: "linux",
          readFile: (p: string) =>
            p.endsWith(".credentials.json") ? readFileSync(join(FIX, "credentials-expired.json"), "utf8") : undefined,
        },
      }),
    );
    expect(out).toMatch(/login token expired/);
    expect(out).toMatch(/^5h\s+72%/m);
    expect(out).toMatch(/, 1 h ago\)$/m);
  });
});

describe("tidegap usage install-hook", () => {
  let dir: string;
  let path: string;
  let launcher: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-install-hook-"));
    path = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, "bin"));
    launcher = [join(dir, "bin", "node"), join(dir, "bin", "index.js")];
    for (const p of launcher) writeFileSync(p, "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (extra: { dryRun?: boolean; remove?: boolean } = {}) => runUsageInstallHook({ launcher, settingsPath: path, ...extra });
  const seed = (command?: string) =>
    writeFileSync(path, `${JSON.stringify({ model: "opus", ...(command ? { statusLine: { type: "command", command } } : {}) }, null, 2)}\n`);

  it("absent, other, legacy, connected: registered, wrapped, updated, already; exit 0", () => {
    seed();
    expect(run()).toEqual({ exitCode: 0, out: expect.stringMatching(new RegExp(`^Registered the Tidegap usage hook as the Claude Code statusLine \\(${path}\\)\\.`)) });
    seed("echo me");
    const wrapped = run();
    expect(wrapped.exitCode).toBe(0);
    expect(wrapped.out).toMatch(/^Wrapped your Claude Code statusLine in the Tidegap usage hook \(.+\); it keeps working\./);
    expect(wrapped.out).toMatch(/ Backup: .+settings\.json\.tidegap\.bak$/);
    seed(`${launcher.join(" ")} usage hook -- sh -c 'echo me'`);
    expect(run()).toMatchObject({ exitCode: 0, out: expect.stringMatching(/^Updated the Tidegap usage hook/) });
    expect(JSON.parse(readFileSync(path, "utf8")).statusLine.command).toBe(guardedCommand(launcher, "echo me"));
    expect(run()).toMatchObject({ exitCode: 0, out: expect.stringMatching(/^Already registered/) });
  });

  it("--dry-run prints the state and the command it would store; the file bytes do not change", () => {
    seed("echo me");
    const bytes = readFileSync(path);
    expect(run({ dryRun: true })).toEqual({ exitCode: 0, out: `statusLine in ${path}: other\nwould store: ${guardedCommand(launcher, "echo me")}` });
    expect(readFileSync(path).equals(bytes)).toBe(true);
    run();
    expect(run({ dryRun: true })).toEqual({ exitCode: 0, out: `statusLine in ${path}: connected\nnothing to change` });
  });

  it("--remove after a wrap restores the seed; a second --remove says there is no hook", () => {
    seed("printf '%s' \"it's $HOME\"");
    const before = readFileSync(path, "utf8");
    run();
    expect(run({ remove: true })).toMatchObject({ exitCode: 0, out: expect.stringMatching(/^Removed the Tidegap usage hook from .+; your own statusLine command is back\./) });
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(run({ remove: true })).toEqual({ exitCode: 0, out: `No Tidegap usage hook in ${path}; nothing to remove.` });
  });

  it("an unreadable file: exit 1 and the file is unchanged, for register, --dry-run and --remove", () => {
    writeFileSync(path, "{ // comment\n}");
    for (const extra of [{}, { dryRun: true }, { remove: true }]) {
      const r = run(extra);
      expect(r.exitCode).toBe(1);
      expect(r.out).toMatch(/is not valid JSON/);
      expect(readFileSync(path, "utf8")).toBe("{ // comment\n}");
    }
  });

  it.skipIf(process.getuid?.() === 0)("a write that fails: exit 1, one line with the errno code, the file unchanged", () => {
    seed("echo me");
    const bytes = readFileSync(path);
    chmodSync(dirname(path), 0o500);
    try {
      expect(run()).toEqual({ exitCode: 1, out: `Tidegap could not update ${path} (EACCES); it is unchanged.` });
    } finally {
      chmodSync(dirname(path), 0o700);
    }
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});

describe.skipIf(!existsSync(ENTRY))("tidegap usage hook (built CLI)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tidegap-usage-hook-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const env = () => {
    const e: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home };
    return e;
  };

  it("records rate_limits and prints nothing", () => {
    const r = spawnSync(process.execPath, [ENTRY, "usage", "hook"], {
      input: readFileSync(join(FIX, "statusline-input.json")),
      env: env(),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const path = join(home, ".tidegap", "usage.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).claude.statusline.data.five_hour.pct).toBe(72);
  });

  it("after --, runs the wrapped statusline command with the same stdin", () => {
    const r = spawnSync(
      process.execPath,
      [ENTRY, "usage", "hook", "--", process.execPath, "-e", "process.stdout.write('wrapped:' + JSON.parse(require('fs').readFileSync(0)).session_id)"],
      { input: readFileSync(join(FIX, "statusline-input.json")), env: env(), encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("wrapped:s-1");
  });
});
