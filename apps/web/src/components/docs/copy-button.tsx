"use client";

import { useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 1500;

/** Copies the text of the `pre` that sits next to it in the same wrapper. */
export function CopyButton() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(button: HTMLButtonElement) {
    const text = button.parentElement?.querySelector("pre")?.textContent;
    if (!text) return;
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => copy(e.currentTarget)}
      aria-label="Copy code"
      className="absolute right-2 top-2 min-h-8 rounded border border-rule bg-bg px-2 font-mono text-[11px] text-fg-muted transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
