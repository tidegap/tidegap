/**
 * /queue — scheduler-queue explainer.
 *
 * The site is read-only and doesn't have access to your local
 * SQLite ledger. This page explains the queue lifecycle, the status
 * vocabulary, and how to inspect it locally with `tidegap ui` and the CLI.
 * No synthetic counters, no fake task list.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { MCP_TOOL_COUNT } from "@tidegap/core/tool-surface";

export const metadata: Metadata = {
  title: "Scheduler queue",
  description:
    "How Tidegap's task queue works — seven statuses, one SQLite file, a local task page (tidegap ui) and the CLI. No telemetry; your queue is your queue.",
  alternates: { canonical: "https://www.tidegap.com/queue" },
};

const STATUSES: Array<{ name: string; description: string }> = [
  {
    name: "queued",
    description:
      "Just created; the scheduler hasn't picked a window yet (rare race window — usually fills within 1s).",
  },
  {
    name: "scheduled",
    description:
      "Window picked. Will dispatch at the chosen UTC hour inside the deadline. Sits here until the tick daemon fires.",
  },
  {
    name: "submitted",
    description:
      "Sent to the provider's Batch API (deadline more than 24 h away). The provider runs it within its 24 h batch window; a later tick collects the result.",
  },
  {
    name: "running",
    description:
      "The provider call is in-flight. For Batch-API tasks this can be hours; for sync tasks it's seconds.",
  },
  {
    name: "completed",
    description:
      "Provider returned. A carbon receipt is written: actual intensity, tokens in/out, dispatched_at timestamp.",
  },
  {
    name: "failed",
    description:
      "Provider returned an error. The reason is persisted; the /tidegap:retry slash command (or the retry_task MCP tool) re-dispatches.",
  },
  {
    name: "cancelled",
    description:
      "Manually cancelled. Idempotent — already-completed tasks return their existing status if you cancel them.",
  },
];

export default function QueuePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-12 text-fg">
      <header className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-wider text-accent">
          scheduler queue
        </p>
        <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl">
          One SQLite file. Inspectable from anywhere.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-fg-muted">
          Every task — pending, scheduled, completed, failed,
          cancelled — lives in{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">~/.tidegap/queue.db</code>
          . The Claude Code plugin, the OpenClaw plugin, the MCP
          server, and the CLI all read and write this same file.
          Inspect it however you like.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Status vocabulary</h2>
        <ul className="space-y-2 leading-relaxed text-fg-muted">
          {STATUSES.map((s) => (
            <li key={s.name}>
              <code className="rounded bg-bg-elev px-1.5 py-0.5 font-mono text-sm font-semibold text-fg">
                {s.name}
              </code>
              <span className="ml-2">— {s.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">See it on your machine: tidegap ui</h2>
        <p className="leading-relaxed text-fg-muted">
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">tidegap ui</code>{" "}
          opens a local page with three views: a timeline of queued tasks
          on the forecast curve (tasks that must run before your weekly
          quota resets are listed as their own group), an inbox of finished
          tasks you have not opened, and a task detail view with the
          prompt, the result, the carbon receipt and the raw provider
          response. It shows when the dispatcher last ran. It cannot
          dispatch or cancel anything.
        </p>
        <p className="leading-relaxed text-fg-muted">
          The page listens on 127.0.0.1 only. Every API request needs a
          random token that is printed once with the link and changes each
          time you start it. Task data never leaves your machine; the
          timeline asks the grid provider your tick already uses for the
          forecast.
        </p>
        <CodeBlock>
{`tidegap ui
tidegap ui: http://127.0.0.1:53817/#token=<random, per run>
Serving on 127.0.0.1 only. The link carries a one-run access token; do not share it. Press Ctrl-C to stop.`}
        </CodeBlock>
        <p className="leading-relaxed text-fg-muted">
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">tidegap tick</code>{" "}
          also posts a desktop notification when a task completes or
          fails, and the Claude Code plugin prints one line at session
          start when finished tasks are unread.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">Inspect from the CLI</h2>
        <CodeBlock>
{`# All tasks (any status)
tidegap queue list

# Filter by status, deadline kind, or unread results
tidegap queue list --status scheduled
tidegap queue list --kind quota_reset
tidegap queue list --unread

# One task: prompt, result, receipt (marks it read)
tidegap queue show <task_id>

# Receipts only (completed tasks)
tidegap receipts list
tidegap receipts list --since 2026-05-01

# Verify a receipt's Ed25519 signature
tidegap verify <task_id>`}
        </CodeBlock>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">From the agent (any MCP host)</h2>
        <p className="leading-relaxed text-fg-muted">
          The same queue is reachable through the MCP{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">check_queue_status</code>{" "}
          tool. Your agent can answer {`"what's queued?"`} or{" "}
          {`"did that task run?"`} inline:
        </p>
        <CodeBlock>
{`> /tidegap:check
Total tasks: 3
  scheduled: 1 · completed: 2

> /tidegap:check 7f3a2b9e
status     completed
region     US-CAL-CISO
scheduled  22:15 UTC (4h ago)
completed  22:15:08 UTC
result     <the LLM response>`}
        </CodeBlock>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-bold tracking-tight">
          Why not show a live queue here?
        </h2>
        <p className="leading-relaxed text-fg-muted">
          This site has no back-channel to your machine, and it should not:
          a live queue here would mean storing your prompts on a server.
          The live view is{" "}
          <code className="rounded bg-bg-elev px-1 font-mono text-sm">tidegap ui</code>
          , served from your own machine.
        </p>
      </section>

      <footer className="rounded-xl border border-rule bg-bg-elev p-5 text-sm text-fg-muted">
        <p className="mb-2 font-mono text-xs uppercase tracking-wider text-accent">
          related
        </p>
        <ul className="space-y-1">
          <li>
            <Link href="/stats" className="text-accent hover:underline">
              /stats
            </Link>{" "}
            — personal carbon-impact summary (same ledger).
          </li>
          <li>
            <Link href="/docs#commands" className="text-accent hover:underline">
              /docs · slash commands
            </Link>{" "}
            — the ten{" "}
            <code className="rounded bg-bg-elev px-1 font-mono text-xs">
              /tidegap:*
            </code>{" "}
            commands.
          </li>
          <li>
            <Link href="/docs#tools" className="text-accent hover:underline">
              /docs · MCP tools
            </Link>{" "}
            — {MCP_TOOL_COUNT} MCP tools (every host).
          </li>
        </ul>
      </footer>
    </article>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-rule bg-bg-elev p-4 font-mono text-[13px] leading-relaxed text-fg">
      <code>{children}</code>
    </pre>
  );
}
