/** Just enough DOM for the UI's `h()`: elements, text nodes, attributes, listeners, in-place moves among siblings. Install with `installFakeDom()` in `beforeAll`. */

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
  /** An input's or a select's value, as a test or the page sets it (declared only: no own property until one is set). */
  declare value?: string;
  constructor(readonly tagName: string) {
    super();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  toggleAttribute(k: string, force: boolean) {
    if (force) this.attrs[k] = "";
    else delete this.attrs[k];
  }
  parent?: FakeElement;
  get parentNode(): FakeElement | null {
    return this.parent ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return (this.children.find((c) => c instanceof FakeElement) as FakeElement | undefined) ?? null;
  }
  private readonly listeners: Record<string, ((event?: unknown) => void)[]> = {};
  addEventListener(type: string, fn: (event?: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** Run the listeners of `type`, as a user event would; `event` is what they receive. */
  dispatch(type: string, event?: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  /** Drop the children, then add `nodes`. */
  replaceChildren(...nodes: (FakeNode | string)[]) {
    this.children.length = 0;
    this.append(...nodes);
  }
  /** Focus tracking is not modelled: nothing is ever inside the active element. */
  contains(_node: unknown): boolean {
    return false;
  }
  /** Selectors are not modelled: nothing matches. */
  querySelector(_selector: string): FakeElement | null {
    return null;
  }
  /** Add `nodes` at the end; a string becomes a text node, as in the DOM. */
  append(...nodes: (FakeNode | string)[]) {
    this.children.push(...this.adopt(nodes));
  }
  replaceWith(node: FakeElement) {
    const siblings = this.parent?.children;
    const i = siblings?.indexOf(this) ?? -1;
    if (!siblings || i < 0) return;
    siblings[i] = node;
    node.parent = this.parent;
  }
  /** Take this element out of its parent. */
  remove() {
    const siblings = this.parent?.children;
    const i = siblings?.indexOf(this) ?? -1;
    if (siblings && i >= 0) siblings.splice(i, 1);
    this.parent = undefined;
  }
  /** Insert `nodes` just before this element. */
  before(...nodes: (FakeNode | string)[]) {
    this.insertAt(0, nodes);
  }
  /** Insert `nodes` just after this element. */
  after(...nodes: (FakeNode | string)[]) {
    this.insertAt(1, nodes);
  }
  private insertAt(offset: number, nodes: (FakeNode | string)[]) {
    const parent = this.parent;
    const i = parent?.children.indexOf(this) ?? -1;
    if (!parent || i < 0) return;
    parent.children.splice(i + offset, 0, ...parent.adopt(nodes));
  }
  private adopt(nodes: (FakeNode | string)[]): FakeNode[] {
    const out = nodes.map((n) => (typeof n === "string" ? new FakeText(n) : n));
    for (const n of out) if (n instanceof FakeElement) n.parent = this;
    return out;
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
