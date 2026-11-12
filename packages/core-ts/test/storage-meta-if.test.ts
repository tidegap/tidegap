/**
 * `TaskStore.setMetaIf`: a compare-and-set of one meta value, so two
 * processes that read the same value cannot both write after it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskStore } from "../src/index.js";

describe("TaskStore.setMetaIf", () => {
  let dir: string;
  let stores: TaskStore[];
  const open = (): TaskStore => {
    const s = new TaskStore({ dbPath: join(dir, "queue.db") });
    stores.push(s);
    return s;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tidegap-meta-if-"));
    stores = [];
  });

  afterEach(() => {
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes while the stored value matches and refuses once it changed", () => {
    const s = open();
    s.setMeta("k", "a");
    expect(s.setMetaIf("k", "a", "b")).toBe(true);
    expect(s.getMeta("k")).toBe("b");
    expect(s.setMetaIf("k", "a", "c")).toBe(false);
    expect(s.getMeta("k")).toBe("b");
  });

  it("treats an absent key as a value of its own", () => {
    const s = open();
    expect(s.setMetaIf("k", "a", "b")).toBe(false);
    expect(s.getMeta("k")).toBeUndefined();
    expect(s.setMetaIf("k", undefined, "a")).toBe(true);
    expect(s.getMeta("k")).toBe("a");
    expect(s.setMetaIf("k", undefined, "b")).toBe(false);
    expect(s.getMeta("k")).toBe("a");
  });

  it("deletes the key when next is undefined", () => {
    const s = open();
    s.setMeta("k", "a");
    expect(s.setMetaIf("k", "a", undefined)).toBe(true);
    expect(s.getMeta("k")).toBeUndefined();
  });

  it("of two handles on one file that read the same value, only the first write wins", () => {
    const one = open();
    const two = open();
    one.setMeta("k", "sent");
    const seenByOne = one.getMeta("k");
    const seenByTwo = two.getMeta("k");
    expect(one.setMetaIf("k", seenByOne, undefined)).toBe(true);
    expect(two.setMetaIf("k", seenByTwo, undefined)).toBe(false);
    expect(two.getMeta("k")).toBeUndefined();
  });
});
