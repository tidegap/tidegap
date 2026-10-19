// Tests for scripts/build-test-count.mjs (node --test). Pure functions only: nothing is counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { merge, parseNodeTap, parsePytestCollect, parseVitestList, patchMarkers, readCommitted, renderBadge, renderProse, renderReadme, renderTs } from "./build-test-count.mjs";

const committed = { total: 30, perPackage: { "core-ts": 10, cli: 20 }, generatedAt: "2026-01-01" };

test("parsers read each runner's output", () => {
  assert.equal(parseVitestList('noise\n[{"name":"a > b","file":"x"},{"name":"c","file":"y"}]\n'), 2);
  assert.equal(parseNodeTap("TAP version 13\n# tests 88\n# pass 88\n"), 88);
  assert.ok(Number.isNaN(parseNodeTap("nothing")));
  assert.equal(parsePytestCollect("tests/a.py::t\n\n518 tests collected in 0.9s\n"), 518);
  assert.equal(parsePytestCollect("1 test collected"), 1);
});

test("merge keeps the committed value of an uncounted package and the old date when nothing changed", () => {
  const r = merge({ "core-ts": 10, cli: 20, "core-py": NaN }, committed, "2026-02-02");
  assert.deepEqual(r.value, committed);
  assert.deepEqual(r.unavailable, ["core-py"]);
});

test("merge sums fresh counts and stamps the date when a count changes", () => {
  const r = merge({ "core-ts": 11, cli: 20 }, committed, "2026-02-02");
  assert.equal(r.value.total, 31);
  assert.equal(r.value.generatedAt, "2026-02-02");
});

test("the generated module round-trips through readCommitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "tc-"));
  const f = join(dir, "t.ts");
  writeFileSync(f, renderTs(committed));
  assert.deepEqual(readCommitted(f), committed);
  assert.equal(readCommitted(join(dir, "missing.ts")), null);
});

test("README blocks are patched in place and a missing marker throws", () => {
  const text = "a <!-- tests:start -->old<!-- tests:end --> b\n<!-- tests-badge:start -->old<!-- tests-badge:end -->";
  const out = renderReadme(text, committed);
  assert.ok(out.includes(`<!-- tests:start -->${renderProse(committed)}<!-- tests:end -->`));
  assert.ok(out.includes(renderBadge(committed)));
  assert.match(renderProse(committed), /\*\*30 automated tests\*\* \(10 core-ts \+ 20 cli\) across 2 packages/);
  assert.equal(renderReadme(out, committed), out);
  assert.throws(() => patchMarkers("no markers", "tests", "x"), /markers/);
});
