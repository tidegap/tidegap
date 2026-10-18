"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";

import { HOSTS, type Host } from "@/lib/hosts";
import { INSTALL_PROMPT } from "@/lib/install-prompt";

/**
 * The homepage install box: the prompt plus every install path as WAI-ARIA
 * tabs. All panels render on the server; inactive ones carry `hidden`, so
 * crawlers and agents read every command in the initial HTML.
 */

/** Tab id → the `installHeading` (install.md heading) whose hosts it shows. */
const TABS: Array<{ id: string; label: string; heading?: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "claude-code", label: "Claude Code", heading: "Claude Code" },
  { id: "codex", label: "Codex", heading: "OpenAI Codex CLI" },
  { id: "openclaw", label: "OpenClaw", heading: "OpenClaw" },
  { id: "mcp", label: "MCP hosts", heading: "Other MCP hosts" },
  { id: "lib", label: "Libraries", heading: "Libraries" },
];

const hostsFor = (heading: string) => HOSTS.filter((h) => h.installHeading === heading);

/** The generic entry goes last in the host list; Claude Desktop is the default. */
const MCP_HOSTS = [
  ...hostsFor("Other MCP hosts").filter((h) => h.id !== "mcp"),
  ...hostsFor("Other MCP hosts").filter((h) => h.id === "mcp"),
];
const MCP_LABEL: Record<string, string> = { mcp: "Any MCP host" };

const COPIED_RESET_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(text: string) {
    clearTimeout(timer.current);
    setState("idle");
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), COPIED_RESET_MS);
    } catch {
      setState("failed");
    }
  }

  return { state, copy };
}

export function InstallBox() {
  const [active, setActive] = useState("prompt");
  const [mcpHost, setMcpHost] = useState(MCP_HOSTS[0]!.id);
  const { state, copy } = useCopy();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.id === active);
    const next =
      e.key === "ArrowRight" ? (i + 1) % TABS.length
      : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
      : e.key === "Home" ? 0
      : e.key === "End" ? TABS.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(TABS[next]!.id);
    tabs.current[next]?.focus();
  }

  function panel(id: string): ReactNode {
    if (id === "prompt") {
      return (
        <div className="flex flex-col items-center gap-4">
          <pre
            id="install-prompt"
            className="w-full select-text whitespace-pre-wrap break-words rounded-lg border border-rule bg-bg p-4 text-left font-mono text-[12px] leading-relaxed text-fg sm:text-[15px]"
          >
            {INSTALL_PROMPT}
          </pre>
          <button
            type="button"
            onClick={() => copy(INSTALL_PROMPT)}
            aria-label="Copy prompt: install Tidegap from tidegap.com/install.md"
            aria-describedby="install-prompt"
            className="min-h-11 rounded-lg border border-accent/60 bg-accent/15 px-6 py-3 font-mono text-sm font-semibold text-accent transition-colors hover:bg-accent/25 sm:px-8 sm:text-base"
          >
            Copy prompt
          </button>
        </div>
      );
    }
    if (id === "mcp") {
      return (
        <div className="space-y-3">
          <select
            aria-label="Host"
            value={mcpHost}
            onChange={(e) => setMcpHost(e.target.value)}
            className="min-h-11 w-full rounded-md border border-rule bg-bg px-3 font-mono text-sm text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent sm:max-w-xs"
          >
            {MCP_HOSTS.map((h) => (
              <option key={h.id} value={h.id} data-host={h.id}>
                {MCP_LABEL[h.id] ?? h.label}
              </option>
            ))}
          </select>
          {MCP_HOSTS.map((h) => (
            <div key={h.id} hidden={h.id !== mcpHost} className="space-y-3">
              <p className="text-sm text-fg-muted">{h.desc}</p>
              <CodeBlock host={h} onCopy={copy} />
              <Then>{h.followup}</Then>
            </div>
          ))}
        </div>
      );
    }
    if (id === "lib") {
      return (
        <div className="space-y-3">
          {hostsFor("Libraries").map((h) => (
            <CodeBlock key={h.id} host={h} onCopy={copy} />
          ))}
          <Then>
            Same scheduler API in TypeScript and Python.{" "}
            <Link href="/docs" className="text-accent hover:underline">
              Docs →
            </Link>
          </Then>
        </div>
      );
    }
    const host = hostsFor(TABS.find((t) => t.id === id)!.heading!)[0]!;
    return (
      <div className="space-y-3" data-host={host.id}>
        <CodeBlock host={host} onCopy={copy} />
        <Then>{host.followup}</Then>
      </div>
    );
  }

  return (
    <section
      id="install"
      aria-labelledby="install-heading"
      className="w-full max-w-2xl scroll-mt-20 overflow-hidden rounded-xl border border-rule bg-bg-elev text-left"
    >
      <h2 id="install-heading" className="sr-only">
        Install Tidegap
      </h2>
      <div
        role="tablist"
        aria-label="Install method"
        onKeyDown={onKeyDown}
        className="flex snap-x snap-proximity overflow-x-auto border-b border-rule [scrollbar-width:none]"
      >
        {TABS.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              className={`min-h-11 shrink-0 snap-start whitespace-nowrap border-b-2 px-4 font-mono text-xs transition-colors ${
                selected ? "border-accent text-accent" : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="p-4 sm:p-5">
        {TABS.map((t) => (
          <section
            key={t.id}
            role="tabpanel"
            id={`panel-${t.id}`}
            aria-labelledby={`tab-${t.id}`}
            tabIndex={0}
            hidden={t.id !== active}
          >
            {panel(t.id)}
          </section>
        ))}
        <p role="status" aria-live="polite" className="mt-3 min-h-5 text-center text-sm text-fg-muted">
          {state === "copied" && "Copied. Paste it into your agent."}
          {state === "failed" && "Copy blocked. Select the text and copy it."}
        </p>
      </div>

      <p className="border-t border-rule px-4 py-3 text-xs leading-relaxed text-fg-muted sm:px-5">
        Queued tasks run through a small local daemon:{" "}
        <code className="break-words rounded bg-bg px-1 font-mono text-[11px] text-fg">
          npm install -g @tidegap/cli &amp;&amp; tidegap install --laptop
        </code>
        . The prompt path sets it up for you.{" "}
        <Link href="/docs" className="whitespace-nowrap text-accent hover:underline">
          All commands →
        </Link>
      </p>
    </section>
  );
}

function CodeBlock({ host, onCopy }: { host: Host; onCopy: (text: string) => void }) {
  return (
    <div className="overflow-hidden rounded-md border border-rule bg-bg">
      <div className="flex items-center justify-between border-b border-rule bg-bg-elev pl-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">{host.lang}</span>
        <button
          type="button"
          onClick={() => onCopy(host.command)}
          aria-label={`Copy the ${host.label} command`}
          className="min-h-11 px-3 font-mono text-[11px] text-fg-muted transition-colors hover:text-accent"
        >
          Copy
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-fg">
        <code>{host.command}</code>
      </pre>
    </div>
  );
}

function Then({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-fg-muted">
      <span className="font-mono text-[10px] uppercase tracking-wider text-accent">then</span> {children}
    </p>
  );
}
