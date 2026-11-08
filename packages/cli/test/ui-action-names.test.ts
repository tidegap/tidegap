/**
 * The page's `data-action` names share one namespace: `act()` in app.js
 * handles page-level names (a load-error Retry, the drawer's Close) before
 * its per-task `switch`, so a task action that reuses one of those names
 * never reaches its case. The task Retry was first written as `retry` and
 * only reloaded the list (#238 review).
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`../ui/${f}`, import.meta.url), "utf8");

/** The page-level names `act()` handles before its switch, and the switch's cases. */
function actNames(app: string): { pageLevel: string[]; cases: string[] } {
  const start = app.indexOf("function act(name, id, source) {");
  const sw = app.indexOf("switch (name) {", start);
  const end = app.indexOf("\n}\n", sw);
  expect(start, "act(name, id, source) in app.js").toBeGreaterThan(-1);
  expect(sw, "switch (name) in act()").toBeGreaterThan(start);
  const head = app.slice(start, sw);
  const body = app.slice(sw, end);
  return {
    pageLevel: [...head.matchAll(/name === "([a-z-]+)"/g)].map((m) => m[1]!),
    cases: [...body.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!),
  };
}

describe("data-action names", () => {
  it("no per-task case of act() reuses a page-level action name or the job- prefix", () => {
    const { pageLevel, cases } = actNames(read("app.js"));
    expect(pageLevel).toContain("retry");
    expect(cases).toContain("retry-task");
    const shadowed = cases.filter((c) => pageLevel.includes(c) || c.startsWith("job-"));
    expect(shadowed, `rename these task actions; act() handles the name before its switch: ${shadowed.join(", ")}`).toEqual([]);
  });

  it("every task action the detail bar, the rows and the action menu send has a case in act()", () => {
    const { cases } = actNames(read("app.js"));
    const sent = [
      ...[...read("detail.js").matchAll(/\bbtn\("([a-z-]+)"/g)].map((m) => m[1]!),
      ...[...read("row.js").matchAll(/(?:iconButton\(|"data-action": )"([a-z-]+)"/g)].map((m) => m[1]!),
      ...[...read("app.js").matchAll(/act\("([a-z-]+)", id\)/g)].map((m) => m[1]!),
    ];
    expect(sent).toContain("retry-task");
    const missing = [...new Set(sent)].filter((name) => !cases.includes(name));
    expect(missing, `task actions with no case in act(): ${missing.join(", ")}`).toEqual([]);
  });
});
