/** Just enough DOM for the UI's `h()`: elements, text nodes, attributes, listeners. Install with `installFakeDom()` in `beforeAll`. */

import { afterAll, beforeAll } from "vitest";

export class FakeNode {}

export class FakeText extends FakeNode {
  constructor(readonly textContent: string) {
    super();
  }
}

export class FakeElement extends FakeNode {
  readonly children: FakeNode[] = [];
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  constructor(readonly tagName: string) {
    super();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  parent?: FakeElement;
  get firstElementChild(): FakeElement | null {
    return (this.children.find((c) => c instanceof FakeElement) as FakeElement | undefined) ?? null;
  }
  private readonly listeners: Record<string, (() => void)[]> = {};
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** Run the listeners of `type`, as a user event would. */
  dispatch(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  append(...nodes: FakeNode[]) {
    for (const n of nodes) if (n instanceof FakeElement) n.parent = this;
    this.children.push(...nodes);
  }
  replaceWith(node: FakeElement) {
    const siblings = this.parent?.children;
    const i = siblings?.indexOf(this) ?? -1;
    if (!siblings || i < 0) return;
    siblings[i] = node;
    node.parent = this.parent;
  }
}

/** Swap in the fake `document` and `Node` for the file's tests; the real globals come back after. */
export function installFakeDom(): void {
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    saved.document = (globalThis as Record<string, unknown>).document;
    saved.Node = (globalThis as Record<string, unknown>).Node;
    Object.assign(globalThis, {
      Node: FakeNode,
      document: {
        createElement: (t: string) => new FakeElement(t),
        createElementNS: (_ns: string, t: string) => new FakeElement(t),
        createTextNode: (t: string) => new FakeText(t),
      },
    });
  });
  afterAll(() => Object.assign(globalThis, saved));
}

/** Every element and text under `nodes`, depth first. */
export function walk(nodes: unknown[], out: { els: FakeElement[]; text: string[] } = { els: [], text: [] }) {
  for (const n of nodes) {
    if (n instanceof FakeText) out.text.push(n.textContent);
    if (n instanceof FakeElement) {
      out.els.push(n);
      walk(n.children, out);
    }
  }
  return out;
}

/** The text under one element. */
export function textOf(el: FakeElement): string {
  return walk([el]).text.join("");
}
