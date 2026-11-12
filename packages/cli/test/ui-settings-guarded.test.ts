/**
 * The page server refuses a settings or secrets file that links into a
 * folder macOS guards (`~/Documents` here), so it never waits on a privacy
 * prompt. The fake home is the test home; Linux runs pass `darwin`.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { carbonBudgetConfigPath, mockGridFeed } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { channelSecretsPath } from "../src/channels/secrets.js";
import { envFilePath } from "../src/commands/env-file.js";
import { actionScheduler, quotaConfigUnlessGuarded } from "../src/commands/queue.js";
import { readEnvCredentials } from "../src/env.js";
import { readHostLimits } from "../src/usage/host.js";
import { jobSecretsPath } from "../src/jobs/secrets.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";

const PAGE = "page-token-0123456789";
const GUARDED = /links into ~\/Documents, a folder macOS guards with a privacy prompt, so Tidegap does not open it here\. Move the file back to ~\/\S+, or remove the link\.$/;

describe("the page server and a settings file linked into ~/Documents", () => {
  let home: string;
  let ui: UiServer;
  /** Where each link points: inside ~/Documents, and never created. */
  const target = (name: string) => join(home, "Documents", "tidegap", name);
  const link = (file: string) => {
    mkdirSync(join(file, ".."), { recursive: true });
    symlinkSync(target(file.split("/").pop()!), file);
  };
  const documentsUntouched = () => expect(readdirSync(join(home, "Documents"))).toEqual([]);

  const start = (platform: NodeJS.Platform) =>
    startUiServer({
      token: PAGE,
      dbPath: join(home, "queue.db"),
      stateDir: home,
      assetDir: home,
      feed: mockGridFeed(),
      defaultRegion: "FR",
      region: { env: undefined, timeZone: "Europe/Paris", guard: { home, platform } },
      quota: () => ({}),
      daemonStatus: () => "unknown",
      guard: { home, platform },
      integrations: { platform: "linux", home, installListener: () => {}, guard: { home, platform } },
    });

  beforeEach(async () => {
    home = homedir();
    mkdirSync(join(home, "Documents"), { recursive: true });
    ui = await start("darwin");
  });
  afterEach(async () => {
    await ui.close();
    for (const f of [carbonBudgetConfigPath(), envFilePath(), channelSecretsPath(), jobSecretsPath()]) rmSync(f, { force: true });
    rmSync(join(home, "Documents"), { recursive: true, force: true });
  });

  const api = async (path: string, json?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${PAGE}` };
    if (json !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${ui.url}api/${path}`, { method: json === undefined ? "GET" : "POST", headers, body: json === undefined ? undefined : JSON.stringify(json) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("GET /api/settings/region with a linked config answers 409 guarded_folder naming ~/Documents; the region falls back", async () => {
    link(carbonBudgetConfigPath());
    // Were the link followed, the stored setting would be DE.
    mkdirSync(join(home, "Documents", "tidegap"));
    writeFileSync(target("config"), "TIDEGAP_DEFAULT_REGION=DE\n");
    const res = await api("settings/region");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("guarded_folder");
    expect(res.body.error).toMatch(/^~\/\.tidegap\/config /);
    expect(res.body.error).toMatch(GUARDED);
    expect((await api("settings/region", { zone: "DE" })).status).toBe(409);
    expect((await api("settings/limits")).status).toBe(409);
    // The status read skips the stored setting and uses the next source.
    expect((await api("status")).body).toMatchObject({ default_region: "FR", region_source: "timezone" });
    expect(lstatSync(carbonBudgetConfigPath()).isSymbolicLink()).toBe(true);
    expect(readFileSync(target("config"), "utf8")).toBe("TIDEGAP_DEFAULT_REGION=DE\n");
  });

  it("GET /api/jobs/secrets with a linked job secrets file answers 409 and reads nothing", async () => {
    link(jobSecretsPath());
    const res = await api("jobs/secrets");
    expect([res.status, res.body.code]).toEqual([409, "guarded_folder"]);
    expect(res.body.error).toMatch(/^~\/\.config\/tidegap\/job-secrets\.json /);
    expect(res.body.error).toMatch(GUARDED);
    documentsUntouched();
  });

  it("a channel connect with a linked secrets file, and a Telegram token save with a linked env file, answer 409 and write nothing", async () => {
    link(channelSecretsPath());
    const connect = await api("integrations/channels/connect", { kind: "ntfy", fields: { topic: "tidegap-test-topic" } });
    expect([connect.status, connect.body.code]).toEqual([409, "guarded_folder"]);
    expect(connect.body.error).toMatch(/^~\/\.config\/tidegap\/channel-secrets\.json /);
    expect((await api("integrations")).status).toBe(409);
    rmSync(channelSecretsPath());
    link(envFilePath());
    const token = await api("integrations/telegram/token", { token: "123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOwXyZ" });
    expect([token.status, token.body.code]).toEqual([409, "guarded_folder"]);
    expect(token.body.error).toMatch(/^~\/\.config\/tidegap\/env /);
    expect(lstatSync(envFilePath()).isSymbolicLink()).toBe(true);
    documentsUntouched();
  });

  it("on Linux nothing is refused", async () => {
    await ui.close();
    ui = await start("linux");
    link(jobSecretsPath());
    expect(await api("jobs/secrets")).toEqual({ status: 200, body: { names: [] } });
    expect((await api("integrations")).status).toBe(200);
    expect(existsSync(target("job-secrets.json"))).toBe(false);
  });
});

describe("the page server's other readers and a config file linked into ~/Documents", () => {
  const home = homedir();
  const real = join(home, "Documents", "tidegap-config");
  beforeEach(() => {
    mkdirSync(join(home, "Documents"), { recursive: true });
    writeFileSync(real, "TIDEGAP_COMMAND_TIMEOUT=5m\nTIDEGAP_QUOTA_RESET_CLAUDE=mon 10:00 UTC\nTIDEGAP_USAGE=off\nEBB_EIA_API_KEY=x\n");
    mkdirSync(dirname(carbonBudgetConfigPath()), { recursive: true });
    symlinkSync(real, carbonBudgetConfigPath());
  });
  afterEach(() => {
    rmSync(carbonBudgetConfigPath(), { force: true });
    rmSync(join(home, "Documents"), { recursive: true, force: true });
  });

  it("quota, run limits, usage settings and the old-names notice skip it on macOS and read it elsewhere", async () => {
    for (const [platform, reads] of [["darwin", false], ["linux", true]] as const) {
      const guard = { home, platform };
      const notices: string[] = [];
      readEnvCredentials((line) => notices.push(line), guard);
      expect([platform, notices.length > 0]).toEqual([platform, reads]);
      expect([platform, "claude" in quotaConfigUnlessGuarded(guard)]).toEqual([platform, reads]);
      const scheduler = actionScheduler({ dbPath: join(home, "guarded-readers.db"), feed: mockGridFeed(), region: () => "FR", guard });
      const timeout = scheduler.runLimitsFor({ provider: "command" }).command_timeout?.source;
      scheduler.shutdown();
      expect([platform, timeout === "setting"]).toEqual([platform, reads]);
      const limits = await readHostLimits({ guard, ttlS: 0, timeoutMs: 1 });
      expect([platform, limits.status === "disabled"]).toEqual([platform, reads]);
    }
  });
});
