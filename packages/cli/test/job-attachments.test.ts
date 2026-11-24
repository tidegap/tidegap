/**
 * The attachment intake of a command run: links and odd entries first,
 * then the caps, the types, the names, the secrets and the happy path; then
 * the 30-day sweep. Real files in a temp folder; nothing outside it is read
 * or written.
 */

import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachmentExists,
  attachmentsLine,
  attachmentsRoot,
  displayName,
  intakeAttachments,
  makeIncomingDir,
  sweepAttachments,
  taskAttachmentDir,
} from "../src/jobs/attachments.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A PNG-signed buffer of `bytes` bytes (the intake reads the signature only). */
const png = (bytes: number, fill = 0) => Buffer.concat([PNG_SIG, Buffer.alloc(bytes - PNG_SIG.length, fill)]);
const SECRET = "imap-fixture-Q7f3kLm9";

let root: string;
let store: string;
let incoming: string;
let taskDir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tidegap-attach-")));
  store = join(root, "home", "attachments");
  incoming = makeIncomingDir(store);
  taskDir = taskAttachmentDir(store, "task-1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const intake = (secrets: string[] = []) => intakeAttachments({ incoming, taskDir, secrets });

describe("what the intake refuses", () => {
  it("a symbolic link to a private key is skipped and never read; nothing is written outside the store", () => {
    const outside = join(root, "id_ed25519");
    writeFileSync(outside, "PRIVATE KEY");
    symlinkSync(outside, join(incoming, "key.txt"));
    const r = intake();
    expect(r).toEqual({ attachments: [], skipped: [{ name: "key.txt", reason: "a symbolic link" }] });
    expect(existsSync(taskDir)).toBe(false);
  });

  it("a hard link to a file outside the folder (the ledger, a secrets file) is skipped and never read", () => {
    const outside = join(root, "secrets.json");
    writeFileSync(outside, '{"token":"x"}');
    linkSync(outside, join(incoming, "s.json"));
    expect(intake()).toEqual({ attachments: [], skipped: [{ name: "s.json", reason: "a hard link" }] });
    expect(existsSync(taskDir)).toBe(false);
  });

  it("an incoming folder the command swapped for a link to another folder is not read", () => {
    const other = join(root, "dot-config");
    mkdirSync(other);
    writeFileSync(join(other, "secrets.json"), '{"token":"x"}');
    rmSync(incoming, { recursive: true });
    symlinkSync(other, incoming);
    expect(intake()).toEqual({ attachments: [], skipped: [{ name: "TIDEGAP_ATTACH_DIR", reason: "not read: the folder was replaced" }] });
    expect(existsSync(taskDir)).toBe(false);
  });

  it("a .txt that holds NUL bytes (UTF-16 text, a binary) is unknown type", () => {
    writeFileSync(join(incoming, "u16.txt"), Buffer.from("secret", "utf16le"));
    expect(intake().skipped).toEqual([{ name: "u16.txt", reason: "unknown type" }]);
  });

  it("an incoming folder the command removed means no files", () => {
    rmSync(incoming, { recursive: true });
    expect(intake()).toEqual({ attachments: [], skipped: [] });
  });

  it("a folder and a FIFO are skipped with their reasons", () => {
    mkdirSync(join(incoming, "charts"));
    execFileSync("mkfifo", [join(incoming, "pipe.csv")]);
    expect(intake().skipped).toEqual([
      { name: "charts", reason: "a folder" },
      { name: "pipe.csv", reason: "not a regular file" },
    ]);
  });

  it("a 14 MB PNG is skipped as over 10 MB", () => {
    writeFileSync(join(incoming, "huge.png"), png(14 * 1024 * 1024));
    expect(intake()).toEqual({ attachments: [], skipped: [{ name: "huge.png", reason: "over 10 MB" }] });
  });

  it("a PNG of exactly 10 MB is kept; one byte more is skipped as over 10 MB", () => {
    writeFileSync(join(incoming, "a.png"), png(10 * 1024 * 1024));
    writeFileSync(join(incoming, "b.png"), png(10 * 1024 * 1024 + 1));
    const r = intake();
    expect(r.attachments.map((a) => [a.name, a.bytes])).toEqual([["a.png", 10 * 1024 * 1024]]);
    expect(r.skipped).toEqual([{ name: "b.png", reason: "over 10 MB" }]);
  });

  it("a fifth file is skipped as over 4 files, in name order", () => {
    for (const n of ["e", "a", "c", "b", "d"]) writeFileSync(join(incoming, `${n}.txt`), n);
    const r = intake();
    expect(r.attachments.map((a) => a.name)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
    expect(r.skipped).toEqual([{ name: "e.txt", reason: "over 4 files" }]);
  });

  it("a file that would pass 20 MB per run is skipped", () => {
    writeFileSync(join(incoming, "a.png"), png(9 * 1024 * 1024));
    writeFileSync(join(incoming, "b.png"), png(9 * 1024 * 1024));
    writeFileSync(join(incoming, "c.png"), png(3 * 1024 * 1024));
    const r = intake();
    expect(r.attachments.map((a) => a.name)).toEqual(["a.png", "b.png"]);
    expect(r.skipped).toEqual([{ name: "c.png", reason: "over 20 MB per run" }]);
  });

  it("report.png that holds text, and notes.txt with invalid UTF-8, are unknown type", () => {
    writeFileSync(join(incoming, "report.png"), "not an image");
    writeFileSync(join(incoming, "notes.txt"), Buffer.from([0x66, 0xff, 0xfe, 0x00]));
    expect(intake().skipped).toEqual([
      { name: "notes.txt", reason: "unknown type" },
      { name: "report.png", reason: "unknown type" },
    ]);
  });

  it("a PNG that holds a job secret is skipped; a CSV that holds it is stored scrubbed", () => {
    writeFileSync(join(incoming, "chart.png"), Buffer.concat([png(64), Buffer.from(SECRET)]));
    writeFileSync(join(incoming, "weekly.csv"), `user,pass\nme,${SECRET}\n`);
    const r = intake([SECRET]);
    expect(r.skipped).toEqual([{ name: "chart.png", reason: "contains a secret" }]);
    expect(r.attachments).toHaveLength(1);
    const csv = readFileSync(join(taskDir, "1.csv"), "utf8");
    expect(csv).not.toContain(SECRET);
    expect(csv).toContain("[redacted]");
    expect(r.attachments[0]!.bytes).toBe(Buffer.byteLength(csv));
  });

  it("a name with path marks is cleaned and the file is stored as <n>.<ext>", () => {
    // The kernel refuses a `/` in a name; a backslash is the mark a name can hold.
    writeFileSync(join(incoming, "..\\..\\x.png"), png(32));
    const r = intake();
    expect(r.attachments).toEqual([{ name: ".._.._x.png", type: "image/png", bytes: 32, file: "1.png" }]);
    expect(readdirSync(taskDir)).toEqual(["1.png"]);
  });

  it("a name with a control character, a bidirectional control and 120 characters is cleaned to at most 80", () => {
    const raw = `a\u0007b‮${"c".repeat(120)}.txt`;
    expect(displayName(raw)).toBe(`ab${"c".repeat(77)}…`);
    expect(Array.from(displayName(raw)).length).toBe(80);
  });

  it("a job secret in a file name is scrubbed from the name a notice shows", () => {
    writeFileSync(join(incoming, `${SECRET}.txt`), "a");
    mkdirSync(join(incoming, `${SECRET}-dir`));
    const r = intake([SECRET]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.attachments[0]!.name).toBe("[redacted].txt");
  });

  it("zero-width characters are removed from a name", () => {
    expect(displayName("fun\u200Bnel\u2060.png\uFEFF")).toBe("funnel.png");
  });

  it("over ten skipped files are named up to ten, the rest counted", () => {
    for (let i = 0; i < 13; i++) mkdirSync(join(incoming, `d${String(i).padStart(2, "0")}`));
    const r = intake();
    expect(r.skipped).toHaveLength(11);
    expect(r.skipped[10]).toEqual({ name: "3 more files", reason: "not read: too many files" });
  });
});

describe("what the intake keeps", () => {
  it("covers the funnel example: a PNG and a CSV, stored 0600 as 1.png and 2.csv", () => {
    writeFileSync(join(incoming, "funnel.png"), png(48 * 1024));
    writeFileSync(join(incoming, "weekly.csv"), "metric,value\n".padEnd(2048, "x"));
    const r = intake();
    expect(r).toEqual({
      attachments: [
        { name: "funnel.png", type: "image/png", bytes: 49152, file: "1.png" },
        { name: "weekly.csv", type: "text/csv", bytes: 2048, file: "2.csv" },
      ],
      skipped: [],
    });
    for (const f of ["1.png", "2.csv"]) expect(statSync(join(taskDir, f)).mode & 0o777).toBe(0o600);
    expect(attachmentsLine(r.attachments)).toBe("Attachments: funnel.png (PNG image, 48 KB), weekly.csv (CSV, 2 KB)");
  });

  it("detects JPEG, GIF, WebP and PDF from their bytes, whatever the name; an SVG is image/svg+xml", () => {
    writeFileSync(join(incoming, "a.bin"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    writeFileSync(join(incoming, "b"), "GIF89a....");
    writeFileSync(join(incoming, "c.dat"), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]));
    writeFileSync(join(incoming, "d.pdf"), "%PDF-1.7\n");
    const r = intake();
    expect(r.attachments.map((a) => [a.type, a.file])).toEqual([
      ["image/jpeg", "1.jpg"],
      ["image/gif", "2.gif"],
      ["image/webp", "3.webp"],
      ["application/pdf", "4.pdf"],
    ]);
    rmSync(incoming, { recursive: true });
    mkdirSync(incoming);
    writeFileSync(join(incoming, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(intake().attachments).toEqual([{ name: "chart.svg", type: "image/svg+xml", bytes: 41, file: "1.svg" }]);
  });

  it("removes an earlier attempt's files first: a rerun with one file leaves exactly one", () => {
    writeFileSync(join(incoming, "a.txt"), "a");
    writeFileSync(join(incoming, "b.txt"), "b");
    intake();
    rmSync(incoming, { recursive: true });
    mkdirSync(incoming);
    writeFileSync(join(incoming, "c.txt"), "c");
    intake();
    expect(readdirSync(taskDir)).toEqual(["1.txt"]);
    expect(readFileSync(join(taskDir, "1.txt"), "utf8")).toBe("c");
  });

  it("an empty folder keeps nothing and writes nothing", () => {
    expect(intake()).toEqual({ attachments: [], skipped: [] });
    expect(existsSync(taskDir)).toBe(false);
  });
});

describe("the store", () => {
  it("lives beside the ledger; each attempt's incoming folder is fresh, private and empty", () => {
    expect(attachmentsRoot(join(root, "home", "ledger.db"))).toBe(store);
    const other = makeIncomingDir(store);
    expect(other).not.toBe(incoming);
    expect(statSync(other).mode & 0o777).toBe(0o700);
    expect(readdirSync(other)).toEqual([]);
  });

  it("refuses a task id with a path mark", () => {
    expect(() => taskAttachmentDir(store, "../x")).toThrow("invalid task id");
    expect(() => taskAttachmentDir(store, "..")).toThrow("invalid task id");
  });

  it("the sweep removes a 31-day-old task folder and keeps a 29-day-old one; a missing file reads as gone", () => {
    const now = new Date("2026-11-14T10:05:00Z");
    const old = taskAttachmentDir(store, "task-old");
    const recent = taskAttachmentDir(store, "task-recent");
    for (const [dir, days] of [
      [old, 31],
      [recent, 29],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "1.png"), png(16));
      const t = new Date(now.getTime() - days * 86_400_000);
      utimesSync(dir, t, t);
    }
    expect(sweepAttachments(store, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(incoming)).toBe(true);
    expect(attachmentExists(store, "task-recent")("1.png")).toBe(true);
    expect(attachmentExists(store, "task-old")("1.png")).toBe(false);
  });

  it("the sweep removes an incoming folder a crashed run left, and never a folder it did not make", () => {
    const now = new Date("2026-11-14T10:05:00Z");
    const t = new Date(now.getTime() - 31 * 86_400_000);
    const stale = makeIncomingDir(store);
    const foreign = join(store, "photos");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "holiday.png"), png(16));
    const outside = join(root, "keep");
    mkdirSync(outside);
    writeFileSync(join(outside, "1.png"), png(16));
    symlinkSync(outside, join(store, "task-link"));
    for (const dir of [stale, foreign, outside]) utimesSync(dir, t, t);
    expect(sweepAttachments(store, now)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(foreign, "holiday.png"))).toBe(true);
    expect(existsSync(join(outside, "1.png"))).toBe(true);
    expect(existsSync(incoming)).toBe(true);
  });

  it("the sweep never lists a store that was replaced by a link", () => {
    const now = new Date("2026-11-14T10:05:00Z");
    const t = new Date(now.getTime() - 31 * 86_400_000);
    const target = join(root, "target");
    const victim = join(target, "task-x");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "1.png"), png(16));
    utimesSync(victim, t, t);
    const linked = join(root, "linked-store");
    symlinkSync(target, linked);
    expect(sweepAttachments(linked, now)).toBe(0);
    expect(existsSync(join(victim, "1.png"))).toBe(true);
  });
});
