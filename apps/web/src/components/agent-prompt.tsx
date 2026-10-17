"use client";

import { useEffect, useRef, useState } from "react";

const PROMPT =
  "Read https://www.tidegap.com/install.md, then install Tidegap for the host you're in and confirm it worked.";

type CopyState = "idle" | "copied" | "failed";

const COPIED_RESET_MS = 1500;

function useCopyPrompt() {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    setState("idle");
    try {
      await navigator.clipboard.writeText(PROMPT);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), COPIED_RESET_MS);
    } catch {
      setState("failed");
    }
  }

  return { state, copy };
}

export function HeroPrompt() {
  const { state, copy } = useCopyPrompt();

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-3">
      <pre
        id="hero-prompt"
        className="w-full select-text whitespace-pre-wrap break-words rounded-lg border border-rule bg-bg-elev p-4 text-left font-mono text-[12px] leading-relaxed text-fg sm:text-[15px]"
      >
        {PROMPT}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy prompt: install Tidegap from tidegap.com/install.md"
        aria-describedby="hero-prompt"
        className="rounded-lg border border-accent/60 bg-accent/15 px-6 py-3 font-mono text-sm font-semibold text-accent transition-colors hover:bg-accent/25 sm:px-8 sm:text-base"
      >
        Copy prompt
      </button>
      <p role="status" className="min-h-5 text-sm text-fg-muted">
        {state === "copied" && "Copied. Paste it into your agent."}
        {state === "failed" && "Copy blocked. Select the prompt above and copy it."}
      </p>
    </div>
  );
}

export function AgentPrompt() {
  const { state, copy } = useCopyPrompt();

  return (
    <div className="relative rounded-md border border-rule bg-bg overflow-hidden">
      <div className="flex items-center justify-between border-b border-rule bg-bg-elev px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
          agent prompt
        </span>
        <button
          type="button"
          onClick={copy}
          className="rounded px-2 py-0.5 font-mono text-[11px] text-fg-muted transition-colors hover:bg-bg-card hover:text-accent"
        >
          {state === "copied" ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-fg whitespace-pre-wrap">
        <code>{PROMPT}</code>
      </pre>
    </div>
  );
}
