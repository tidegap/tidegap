#!/usr/bin/env node
/**
 * `tidegap` — CLI entry point.
 *
 *   tidegap tick           drain due tasks (one-shot or --daemon)
 *   tidegap install        write and load the tick daemon (launchd / systemd), or print the schtasks template
 *   tidegap status         will queued tasks run? daemon, last tick, runners, pending tasks
 *   tidegap queue list     print queued/scheduled/running/completed tasks
 *   tidegap queue cancel | reschedule | later | run-now | reply   change a task (the
 *                      next tick runs it; these commands never dispatch)
 *   tidegap receipts list  print carbon receipts for completed tasks
 *   tidegap stats          local-only personal-impact summary
 *   tidegap register-wake  schedule a macOS wake event 30s before a task
 *   tidegap ui             local task page (timeline, inbox, detail, actions) on 127.0.0.1
 *   tidegap clients        add, list or revoke the tokens of the extension and Mac app
 *   tidegap usage          Claude subscription limits and their resets (`usage hook`: the statusLine recorder)
 *   tidegap region         the grid region: show, set <zone> (or auto), detect, list
 *   tidegap channels       notification channels: add <kind>, connect, test, disconnect, set, remove, list, kinds, and the Telegram listener (`serve`)
 *   tidegap jobs           recurring jobs: list, show, add, edit, pause, resume, run, remove, history, their secrets, and the agent snippet
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AGENT_HOSTS, stripControlChars } from "@tidegap/core";
import { Command } from "commander";
import {
  EXIT,
  kindFieldOptions,
  runChannelsAction,
  runChannelsDigest,
  runChannelsAdd,
  runChannelsAddKind,
  runChannelsKinds,
  runChannelsList,
  runChannelsRemove,
  runChannelsServe,
} from "./commands/channels.js";
import { runClientsAdd, runClientsList, runClientsRevoke } from "./commands/clients.js";
import { runInstall, type InstallMode } from "./commands/install.js";
import {
  JobsCommandError,
  SECRET_VALUE_AS_ARGUMENT,
  runJobsAction,
  runJobsAdd,
  runJobsEdit,
  runJobsHistory,
  runJobsList,
  runJobsSecretsList,
  runJobsSecretsRemove,
  runJobsSecretsSet,
  runJobsShow,
  type JobFlags,
} from "./commands/jobs.js";
import { runJobsSnippet } from "./commands/jobs-snippet.js";
import {
  runQueueCancel,
  runQueueLater,
  runQueueList,
  runQueueReply,
  runQueueReschedule,
  runQueueRunNow,
  runQueueShow,
  runQueueUnread,
} from "./commands/queue.js";
import { runReceiptsList } from "./commands/receipts.js";
import { runRegionDetect, runRegionList, runRegionSet, runRegionShow, type RegionCommandResult } from "./commands/region.js";
import { runRegisterWake } from "./commands/register-wake.js";
import { runStats } from "./commands/stats.js";
import { runStatus } from "./commands/status.js";
import { runTick } from "./commands/tick.js";
import { runUsage, runUsageHook } from "./commands/usage.js";
import { offerStatuslineInteractive } from "./commands/statusline-setup.js";
import { runUi } from "./commands/ui.js";
import { runVerify } from "./commands/verify.js";

/** The hook JSON is a few hundred bytes; anything longer is cut. */
const HOOK_INPUT_MAX_CHARS = 1_000_000;

/**
 * The `--hook-input` value: stdin for `-` (never a terminal), else the named
 * file. Undefined when absent or unreadable: the hook then prints its plain
 * unread line.
 */
function readHookInput(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  if (source === "-" && process.stdin.isTTY) return undefined;
  try {
    return readFileSync(source === "-" ? 0 : source, "utf8").slice(0, HOOK_INPUT_MAX_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * CLI version — read from this package's own `package.json` so there is
 * a single source of truth and `tidegap --version` never drifts from the
 * published version. `createRequire` resolves relative to this module,
 * so it works from both `src` (tests) and `dist` (published bin).
 */
export function readCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const CLI_VERSION = readCliVersion();

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("tidegap")
    .description("CLI for Tidegap — carbon-aware scheduler tick + install")
    .version(CLI_VERSION);

  program
    .command("tick")
    .description("Drain due provider-call tasks")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--once", "Run a single drain pass (default)")
    .option("--daemon", "Loop forever, draining every --interval seconds")
    .option("--interval <sec>", "Daemon interval seconds", (v) => parseInt(v, 10), 60)
    .option("--region <code>", "Default region for hydrated tasks", undefined)
    .option("--no-notify", "Do not post an OS notification per finished task")
    .action(async (opts) => {
      const code = await runTick({
        notify: opts.notify !== false,
        db: opts.db,
        once: opts.once === true,
        daemon: opts.daemon === true,
        interval: opts.interval,
        region: opts.region,
      });
      process.exit(code);
    });

  program
    .command("install")
    .description("Write and load the tick daemon (launchd on macOS, systemd on Linux), then print `tidegap status`")
    .option("--laptop", "Laptop mode: the daemon plus the pmset wake registration helper (default on a Mac with a battery)")
    .option("--server", "Server mode: the daemon only, no wake events (default elsewhere)")
    .option("--no-load", "Write the files only; load nothing")
    .action(async (opts: { laptop?: boolean; server?: boolean; load?: boolean }) => {
      let mode: InstallMode | undefined;
      if (opts.laptop) mode = "laptop";
      if (opts.server) mode = "server";
      const result = await runInstall({ mode, load: opts.load !== false });
      // eslint-disable-next-line no-console
      console.log(result.nextSteps);
      await offerStatuslineInteractive(result.launcher);
      process.exitCode = result.exitCode;
    });

  program
    .command("status")
    .description("Will queued tasks run? Daemon, last tick, runners and pending tasks; exit 1 when not")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--json", "Print the readiness object as JSON")
    .action(async (opts: { db?: string; json?: boolean }) => {
      const res = await runStatus({ db: opts.db, json: opts.json === true });
      // eslint-disable-next-line no-console
      console.log(res.rendered);
      process.exit(res.exitCode);
    });

  const queue = program
    .command("queue")
    .description("Inspect and change the queue");
  queue
    .command("list")
    .description("List queued / scheduled / running / completed tasks")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--status <status>", "Filter by status", undefined)
    .option("--kind <kind>", "Filter by deadline kind: absolute | quota_reset", undefined)
    .option("--unread", "Only completed or failed tasks nobody has viewed yet")
    .option("--json", "Emit JSON instead of the table")
    .option("--hook", "Claude Code SessionStart mode: one unread-count line or nothing; always exits 0")
    .option("--hook-input <file>", "With --hook: the SessionStart hook JSON ('-' reads stdin), so this session's finished tasks are named")
    .option("--series <id>", "Only the occurrences of this repeating series, oldest first")
    .action(async (opts) => {
      if (opts.hook === true) {
        const res = await runQueueList({ db: opts.db, hook: true, hookInput: readHookInput(opts.hookInput) });
        // eslint-disable-next-line no-console
        if (res.rendered) console.log(res.rendered);
        return;
      }
      try {
        const res = await runQueueList({
          db: opts.db,
          status: opts.status,
          kind: opts.kind,
          unread: opts.unread === true,
          json: opts.json === true,
          series: opts.series,
        });
        // eslint-disable-next-line no-console
        console.log(res.rendered);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });
  queue
    .command("show <task-id>")
    .description("Show one task: prompt, result, receipt; marks a finished task read")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--raw", "Include the raw vendor payload")
    .option("--json", "Emit JSON (the record plus its message history)")
    .option("--no-mark-read", "Do not mark the task read (for scripts)")
    .action(async (taskId: string, opts: {
      db?: string;
      raw?: boolean;
      json?: boolean;
      markRead?: boolean;
    }) => {
      try {
        const res = await runQueueShow(taskId, {
          db: opts.db,
          raw: opts.raw === true,
          json: opts.json === true,
          markRead: opts.markRead !== false,
        });
        // eslint-disable-next-line no-console
        console.log(res.rendered);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });
  queue
    .command("unread <task-id>")
    .description("Mark a task unread again, so it shows in the inbox")
    .option("--db <path>", "SQLite queue path", undefined)
    .action(async (taskId: string, opts: { db?: string }) => {
      try {
        // eslint-disable-next-line no-console
        console.log(await runQueueUnread(taskId, { db: opts.db }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  /** Run one write command: print its result, or the core's refusal and exit 1. */
  const write = async (fn: () => Promise<string>): Promise<void> => {
    try {
      // eslint-disable-next-line no-console
      console.log(await fn());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(stripControlChars((err as Error).message));
      process.exit(1);
    }
  };
  queue
    .command("cancel <task-id>")
    .description("Cancel a pending task; a repeating task skips this occurrence")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--series", "Also end the task's repeating series")
    .action((taskId: string, opts: { db?: string; series?: boolean }) =>
      write(() => runQueueCancel(taskId, { db: opts.db, series: opts.series === true })),
    );
  queue
    .command("reschedule <task-id>")
    .description("Move a queued or scheduled task: a new deadline, an exact time, a local day, or after the Claude limit reset")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--by <when>", "Alias of `queue later --until +<dur>` (a duration or an ISO-8601 time); never moves the task earlier")
    .option("--at <when>", "Run at exactly this time (duration or ISO-8601)")
    .option("--day <yyyy-mm-dd>", "Run on this local day, at its cleanest forecast hour")
    .option("--after-limit-reset", "Run after the Claude subscription limit resets, at the cleanest hour after it")
    .action(
      (taskId: string, opts: { db?: string; by?: string; at?: string; day?: string; afterLimitReset?: boolean }) =>
        write(() => runQueueReschedule(taskId, opts)),
    );
  queue
    .command("later <task-id>")
    .description("Push a queued or scheduled task later; it never runs earlier than its planned start")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--until <when>", "+<dur> (+2h), tonight, tomorrow, tomorrow HH:MM, HH:MM, ISO-8601, or after-limit-reset")
    .option("--preset <id>", "1h | tonight | tomorrow_morning | after_limit_reset")
    .option("--delay <minutes>", "Minutes after the planned start")
    .option("--reset-at <when>", "Limit reset time for after-limit-reset (HH:MM or ISO-8601)")
    .action(
      (taskId: string, opts: { db?: string; until?: string; preset?: string; delay?: string; resetAt?: string }) =>
        write(() => runQueueLater(taskId, opts)),
    );
  queue
    .command("run-now <task-id>")
    .description("Mark a queued or scheduled task due now; the next tick runs it")
    .option("--db <path>", "SQLite queue path", undefined)
    .action((taskId: string, opts: { db?: string }) =>
      write(() => runQueueRunNow(taskId, { db: opts.db })),
    );
  queue
    .command("reply <task-id> <text>")
    .description("Continue a completed task: queue a new task with its conversation plus this text")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--by <when>", "Deadline for the reply (default 1h)")
    .action((taskId: string, text: string, opts: { db?: string; by?: string }) =>
      write(() => runQueueReply(taskId, text, { db: opts.db, by: opts.by })),
    );

  const receipts = program
    .command("receipts")
    .description("Inspect carbon receipts");
  receipts
    .command("list")
    .description("List receipts for completed tasks")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--since <iso>", "Only receipts at or after this ISO-8601 time")
    .action(async (opts) => {
      try {
        const res = await runReceiptsList({ db: opts.db, since: opts.since });
        // eslint-disable-next-line no-console
        console.log(res.rendered);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("stats")
    .description("Show local-only personal-impact stats from the queue ledger")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--json", "Emit JSON instead of the human-readable table")
    .action(async (opts) => {
      try {
        const res = await runStats({ db: opts.db, json: opts.json === true });
        // eslint-disable-next-line no-console
        console.log(res.rendered);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("verify [task-id]")
    .description(
      "Verify the Ed25519 signature on a carbon receipt — from the ledger by task_id, or from a JSON file via --file",
    )
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--file <path>", "Path to a receipt JSON file (alternative to task_id)", undefined)
    .option(
      "--trusted-public-key <b64>",
      "Pin the expected signer's public key (base64); fail if the receipt was signed by anyone else",
      undefined,
    )
    .option("--json", "Emit JSON instead of the human-readable summary")
    .action(async (taskId: string | undefined, opts: {
      db?: string;
      file?: string;
      trustedPublicKey?: string;
      json?: boolean;
    }) => {
      try {
        const res = await runVerify({
          taskId,
          db: opts.db,
          file: opts.file,
          trustedPublicKey: opts.trustedPublicKey,
          json: opts.json === true,
        });
        // eslint-disable-next-line no-console
        console.log(res.rendered);
        process.exit(res.exitCode);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(4);
      }
    });

  const usage = program
    .command("usage")
    .description("Claude subscription limits: 5-hour and weekly percent used and their resets; Codex limits; --spend")
    .option("--json", "Print the usage/v1 document")
    .option("--spend", "Add the current 5-hour window's tokens and cost estimate (scans the local Claude Code logs)")
    .action(async (opts: { json?: boolean; spend?: boolean }) => {
      // eslint-disable-next-line no-console
      console.log(await runUsage({ json: opts.json === true, spend: opts.spend === true }));
    });
  usage
    .command("hook [command...]")
    .description(
      "Claude Code statusLine command: records rate_limits to ~/.tidegap/usage.json; after --, runs your statusline command",
    )
    .action(async (command: string[] | undefined) => {
      process.exitCode = await runUsageHook(command ?? []);
    });

  const report = (res: RegionCommandResult) => {
    // eslint-disable-next-line no-console
    if (res.out) console.log(res.out);
    // eslint-disable-next-line no-console
    if (res.err) console.error(res.err);
    process.exitCode = res.exitCode;
  };
  const region = program
    .command("region")
    .description("The grid region every Tidegap surface uses: show, set <zone> (or auto), detect, list");
  region
    .command("show")
    .description("Print the region, where it came from and its data source")
    .option("--json", "Print one JSON object")
    .action((opts: { json?: boolean }) => report(runRegionShow({ json: opts.json === true })));
  region
    .command("set <zone>")
    .description("Store a catalog zone in ~/.tidegap/config (any case); `auto` clears it")
    .option("--json", "Print the new resolution as JSON")
    .action((zone: string, opts: { json?: boolean }) => report(runRegionSet(zone, { json: opts.json === true })));
  region
    .command("detect")
    .description("Print the time-zone guess; stores nothing")
    .option("--json", "Print one JSON object")
    .action((opts: { json?: boolean }) => report(runRegionDetect({ json: opts.json === true })));
  region
    .command("list")
    .description("Print the supported zones with country, grid operator and data source")
    .option("--json", "Print a JSON array")
    .action((opts: { json?: boolean }) => report(runRegionList({ json: opts.json === true })));

  program
    .command("register-wake <task-id>")
    .description("Schedule a macOS wake event 30s before a task's window")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--dry-run", "Print the pmset command without running it")
    .action(async (taskId: string, opts: { db?: string; dryRun?: boolean }) => {
      try {
        const res = await runRegisterWake({
          taskId,
          db: opts.db,
          dryRun: opts.dryRun === true,
        });
        // eslint-disable-next-line no-console
        console.log(res.message);
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("ui")
    .description("Open the local task page: timeline, inbox, task detail, actions (127.0.0.1 only; never dispatches)")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--port <port>", "Port on 127.0.0.1 (default: 47821, or a free port when it is taken; 0: any free port)", (v) => parseInt(v, 10))
    .option("--region <code>", "Region for the forecast curve", undefined)
    .option("--no-open", "Print the URL without opening a browser")
    .action(async (opts: { db?: string; port?: number; region?: string; open?: boolean }) => {
      try {
        const code = await runUi({
          db: opts.db,
          port: opts.port,
          region: opts.region,
          open: opts.open !== false,
          cliVersion: CLI_VERSION,
        });
        process.exit(code);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  /** Run one clients command: print its output, or the error and exit 1. */
  const clientsCommand = (run: () => string) => {
    try {
      // eslint-disable-next-line no-console
      console.log(run());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error((err as Error).message);
      process.exit(1);
    }
  };
  const clients = program
    .command("clients")
    .description("Manage the long-lived tokens of the browser extension and the Mac app (tidegap ui)");
  clients
    .command("add")
    .description("Mint a client token; it is printed once")
    .requiredOption("--name <name>", "A name to recognise the client by")
    .requiredOption("--kind <kind>", "extension | macos")
    .option("--json", "Print {client_id, token} as JSON")
    .action((opts: { name: string; kind: string; json?: boolean }) =>
      clientsCommand(() => runClientsAdd({ name: opts.name, kind: opts.kind, json: opts.json === true })),
    );
  clients
    .command("list")
    .description("List client ids, kinds, names and creation times (never tokens)")
    .option("--json", "Emit JSON")
    .action((opts: { json?: boolean }) => clientsCommand(() => runClientsList({ json: opts.json === true })));
  clients
    .command("revoke <id>")
    .description("Remove a client; its token stops working at once")
    .action((id: string) => clientsCommand(() => runClientsRevoke(id)));

  const channels = program
    .command("channels")
    .description("Notification channels: add (Telegram, webhook, Slack, Discord, ntfy, Pushover, email, Shortcuts, command), test, connect, disconnect, set, remove, list, digest");
  const add = channels
    .command("add <kind>")
    .description(
      "Set up a channel in one step: validate, send a test message, then save. Telegram prints a pairing code instead. " +
        "Secrets come from --secrets-stdin (one JSON object) or a hidden prompt, never from flags. `tidegap channels kinds` lists each kind's flags",
    )
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--no-load", "Telegram: pair only; do not install or load the listener unit")
    .option("--secrets-stdin", "Read the secret fields as one JSON object on stdin, e.g. {\"url\": \"https://…\"}")
    .option("--events <list>", "Comma-separated: task_done,task_failed,clean_window,not_ready,digest (default: the kind's)")
    .option("--quiet <mode>", "night (no messages 22:00–09:00 but the daily summary) or off")
    .option("--clear <fields>", "Comma-separated optional secrets to remove (an empty secret otherwise keeps the stored one)")
    .option("--preset <id>", "Email: gmail, icloud, fastmail or m365 fills the server, port and security")
    .allowUnknownOption()
    .allowExcessArguments();
  const collect = (v: string, prev: string[] = []) => [...prev, v];
  for (const o of kindFieldOptions()) {
    const help = `${o.help} (${o.kinds.join(", ")})${o.repeat ? "; repeat for each line" : ""}`;
    if (o.repeat) add.option(`${o.flag} <value>`, help, collect);
    else add.option(`${o.flag} <value>`, help);
  }
  add.action(async (kind: string, opts: Record<string, unknown> & { db?: string; load?: boolean }, cmd: { args: string[] }) => {
    if (kind === "telegram") {
      process.exitCode = await runChannelsAdd(kind, { noLoad: opts.load === false }, { db: opts.db });
      return;
    }
    process.exitCode = await runChannelsAddKind(kind, { flags: opts, unknown: cmd.args.slice(1) }, { db: opts.db });
  });
  channels
    .command("kinds")
    .description("List the kinds `channels add` takes here, with their flags, secrets and presets")
    .option("--json", "Emit JSON")
    .action((opts: { json?: boolean }) => {
      // eslint-disable-next-line no-console
      console.log(runChannelsKinds({ json: opts.json === true }));
    });
  for (const [action, help] of [
    ["connect", "Connect a disconnected channel with its stored settings: one test message, then it sends again"],
    ["test", "Send a test message to a connected channel; the result is its last delivery"],
    ["disconnect", "Stop sending; settings and secrets stay for `channels connect`"],
  ] as const) {
    channels
      .command(`${action} <id>`)
      .description(help)
      .option("--db <path>", "SQLite queue path", undefined)
      .action(async (id: string, opts: { db?: string }) => {
        process.exitCode = await runChannelsAction(action, id, {}, { db: opts.db });
      });
  }
  channels
    .command("set <id>")
    .description("Change a channel's events and quiet hours (no test message); Telegram chats too")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--events <list>", "Comma-separated: task_done,task_failed,clean_window,not_ready,digest; an empty string sends nothing")
    .option("--quiet <mode>", "night or off")
    .action(async (id: string, opts: { db?: string; events?: string; quiet?: string }) => {
      process.exitCode = await runChannelsAction("set", id, { events: opts.events, quiet: opts.quiet }, { db: opts.db });
    });
  channels
    .command("list")
    .description("List the channels with their state, events, last delivery and target (secrets as hints only)")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--json", "Emit JSON")
    .action((opts: { db?: string; json?: boolean }) => {
      // eslint-disable-next-line no-console
      console.log(runChannelsList({ json: opts.json === true }, { db: opts.db }));
    });
  channels
    .command("remove <id>")
    .description("Remove a channel and its secrets; removing the last telegram channel unloads the listener")
    .option("--db <path>", "SQLite queue path", undefined)
    .action(async (id: string, opts: { db?: string }) => {
      try {
        // eslint-disable-next-line no-console
        console.log(await runChannelsRemove(id, { db: opts.db }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exitCode = EXIT.failed;
      }
    });
  channels
    .command("digest")
    .description("Show or set the daily summary's local send time (default 09:00, the end of quiet hours); channels get it with the digest event")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--at <HH:MM>", "Local send time, 00:00 to 23:59")
    .action((opts: { db?: string; at?: string }) => {
      process.exitCode = runChannelsDigest({ at: opts.at }, { db: opts.db });
    });
  channels
    .command("serve")
    .description("Run the Telegram listener (the listener unit runs this); --once polls one cycle")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--once", "Poll one cycle, then exit")
    .action(async (opts: { db?: string; once?: boolean }) => {
      process.exitCode = await runChannelsServe({ once: opts.once === true }, { db: opts.db });
    });

  registerJobs(program, collect);

  return program;
}

/** Print a jobs command's output, or its refusal on stderr with exit 1 (refused) or 2 (usage). */
async function jobsOut(fn: () => Promise<string> | string): Promise<void> {
  try {
    // eslint-disable-next-line no-console
    console.log(await fn());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(stripControlChars((err as Error).message.split("\n")[0]!));
    process.exitCode = err instanceof JobsCommandError ? err.exitCode : EXIT.failed;
  }
}

/** The `add` and `edit` flags (the plan's usage text, jobs U7). */
function jobFlags(cmd: Command, collect: (v: string, prev?: string[]) => string[]): Command {
  return cmd
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--json", "Emit the job as JSON")
    .option("--title <text>", "Title (required for add)")
    .option("--daily", "Cadence: every day")
    .option("--weekdays", "Cadence: Monday to Friday")
    .option("--weekly <days>", "Cadence: these days, e.g. mon,thu")
    .option("--every <N>h", "Cadence: at least every N hours (2 to 168), counted from the last run")
    .option("--window <HH:MM-HH:MM>", "Only between these local times (daily, weekdays, weekly); edit: none removes it")
    .option("--tz <zone>", "IANA time zone (default: this machine's)")
    .option("--prompt <text>", "Prompt job: the prompt")
    .option("--tools <tools>", "Prompt job tools: none (default), files (Read, Grep, Glob) or web (WebSearch, WebFetch)")
    .option("--command <shell>", "Command job: run with /bin/sh -c by the daemon")
    .option("--summarize <prompt>", "Command job: an LLM step over the output, with no tools")
    .option("--secret <NAME>", "Command job: pass this job secret as an env var (repeatable)", collect)
    .option("--provider <name>", "LLM step provider (default claude-code)")
    .option("--model <id>", "LLM step model (default: the provider's)")
    .option("--cwd <dir>", "Working directory (default ~)")
    .option("--notify <level>", "every (default), failures or summary")
    .option("--command-timeout <dur>", "Command time limit, e.g. 5m (default 5m)")
    .option("--llm-timeout <dur>", "LLM time limit, e.g. 10m (default 10m)")
    .option("--budget <usd>", "LLM budget per run in USD (default 1.00)")
    .option("--file <job.json>", "Read the job from JSON (the client API's JobInput); flags override its fields");
}

function registerJobs(program: Command, collect: (v: string, prev?: string[]) => string[]): void {
  const jobs = program
    .command("jobs")
    .description(
      "Recurring jobs: run a prompt or a command at the cleanest hour, on a cadence. With no command: list jobs. " +
        "The tick runs every occurrence; these commands never dispatch",
    )
    // No options here: commander would take a subcommand's --db and --json for the group.
    .action((_opts: object, cmd: Command) =>
      jobsOut(() => {
        // Commander 12 accepts stray operands: `jobs lsit` must not run the list.
        if (cmd.args.length > 0) throw new JobsCommandError(`unknown command ${JSON.stringify(cmd.args[0])}; see tidegap jobs --help`, EXIT.usage);
        return runJobsList({ hint: true });
      }),
    );
  jobs
    .command("list")
    .description("List active and paused jobs (--all adds removed ones)")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--all", "Include removed jobs")
    .option("--json", "Emit JSON")
    .action((opts: { db?: string; all?: boolean; json?: boolean }) => jobsOut(() => runJobsList(opts)));
  jobs
    .command("show <job-id>")
    .description("Show one job: its guarantee, next and last run, and secret names that are not set")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--json", "Emit JSON (the client API's Job plus recent runs)")
    .action((id: string, opts: { db?: string; json?: boolean }) => jobsOut(() => runJobsShow(id, opts)));
  jobFlags(jobs.command("add").description("Create a job; its first run is planned at once"), collect).action((opts: JobFlags) =>
    jobsOut(() => runJobsAdd(opts)),
  );
  jobFlags(jobs.command("edit <job-id>").description("Change a job: only the fields the flags give"), collect).action(
    (id: string, opts: JobFlags) => jobsOut(() => runJobsEdit(id, opts)),
  );
  for (const [action, name, help] of [
    ["pause", "pause", "Stop running; cancels the pending run"],
    ["resume", "resume", "Start again from now; no backlog"],
    ["run", "run", "Run the next occurrence now (the next tick runs it)"],
    ["remove", "remove", "End the job; its history stays"],
  ] as const) {
    jobs
      .command(`${name} <job-id>`)
      .description(help)
      .option("--db <path>", "SQLite queue path", undefined)
      .option("--json", "Emit JSON")
      .action((id: string, opts: { db?: string; json?: boolean }) => jobsOut(() => runJobsAction(action, id, opts)));
  }
  jobs
    .command("snippet")
    .description(`Print the block that makes a coding agent schedule through Tidegap, not cron (--host: ${AGENT_HOSTS.join(", ")})`)
    .option("--host <name>", "Agent host (default generic)")
    .action((opts: { host?: string }) => jobsOut(() => runJobsSnippet(opts)));
  jobs
    .command("history <job-id>")
    .description("Past runs, newest first, with receipt ids (tidegap verify <id>)")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--limit <N>", "Runs to show (default 20)")
    .option("--json", "Emit JSON")
    .action((id: string, opts: { db?: string; limit?: string; json?: boolean }) => jobsOut(() => runJobsHistory(id, opts)));
  const secrets = jobs.command("secrets").description("Secret names for command jobs; values are never printed");
  secrets
    .command("list")
    .description("List the secret names")
    .option("--json", "Emit JSON")
    .action((opts: { json?: boolean }) => jobsOut(() => runJobsSecretsList(opts)));
  secrets
    .command("set <NAME>")
    .description("Set a secret: the value is one line from stdin (a hidden prompt in a terminal), never an argument")
    .action((name: string, _opts: object, cmd: Command) =>
      jobsOut(() => {
        // Commander 12 accepts excess operands; a value typed here is already in argv and shell history.
        if (cmd.args.length > 1) throw new JobsCommandError(SECRET_VALUE_AS_ARGUMENT, EXIT.usage);
        return runJobsSecretsSet(name);
      }),
    );
  secrets
    .command("remove <NAME>")
    .description("Remove a secret")
    .action((name: string) => jobsOut(() => runJobsSecretsRemove(name)));
}

const isDirect = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url.endsWith(argv1) || import.meta.url.includes("/cli/dist/index.js");
  } catch {
    return false;
  }
})();

if (isDirect) {
  buildProgram().parseAsync(process.argv).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
