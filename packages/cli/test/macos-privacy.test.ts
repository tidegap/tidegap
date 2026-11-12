import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatDuration } from "@tidegap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commandHintApplies,
  formatQuiet,
  guardedFolder,
  GuardedFolderError,
  guardedLinkError,
  MACOS_PRIVACY_HINT,
  privacyNextStep,
  type CommandHintInput,
} from "../src/providers/macos-privacy.js";

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

describe("a settings file linked into a guarded folder", () => {
  let root: string;
  let home: string;
  let config: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-guarded-")));
    home = join(root, "home");
    mkdirSync(join(home, ".tidegap"), { recursive: true });
    mkdirSync(join(home, "Documents", "tg"), { recursive: true });
    config = join(home, ".tidegap", "config");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const darwin = () => ({ home, platform: "darwin" as const });

  it("a link chain into ~/Documents names Documents; a link elsewhere and a plain file name nothing", () => {
    writeFileSync(join(home, "Documents", "tg", "config"), "");
    symlinkSync(join(home, "Documents", "tg", "config"), join(home, ".tidegap", "hop"));
    symlinkSync("hop", config);
    expect(guardedFolder(config, darwin())).toBe("Documents");
    rmSync(config);
    mkdirSync(join(home, "notes"));
    symlinkSync(join(home, "notes", "config"), config);
    expect(guardedFolder(config, darwin())).toBeUndefined();
    rmSync(config);
    writeFileSync(config, "");
    expect(guardedFolder(config, darwin())).toBeUndefined();
  });

  it("never opens the target: a link to a missing file in ~/Documents still names Documents", () => {
    symlinkSync(join(home, "Documents", "gone", "config"), config);
    expect(guardedFolder(config, darwin())).toBe("Documents");
  });

  it("a linked folder on the way counts, and iCloud Drive is guarded too", () => {
    rmSync(join(home, ".tidegap"), { recursive: true });
    mkdirSync(join(home, "Library", "Mobile Documents", "tg"), { recursive: true });
    symlinkSync(join(home, "Library", "Mobile Documents", "tg"), join(home, ".tidegap"));
    expect(guardedFolder(config, darwin())).toBe("Library/Mobile Documents");
  });

  it("a home behind a symlink still matches", () => {
    const linkedHome = join(root, "linked-home");
    symlinkSync(home, linkedHome);
    symlinkSync(join(home, "Documents", "tg", "config"), config);
    expect(guardedFolder(join(linkedHome, ".tidegap", "config"), { home: linkedHome, platform: "darwin" })).toBe("Documents");
  });

  it("only on macOS", () => {
    symlinkSync(join(home, "Documents", "tg", "config"), config);
    expect(guardedFolder(config, { home, platform: "linux" })).toBeUndefined();
  });

  it("the refusal names the file, the folder and the fix", () => {
    symlinkSync(join(home, "Documents", "tg", "config"), config);
    const err = guardedLinkError([join(home, ".tidegap", "other"), config], darwin());
    expect(err).toBeInstanceOf(GuardedFolderError);
    expect((err as GuardedFolderError).code).toBe("guarded_folder");
    expect((err as Error).message).toBe(
      "~/.tidegap/config links into ~/Documents, a folder macOS guards with a privacy prompt, so Tidegap does not open it here. " +
        "Move the file back to ~/.tidegap, or remove the link.",
    );
    expect(guardedLinkError([join(home, ".tidegap", "other")], darwin())).toBeUndefined();
  });
});
