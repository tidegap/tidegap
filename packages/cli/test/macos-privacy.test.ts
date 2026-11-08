import { formatDuration } from "@tidegap/core";
import { describe, expect, it } from "vitest";

import { commandHintApplies, formatQuiet, MACOS_PRIVACY_HINT, privacyNextStep, type CommandHintInput } from "../src/providers/macos-privacy.js";

const S = 1000;
const MIN = 60 * S;
const base: CommandHintInput = { platform: "darwin", timedOut: true, quietMs: 0, limitMs: 5 * MIN, noStderr: true, cwd: "/srv/app", command: "./sync.sh" };
const applies = (over: Partial<CommandHintInput>) => commandHintApplies({ ...base, ...over });

describe("the hint rule (KTD6)", () => {
  it("darwin, a time-limit stop: quiet for the final 2 minutes gets the hint", () => {
    expect(applies({ quietMs: 150 * S })).toBe(true);
    expect(applies({ quietMs: 90 * S })).toBe(false);
  });

  it("a limit under 2 minutes: quiet for the whole limit is enough", () => {
    expect(applies({ limitMs: 60 * S, quietMs: 60 * S })).toBe(true);
  });

  it("other platforms and other stops get no hint", () => {
    expect(applies({ platform: "linux", quietMs: 300 * S })).toBe(false);
    expect(applies({ timedOut: false, quietMs: 300 * S })).toBe(false);
  });

  it("today's path rule stays a second trigger: no stderr and a protected folder in the cwd or the command", () => {
    expect(applies({ quietMs: 90 * S, cwd: "~/Documents/repo" })).toBe(true);
    expect(applies({ quietMs: 90 * S, command: "git -C $HOME/Desktop/x fetch" })).toBe(true);
    expect(applies({ quietMs: 90 * S, cwd: "~/Documents/repo", noStderr: false })).toBe(false);
    expect(applies({ quietMs: 90 * S, cwd: "~/DocumentsOld" })).toBe(false);
  });
});

describe("the texts (KTD8)", () => {
  it("the first line fits in 140 characters for a 5-minute and a 2-hour limit and states a condition", () => {
    for (const [limit, quiet] of [
      [5 * MIN, 4 * MIN + 30 * S],
      [120 * MIN, 119 * MIN + 59 * S],
    ] as const) {
      const first = `stopped: command time limit ${formatDuration(limit)}; no output for ${formatQuiet(quiet)} (${MACOS_PRIVACY_HINT})`;
      expect(first.length).toBeLessThanOrEqual(140);
      expect(first).toContain("Files & Folders");
    }
    expect(MACOS_PRIVACY_HINT).toMatch(/\bif it reads a protected folder\b/);
  });

  it("the quiet time is its two largest units", () => {
    expect(formatQuiet(0)).toBe("0s");
    expect(formatQuiet(45 * S)).toBe("45s");
    expect(formatQuiet(4 * MIN + 30 * S)).toBe("4m 30s");
    expect(formatQuiet(2 * MIN)).toBe("2m");
    expect(formatQuiet(119 * MIN + 59 * S)).toBe("1h 59m");
    expect(formatQuiet(51 * 60 * MIN)).toBe("2d 3h");
  });

  it("the next step names the node path with ~ for the home folder", () => {
    const line = privacyNextStep("/Users/someone/.nvm/versions/node/v22/bin/node", "/Users/someone");
    expect(line).toBe(
      "System Settings › Privacy & Security › Files & Folders: allow ~/.nvm/versions/node/v22/bin/node, or keep the folder outside ~/Documents, ~/Desktop and ~/Downloads.",
    );
    expect(privacyNextStep("/opt/homebrew/bin/node", "/Users/someone")).toContain("allow /opt/homebrew/bin/node,");
  });
});
