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
 *   tidegap channels       pair Telegram (`add telegram`), list, remove, and the listener (`serve`)
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { stripControlChars } from "@tidegap/core";
import { Command } from "commander";
import { runChannelsAdd, runChannelsList, runChannelsRemove, runChannelsServe } from "./commands/channels.js";
import { runClientsAdd, runClientsList, runClientsRevoke } from "./commands/clients.js";
import { runInstall, type InstallMode } from "./commands/install.js";
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
    .action((opts: { db?: string; json?: boolean }) => {
      const res = runStatus({ db: opts.db, json: opts.json === true });
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
    .description("Telegram: pair a chat, list or remove channels, and run the listener (os notifications are built in)");
  channels
    .command("add <kind>")
    .description("Pair a channel; the only kind is telegram. Prints a one-time code to send to your bot")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--no-load", "Pair only; do not install or load the listener unit")
    .action(async (kind: string, opts: { db?: string; load?: boolean }) => {
      process.exitCode = await runChannelsAdd(kind, { noLoad: opts.load === false }, { db: opts.db });
    });
  channels
    .command("list")
    .description("List the paired channels")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--json", "Emit JSON")
    .action((opts: { db?: string; json?: boolean }) => {
      // eslint-disable-next-line no-console
      console.log(runChannelsList({ json: opts.json === true }, { db: opts.db }));
    });
  channels
    .command("remove <id>")
    .description("Remove a channel; removing the last telegram channel unloads the listener")
    .option("--db <path>", "SQLite queue path", undefined)
    .action(async (id: string, opts: { db?: string }) => {
      try {
        // eslint-disable-next-line no-console
        console.log(await runChannelsRemove(id, { db: opts.db }));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  channels
    .command("serve")
    .description("Run the Telegram listener (the listener unit runs this); --once polls one cycle")
    .option("--db <path>", "SQLite queue path", undefined)
    .option("--once", "Poll one cycle, then exit")
    .action(async (opts: { db?: string; once?: boolean }) => {
      process.exitCode = await runChannelsServe({ once: opts.once === true }, { db: opts.db });
    });

  return program;
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
