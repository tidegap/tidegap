/** `tidegap usage` and `tidegap usage hook` (U4, D1). */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runUsage } from "../src/commands/usage.js";
import { writeUsageCache } from "../src/usage/index.js";
import type { FetchLike } from "../src/usage/index.js";

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
    expect(out).toMatch(/source: statusline, as of 11:58, 120 s ago|source: statusline, as of 11:58, 2 min ago/);
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
    expect(out).toMatch(/62 min ago/);
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
