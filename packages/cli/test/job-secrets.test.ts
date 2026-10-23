/** Job secrets file (jobs U5, KTD12). Only temp paths under the hermetic home are touched. */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobSecretsPath, listJobSecretNames, readJobSecrets, removeJobSecret, setJobSecret } from "../src/jobs/secrets.js";

const IMAP = "imap-fixture-Q7f3kLm9";
const SMTP = "smtp-fixture-Z2p8wRt4";
const API = "api-fixture-H5n1cVb6";

describe("job secrets", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-job-secrets-"));
    path = join(dir, "cfg", "tidegap", "job-secrets.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lives next to the env file, under the (hermetic) home", () => {
    expect(jobSecretsPath("/h")).toBe("/h/.config/tidegap/job-secrets.json");
    expect(jobSecretsPath()).toBe(join(homedir(), ".config", "tidegap", "job-secrets.json"));
  });

  it("set, list names only, read two of three, remove", () => {
    setJobSecret("IMAP_PASSWORD", IMAP, path);
    setJobSecret("SMTP_PASSWORD", SMTP, path);
    setJobSecret("API_TOKEN", API, path);
    expect(listJobSecretNames(path)).toEqual(["API_TOKEN", "IMAP_PASSWORD", "SMTP_PASSWORD"]);
    expect(readJobSecrets(["IMAP_PASSWORD", "API_TOKEN", "MISSING_ONE"], path)).toEqual({
      values: { IMAP_PASSWORD: IMAP, API_TOKEN: API },
      missing: ["MISSING_ONE"],
    });
    expect(removeJobSecret("SMTP_PASSWORD", path)).toBe(true);
    expect(removeJobSecret("SMTP_PASSWORD", path)).toBe(false);
    expect(listJobSecretNames(path)).toEqual(["API_TOKEN", "IMAP_PASSWORD"]);
  });

  it("the first write makes the file 0600 in a 0700 directory", () => {
    setJobSecret("IMAP_PASSWORD", IMAP, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "cfg", "tidegap")).mode & 0o777).toBe(0o700);
  });

  it("a malformed file reads as empty with a log line that holds no value, and the next write keeps it as .bak", () => {
    mkdirSync(join(dir, "cfg", "tidegap"), { recursive: true });
    const broken = `{"IMAP_PASSWORD": "${IMAP}"`;
    writeFileSync(path, broken, { mode: 0o600 });
    const logs: string[] = [];
    const read = readJobSecrets(["IMAP_PASSWORD"], path, (l) => logs.push(l));
    expect(read).toMatchObject({ values: {}, missing: ["IMAP_PASSWORD"] });
    expect(read.problem).toMatch(/not valid JSON/);
    expect(listJobSecretNames(path, (l) => logs.push(l))).toEqual([]);
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(IMAP);
    setJobSecret("API_TOKEN", API, path);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(broken);
    expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
    expect(listJobSecretNames(path)).toEqual(["API_TOKEN"]);
  });

  it("refuses a file the group or others may write, on read and on write, naming the fix", () => {
    setJobSecret("IMAP_PASSWORD", IMAP, path);
    chmodSync(path, 0o620);
    const logs: string[] = [];
    const read = readJobSecrets(["IMAP_PASSWORD"], path, (l) => logs.push(l));
    expect(read.values).toEqual({});
    expect(read.missing).toEqual(["IMAP_PASSWORD"]);
    expect(read.problem).toBe(`job-secrets.json is writable by the group or others; job secrets are not read (run: chmod 600 ${path})`);
    expect(listJobSecretNames(path)).toEqual([]);
    expect(() => setJobSecret("API_TOKEN", API, path)).toThrow(/writable by the group or others/);
    expect(logs.join("\n")).not.toContain(IMAP);
    chmodSync(path, 0o600);
    expect(readJobSecrets(["IMAP_PASSWORD"], path).values).toEqual({ IMAP_PASSWORD: IMAP });
  });

  it("refuses an invalid name and an empty value, without echoing the value", () => {
    expect(() => setJobSecret("imap-pass", IMAP, path)).toThrow(/imap-pass/);
    try {
      setJobSecret("imap-pass", IMAP, path);
    } catch (err) {
      expect((err as Error).message).not.toContain(IMAP);
    }
    expect(() => setJobSecret("IMAP_PASSWORD", "", path)).toThrow(/empty/);
    // A value this short could not be scrubbed from the output.
    expect(() => setJobSecret("IMAP_PASSWORD", "abc", path)).toThrow(/shorter than 4 characters/);
  });
});
