/**
 * The handoff rules: where a result or output file may go, which folder a
 * handed-off run may work in, and what a tool profile means. Most cases use
 * an injected file system; each rule also runs once against a real
 * temporary folder with a link in it.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handoffCwdError,
  outputPathError,
  profileTools,
  resultPathError,
  type HandoffFs,
  type HandoffFsEntry,
} from "../src/index.js";

type Node = "dir" | "file" | { link: string } | { dir: true; uid: number } | { file: true; uid: number };

const UID = 501;

/** A file system from a path map. Links resolve one segment at a time, like realpath. */
function fakeFs(nodes: Record<string, Node>): HandoffFs {
  const at = (p: string): Node | undefined => (p === "/" ? "dir" : nodes[p]);
  const realpath = (path: string, depth = 0): string | undefined => {
    if (depth > 20) return undefined;
    let out = "";
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const next = `${out}/${parts[i]}`;
      const node = at(next);
      if (node === undefined) return undefined;
      if (typeof node === "object" && "link" in node) {
        const target = realpath(node.link, depth + 1);
        if (!target) return undefined;
        out = target === "/" ? "" : target;
      } else {
        out = next;
      }
    }
    return out === "" ? "/" : out;
  };
  return {
    realpath: (p) => realpath(p),
    lstat(p): HandoffFsEntry | undefined {
      const node = at(p);
      if (node === undefined) return undefined;
      if (node === "dir") return { kind: "dir", uid: UID };
      if (node === "file") return { kind: "file", uid: UID };
      if ("link" in node) return { kind: "symlink", uid: UID };
      return { kind: "dir" in node ? "dir" : "file", uid: node.uid };
    },
  };
}

const HOME = "/home/u";
const fs = fakeFs({
  "/home": "dir",
  "/home/u": "dir",
  "/home/u/.ssh": "dir",
  "/home/u/.aws": "dir",
  "/home/u/.config": "dir",
  "/home/u/.config/app": "dir",
  "/home/u/.tidegap": "dir",
  "/home/u/Library": "dir",
  "/home/u/Library/LaunchAgents": "dir",
  "/home/u/.zshrc": "file",
  "/home/u/repo": "dir",
  "/home/u/repo/.git": "dir",
  "/home/u/repo/.git/hooks": "dir",
  "/home/u/repo/.hidden": "dir",
  "/home/u/repo/.worktrees": "dir",
  "/home/u/repo/.worktrees/feat-x": "dir",
  "/home/u/repo/out": "dir",
  "/home/u/repo/out/old.txt": "file",
  "/home/u/repo/out/link.txt": { link: "/home/u/.zshrc" },
  "/home/u/repo/sshlink": { link: "/home/u/.ssh" },
  "/home/u/repo/notmine.json": { file: true, uid: 777 },
  "/home/u/app": "dir",
  "/home/u/foreign": { dir: true, uid: 777 },
  "/home/u/somefile": "file",
  "/private": "dir",
  "/private/tmp": "dir",
  "/tmp": { link: "/private/tmp" },
  "/elsewhere": "dir",
});
const ctx = { cwd: "/home/u/repo", originCwd: "/home/u/app", home: HOME, tmpDirs: ["/tmp"], fs, uid: UID };

describe("resultPathError", () => {
  it("accepts a new file under the task cwd, under the origin project dir and under the temp folder", () => {
    expect(resultPathError("/home/u/repo/result.md", ctx)).toBeUndefined();
    expect(resultPathError("/home/u/repo/out/new.txt", ctx)).toBeUndefined();
    expect(resultPathError("/home/u/app/result.md", ctx)).toBeUndefined();
    expect(resultPathError("/tmp/result.md", ctx)).toBeUndefined();
  });

  it("accepts /tmp/x on a system where /tmp is a symlink to /private/tmp", () => {
    expect(resultPathError("/tmp/x", { ...ctx, cwd: undefined, originCwd: undefined })).toBeUndefined();
    expect(resultPathError("/private/tmp/x", { ...ctx, cwd: undefined, originCwd: undefined })).toBeUndefined();
  });

  it("accepts a file inside a worktree under a dot folder when that worktree is the task cwd", () => {
    expect(resultPathError("/home/u/repo/.worktrees/feat-x/r.md", { ...ctx, cwd: "/home/u/repo/.worktrees/feat-x" })).toBeUndefined();
  });

  it("refuses a relative path, .. segments, a missing parent, a dot segment below the root, and an existing target", () => {
    expect(resultPathError("result.md", ctx)).toMatch(/absolute path/);
    expect(resultPathError("/home/u/repo/out/../x.md", ctx)).toMatch(/no "\." or "\.\." segments/);
    expect(resultPathError("/home/u/repo//x.md", ctx)).toMatch(/repeated or trailing/);
    expect(resultPathError("/home/u/repo/missing/x.md", ctx)).toMatch(/folder \/home\/u\/repo\/missing does not exist/);
    expect(resultPathError("/home/u/repo/.hidden/x.md", ctx)).toMatch(/may start with "\."/);
    expect(resultPathError("/home/u/repo/.env", ctx)).toMatch(/may start with "\."/);
    expect(resultPathError("/home/u/repo/out/old.txt", ctx)).toMatch(/already exists/);
    expect(resultPathError("/home/u/repo/out/link.txt", ctx)).toMatch(/already exists/);
    expect(resultPathError(`/tmp/${"a".repeat(1100)}`, ctx)).toMatch(/longer than 1024/);
    expect(resultPathError("/tmp/a\nb", ctx)).toMatch(/control characters/);
    expect(resultPathError(42, ctx)).toMatch(/absolute path/);
  });

  it("refuses ~/.zshrc, ~/Library/LaunchAgents/x.plist and a path outside every root", () => {
    expect(resultPathError("/home/u/.zshrc", ctx)).toMatch(/must be inside one of these folders: \/home\/u\/repo, \/home\/u\/app, \/tmp/);
    expect(resultPathError("/home/u/Library/LaunchAgents/x.plist", ctx)).toMatch(
      /inside \/home\/u\/Library, a protected folder; allowed folders: \/home\/u\/repo, \/home\/u\/app, \/tmp$/,
    );
    expect(resultPathError("/elsewhere/x.md", ctx)).toMatch(/must be inside one of these folders/);
    expect(resultPathError("/home/u/.tidegap/queue.md", { ...ctx, cwd: HOME })).toMatch(/\.tidegap, a protected folder/);
    expect(resultPathError("/home/u/.config/app/x", { ...ctx, cwd: "/home/u/.config" })).toMatch(/\.config, a protected folder/);
    expect(resultPathError("/home/u/repo/.git/hooks/pre-commit", ctx)).toMatch(/a \.git folder, a protected folder/);
  });

  it("refuses a parent whose real path is inside ~/.ssh (a symlinked folder)", () => {
    expect(resultPathError("/home/u/repo/sshlink/authorized_keys2", ctx)).toMatch(/inside \/home\/u\/\.ssh, a protected folder/);
  });
});

describe("outputPathError", () => {
  it("applies rules 1 to 3 and allows overwriting a regular file the user owns", () => {
    expect(outputPathError("/home/u/repo/out/old.txt", ctx)).toBeUndefined();
    expect(outputPathError("/tmp/digest.json", ctx)).toBeUndefined();
    expect(outputPathError("relative.json", ctx)).toMatch(/absolute path/);
    expect(outputPathError("/home/u/repo/.hidden/x.json", ctx)).toMatch(/may start with "\."/);
    expect(outputPathError("/home/u/.zshrc", ctx)).toMatch(/must be inside/);
    expect(outputPathError("/home/u/Library/LaunchAgents/x.plist", { ...ctx, cwd: HOME })).toMatch(/protected folder/);
    expect(outputPathError("/home/u/repo/missing/x.json", ctx)).toMatch(/does not exist/);
  });

  it("refuses a link at the path and a file another user owns", () => {
    expect(outputPathError("/home/u/repo/out/link.txt", ctx)).toMatch(/not a regular file you own/);
    expect(outputPathError("/home/u/repo/notmine.json", ctx)).toMatch(/not a regular file you own/);
    expect(outputPathError("/home/u/repo/out", ctx)).toMatch(/not a regular file you own/);
  });
});

describe("another spelling of a folder, and the roots", () => {
  // `/data/home/u` is another name of `/home/u` (a firmlink such as
  // `/System/Volumes/Data` on macOS): the same folder, not a link, so only
  // its identity tells. `/home/u/LIBRARY` is `~/Library` on a disk that
  // ignores letter case.
  const nodes: Record<string, Node> = {
    "/home": "dir",
    "/home/u": "dir",
    "/home/u/.ssh": "dir",
    "/home/u/.tidegap": "dir",
    "/home/u/.tidegap/config.json": "file",
    "/home/u/LIBRARY": "dir",
    "/home/u/LIBRARY/LaunchAgents": "dir",
    "/home/u/docs": "dir",
    "/home/u/docs/thesis.json": "file",
    "/home/u/repo": "dir",
    "/home/u/repo/.GIT": "dir",
    "/data": "dir",
    "/data/home": "dir",
    "/data/home/u": "dir",
    "/data/home/u/.ssh": "dir",
    "/data/home/u/.tidegap": "dir",
    "/data/home/u/.tidegap/config.json": "file",
    "/private": "dir",
    "/private/tmp": "dir",
    "/private/tmp/shared": { dir: true, uid: 777 },
    "/private/tmp/mine": "dir",
    "/tmp": { link: "/private/tmp" },
  };
  const base = fakeFs(nodes);
  const canonical = (p: string): string =>
    p.replace(/^\/data\/home\/u(?=\/|$)/, "/home/u").replace(/^\/home\/u\/LIBRARY(?=\/|$)/, "/home/u/Library").replace(/\/\.GIT(?=\/|$)/, "/.git");
  const aliasFs: HandoffFs = { ...base, identity: (p) => (p === "/" || base.lstat(p) ? canonical(p) : undefined) };
  const opts = { home: HOME, fs: aliasFs, uid: UID };
  const at = (cwd: string | undefined, originCwd?: string) => ({ ...opts, cwd, originCwd, tmpDirs: ["/tmp"] });

  it("refuses a claude-code cwd that is another spelling of home, a home dot folder, ~/Library or .git", () => {
    expect(handoffCwdError("/data/home/u", "claude-code", opts)).toMatch(/root or home folder/);
    expect(handoffCwdError("/data/home/u/.ssh", "claude-code", opts)).toMatch(/\.ssh, a protected folder/);
    expect(handoffCwdError("/home/u/LIBRARY/LaunchAgents", "claude-code", opts)).toMatch(/LIBRARY, a protected folder/);
    expect(handoffCwdError("/home/u/repo/.GIT", "claude-code", opts)).toMatch(/\.git folder/);
    // Without identity reads, the letter case alone still counts.
    expect(handoffCwdError("/home/u/LIBRARY/LaunchAgents", "claude-code", { ...opts, fs: base })).toMatch(/protected folder/);
  });

  it("refuses result and output paths in another spelling of a protected folder", () => {
    expect(resultPathError("/data/home/u/.ssh/authorized_keys", at("/data/home/u/.ssh"))).toMatch(/\/home\/u\/\.ssh, a protected folder/);
    expect(resultPathError("/home/u/LIBRARY/LaunchAgents/x.plist", at("/home/u/LIBRARY/LaunchAgents"))).toMatch(
      /\/home\/u\/Library, a protected folder/,
    );
    expect(outputPathError("/data/home/u/.tidegap/config.json", at("/data/home/u/.tidegap"))).toMatch(/\.tidegap, a protected folder/);
  });

  it("never takes / or the home folder, in any spelling, as an allowed folder", () => {
    expect(outputPathError("/home/u/docs/thesis.json", at(undefined, HOME))).toMatch(/must be inside one of these folders: \/tmp$/);
    expect(outputPathError("/home/u/docs/thesis.json", at(undefined, "/data/home/u"))).toMatch(/must be inside one of these folders: \/tmp$/);
    expect(resultPathError("/home/u/docs/new.json", at("/", "/"))).toMatch(/must be inside one of these folders: \/tmp$/);
    expect(resultPathError("/home/u/docs/new.json", at("/home/u/docs"))).toBeUndefined();
  });

  it("refuses a result folder below the allowed folder that another user owns", () => {
    expect(resultPathError("/tmp/shared/out.txt", at(undefined))).toMatch(/\/private\/tmp\/shared is not a folder you own/);
    expect(outputPathError("/tmp/shared/out.json", at(undefined))).toMatch(/not a folder you own/);
    expect(resultPathError("/tmp/mine/out.txt", at(undefined))).toBeUndefined();
  });
});

describe("profileTools", () => {
  it("maps read, web and none; cwd alone means read; web with cwd is refused", () => {
    expect(profileTools("read", undefined)).toEqual({ profile: "read", tools: ["Read", "Grep", "Glob"] });
    expect(profileTools("web", undefined)).toEqual({ profile: "web", tools: ["WebSearch", "WebFetch"] });
    expect(profileTools("none", "/w")).toEqual({ profile: "none", tools: [] });
    expect(profileTools(undefined, "/w")).toEqual({ profile: "read", tools: ["Read", "Grep", "Glob"] });
    expect(profileTools(undefined, undefined)).toEqual({});
    expect(profileTools("web", "/w").error).toMatch(/cannot take a cwd/);
    expect(profileTools("edit", undefined).error).toMatch(/profile must be one of read, web, none/);
  });
});

describe("handoffCwdError", () => {
  it("a claude-code cwd inside ~/.aws, ~/.config or ~/Library is refused; <repo>/.worktrees/<branch> is accepted", () => {
    const opts = { home: HOME, fs, uid: UID };
    expect(handoffCwdError("/home/u/.aws", "claude-code", opts)).toMatch(/inside \/home\/u\/\.aws, a protected folder/);
    expect(handoffCwdError("/home/u/.config/app", "claude-code", opts)).toMatch(/inside \/home\/u\/\.config/);
    expect(handoffCwdError("/home/u/Library/LaunchAgents", "claude-code", opts)).toMatch(/inside \/home\/u\/Library/);
    expect(handoffCwdError("/home/u/repo/.git/hooks", "claude-code", opts)).toMatch(/\.git folder/);
    expect(handoffCwdError("/home/u/repo/sshlink", "claude-code", opts)).toMatch(/inside \/home\/u\/\.ssh/);
    expect(handoffCwdError("/home/u/repo/.worktrees/feat-x", "claude-code", opts)).toBeUndefined();
    expect(handoffCwdError("/home/u/repo", "claude-code", opts)).toBeUndefined();
  });

  it("a claude-code cwd that is the root, the home folder, another user's or not a folder is refused", () => {
    const opts = { home: HOME, fs, uid: UID };
    expect(handoffCwdError("/", "claude-code", opts)).toMatch(/root or home folder/);
    expect(handoffCwdError(HOME, "claude-code", opts)).toMatch(/root or home folder/);
    expect(handoffCwdError("/home/u/foreign", "claude-code", opts)).toMatch(/another user/);
    expect(handoffCwdError("/home/u/somefile", "claude-code", opts)).toMatch(/not an existing folder/);
    expect(handoffCwdError("/home/u/gone", "claude-code", opts)).toMatch(/not an existing folder/);
    expect(handoffCwdError("repo", "claude-code", opts)).toMatch(/absolute path/);
  });

  it("a command cwd only has to be an existing absolute folder", () => {
    const opts = { home: HOME, fs, uid: UID };
    expect(handoffCwdError("/tmp", "command", opts)).toBeUndefined();
    expect(handoffCwdError("/", "command", opts)).toBeUndefined();
    expect(handoffCwdError("/home/u/.config", "command", opts)).toBeUndefined();
    expect(handoffCwdError("/home/u/somefile", "command", opts)).toMatch(/not an existing folder/);
    expect(handoffCwdError("/home/u/gone", "command", opts)).toMatch(/not an existing folder/);
  });
});

/** True when the temp disk ignores letter case (macOS by default), checked once on a real folder. */
const CASE_INSENSITIVE_TMP = (() => {
  const probe = mkdtempSync(join(tmpdir(), "tidegap-case-"));
  try {
    mkdirSync(join(probe, "abc"));
    return existsSync(join(probe, "ABC"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("the rules on a real file system", () => {
  let root: string;
  let real: string;
  const home = homedir();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tidegap-handoff-"));
    real = realpathSync(root);
    mkdirSync(join(root, "work"));
    mkdirSync(join(root, "work", ".hidden"));
    writeFileSync(join(root, "work", "exists.txt"), "x");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    symlinkSync(join(home, ".ssh"), join(root, "work", "keys"));
    symlinkSync(join(root, "work", "exists.txt"), join(root, "work", "link.txt"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("each result path rule holds with real paths and links", () => {
    const c = { cwd: join(real, "work"), tmpDirs: [] };
    expect(resultPathError(join(real, "work", "new.txt"), c)).toBeUndefined();
    // The temp folder is a root by default, through its link on macOS.
    expect(resultPathError(join(root, "work", "new.txt"), {})).toBeUndefined();
    expect(resultPathError(`${real}/work/../x`, c)).toMatch(/segments/);
    expect(resultPathError(join(real, "elsewhere", "x"), c)).toMatch(/does not exist/);
    expect(resultPathError(join(real, "work", ".hidden", "x"), c)).toMatch(/may start with/);
    expect(resultPathError(join(real, "work", "keys", "x"), c)).toMatch(/\.ssh, a protected folder/);
    expect(resultPathError(join(real, "work", "exists.txt"), c)).toMatch(/already exists/);
    expect(resultPathError(join(real, "work", "link.txt"), c)).toMatch(/already exists/);
    expect(resultPathError(join(real, "x.txt"), c)).toMatch(/must be inside/);
  });

  it("refuses another letter case of a protected folder", () => {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    const upper = join(home, "LIBRARY", "LaunchAgents");
    // A disk that ignores case (macOS) finds the folder, and it is protected; elsewhere it does not exist.
    expect(handoffCwdError(upper, "claude-code")).toMatch(CASE_INSENSITIVE_TMP ? /protected folder/ : /not an existing folder/);
    expect(resultPathError(join(upper, "x.plist"), { cwd: upper, tmpDirs: [] })).toMatch(/protected folder/);
    expect(resultPathError(join(home, ".SSH", "authorized_keys"), { cwd: join(home, ".SSH"), tmpDirs: [] })).toMatch(/protected folder/);
  });

  it("the output path and cwd rules hold with real paths and links", () => {
    const c = { cwd: join(real, "work"), tmpDirs: [] };
    expect(outputPathError(join(real, "work", "exists.txt"), c)).toBeUndefined();
    expect(outputPathError(join(real, "work", "link.txt"), c)).toMatch(/not a regular file you own/);
    expect(handoffCwdError(join(real, "work"), "claude-code")).toBeUndefined();
    expect(handoffCwdError(join(real, "work", "keys"), "claude-code")).toMatch(/\.ssh, a protected folder/);
    expect(handoffCwdError(join(real, "work", "exists.txt"), "command")).toMatch(/not an existing folder/);
  });
});
