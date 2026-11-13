/**
 * Wake rules of a bound job (KTD9): the `--wake` text, the pattern checks
 * on add and edit, and the bounded match the sweep runs after a run.
 */

import { describe, expect, it } from "vitest";

import { JOB_WAKE_TEXT_MAX_CHARS, JobWakeError, matchWake, parseWakeRule, taskWorkShape, wakePatternError, wakeShapeText } from "../src/index.js";

describe("job wake rules", () => {
  it("parses never, failures and match=<pattern>; anything else is refused", () => {
    expect(parseWakeRule("never")).toEqual({ on: "never" });
    expect(parseWakeRule(" failures ")).toEqual({ on: "failures" });
    expect(parseWakeRule("match=^ALERT")).toEqual({ on: "match", pattern: "^ALERT" });
    expect(() => parseWakeRule("always")).toThrow(JobWakeError);
    expect(() => parseWakeRule("match=")).toThrow(/non-empty/);
  });

  it("refuses a pattern that does not compile, is over 200 characters, or matches an empty output", () => {
    expect(wakePatternError("^ALERT")).toBeUndefined();
    expect(wakePatternError("(unclosed")).toMatch(/not a valid regular expression/);
    expect(wakePatternError("a".repeat(201))).toMatch(/longer than 200/);
    expect(wakePatternError("x*")).toMatch(/matches an empty output/);
    expect(wakePatternError("^")).toMatch(/matches an empty output/);
  });

  it("matches at each line (flag m) and reads only the first 64 KiB", () => {
    expect(matchWake("^ALERT", "ALERT disk 91%")).toEqual({ matched: true });
    expect(matchWake("^ALERT", "ok\nALERT x")).toEqual({ matched: true });
    expect(matchWake("^ALERT", "ok")).toEqual({ matched: false });
    expect(matchWake("ALERT", `${"x".repeat(JOB_WAKE_TEXT_MAX_CHARS)}ALERT`)).toEqual({ matched: false });
  });

  it("a catastrophic pattern times out inside 500 ms and counts as matched", () => {
    const start = Date.now();
    const m = matchWake("(a+)+$", `${"a".repeat(30)}b`);
    expect(Date.now() - start).toBeLessThan(500);
    expect(m).toEqual({ matched: true, timedOut: true });
  });

  it("a stored pattern that no longer compiles counts as matched", () => {
    expect(matchWake("(", "anything")).toEqual({ matched: true, broken: true });
  });

  it("a run of a bound job shows its rule on the wake: line, not a plain on", () => {
    const body = (jobWake: unknown) => ({ bodyJson: JSON.stringify({ type: "provider_call", provider: "command", model: "none", prompt: "", jobWake }) });
    expect(wakeShapeText(taskWorkShape(body({ on: "failures", session: "s" })))).toMatch(/^failures \(wakes its idle session only if the run fails/);
    expect(wakeShapeText(taskWorkShape(body({ on: "match", session: "s" })))).toMatch(/^match \(wakes its idle session only if the run's output matches/);
    expect(wakeShapeText(taskWorkShape({ bodyJson: JSON.stringify({ handoff: { wake: true } }) }))).toBe("on (wakes its idle session when it finishes)");
    expect(wakeShapeText(taskWorkShape({ bodyJson: JSON.stringify({ prompt: "p" }) }))).toBeUndefined();
  });
});
