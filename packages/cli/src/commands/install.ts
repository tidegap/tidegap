/**
 * `tidegap install` — write and load a launchd plist (macOS) or systemd
 * user units (Linux). Windows is not auto-installed: it prints a
 * ready-to-paste `schtasks` command instead.
 *
 * Without `--laptop` / `--server` the mode follows the machine: laptop on
 * a Mac with a battery, server elsewhere (coherence KTD9). Loading runs
 * through an injected exec: an agent already loaded with the same plist
 * is left alone, and a changed plist is not reloaded while a task runs,
 * because `launchctl bootout` would stop that tick. `--no-load` only
 * writes the files. The output ends with the `tidegap status` lines.
 *
 * The daemon's invocation is resolved at install time to
 * `[process.execPath, realpathSync(process.argv[1])]` — the exact node
 * interpreter plus the real dist entry. This is immune to launchd's bare
 * PATH and to `#!/usr/bin/env node` shebangs (the historical bug: a
 * hardcoded `/usr/local/bin/ebb` (0.17 name) that does not exist on Apple Silicon /
 * homebrew / nvm). `TIDEGAP_BINARY` remains as a documented override.
 *
 * A 0.17 unit (`com.ebb-ai.tick`, `ebb-tick.timer`) is detected, never
 * removed: the next steps print the commands that unload and remove it.
 *
 * In --laptop mode we additionally drop a tiny helper script and print
 * the wake-event story (which needs a sudoers entry); --server skips it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolveTidegapHome, TaskStore, TIDEGAP_HOME_DIR } from "@tidegap/core";
import { readEnvCredentials } from "../env.js";
import {
  currentPlatform,
  defaultPlatformExec,
  detectInstallMode,
  loadAgent,
  type LoadResult,
  type PlatformExec,
  type PlatformName,
} from "../platform/index.js";
import { LAUNCHD_LABEL, LEGACY_LAUNCHD_LABEL, launchdPlist } from "../platform/macos.js";
import { LEGACY_SYSTEMD_UNIT, SYSTEMD_UNIT, systemdService, systemdTimer } from "../platform/linux.js";
import { schtasksTemplate } from "../platform/windows.js";
import { runStatus } from "./status.js";
import { defaultDbPath } from "./tick.js";
import { ensureEnvFile, envFilePath, oldEnvFileNotice } from "./env-file.js";

export type InstallMode = "laptop" | "server";

export interface InstallOptions {
  /** `--laptop` / `--server`; omitted = picked from the machine (`detectInstallMode`). */
  mode?: InstallMode;
  /** `false` (`--no-load`) writes the files and loads nothing. */
  load?: boolean;
  /** Runs `pmset`, `launchctl` and `systemctl` (tests inject a fake). */
  exec?: PlatformExec;
  /** macOS user id for the `gui/<uid>` domain; default `process.getuid()`. */
  uid?: number;
  /** Override platform detection (tests). */
  platform?: PlatformName;
  /**
   * Override the resolved launcher argv (tests). When set, this is used
   * verbatim as the leading `ProgramArguments` / `ExecStart` tokens
   * instead of resolving `process.execPath` + the real script path.
   */
  launcher?: string[];
  /** Override the SQLite path (tests). */
  dbPath?: string;
  /** Override the tick interval. Defaults to 300s. */
  tickIntervalSec?: number;
  /** If true, do not write any files; only return the rendered strings. */
  dryRun?: boolean;
  /** Override the home directory (tests). */
  home?: string;
}

export interface InstallArtifacts {
  platform: PlatformName;
  /** The mode used, and the reason when it was picked rather than passed. */
  mode: InstallMode;
  modeReason?: string;
  /** What loading did; null with `--no-load`, a dry run, or on Windows. */
  load: LoadResult | null;
  /** 1 when loading failed, else 0. */
  exitCode: number;
  /** Resolved launcher argv used for the daemon invocation. */
  launcher: string[];
  /** Warnings surfaced during resolution (e.g. a launcher path that does not exist). */
  warnings: string[];
  /** Path to the standardized secrets file (~/.config/tidegap/env). */
  envFilePath: string;
  /** True when this run created the secrets file. */
  envFileCreated: boolean;
  /** Where the daemon writes its log (`~/.tidegap/logs/tick.log`). */
  logPath: string;
  /** Path that would be written, or "" for non-macOS. */
  plistPath: string;
  /** The rendered plist XML, or "" for non-macOS. */
  plistContent: string;
  /** Path for the systemd `.service` unit, or "" for non-linux. */
  servicePath: string;
  /** The rendered `.service` unit content, or "" for non-linux. */
  serviceContent: string;
  /** Path for the systemd `.timer` unit, or "" for non-linux. */
  timerPath: string;
  /** The rendered `.timer` unit content, or "" for non-linux. */
  timerContent: string;
  /** Path for the laptop-wake helper script, or "" if --server or unsupported. */
  helperPath: string;
  /** Rendered helper script content, or "" if --server or unsupported. */
  helperContent: string;
  /** Human-facing next-steps message. */
  nextSteps: string;
}

/**
 * Resolve the daemon invocation. Preference order:
 *   1. explicit `override` (tests),
 *   2. `TIDEGAP_BINARY` env — a single documented override binary,
 *   3. `[process.execPath, realpathSync(process.argv[1])]` — pin the
 *      exact node + the real dist entry.
 *
 * Pushes a loud warning onto `warnings` if a resolved path does not
 * exist on disk.
 */
export function resolveLauncher(
  override: string[] | undefined,
  warnings: string[],
): string[] {
  if (override && override.length > 0) return override;

  const envBinary = readEnvCredentials().binary;
  if (envBinary) {
    if (!existsSync(envBinary)) {
      warnings.push(
        `TIDEGAP_BINARY points at ${envBinary}, which does not exist — the daemon will fail to launch.`,
      );
    }
    return [envBinary];
  }

  const node = process.execPath;
  const argv1 = process.argv[1];
  let script: string | undefined;
  if (argv1) {
    try {
      script = realpathSync(argv1);
    } catch {
      script = argv1;
    }
  }
  if (!script) {
    warnings.push(
      "Could not resolve the tidegap entry script (process.argv[1] was empty); " +
        "set TIDEGAP_BINARY to the tidegap executable and re-run.",
    );
    return [node];
  }
  if (!existsSync(node)) {
    warnings.push(
      `Resolved node interpreter ${node} does not exist — the daemon will fail to launch.`,
    );
  }
  if (!existsSync(script)) {
    warnings.push(
      `Resolved tidegap entry ${script} does not exist — the daemon will fail to launch.`,
    );
  }
  if (/[\\/]@ebb-ai[\\/]cli[\\/]/.test(script)) {
    // Run through the @ebb-ai/cli 0.17.1 shim: the unit would pin a copy
    // inside @ebb-ai/cli and break when that package is uninstalled.
    warnings.push(
      `The daemon would run ${script}, inside the deprecated @ebb-ai/cli package; it stops working after ` +
        "`npm uninstall -g @ebb-ai/cli`. Run `npm install -g @tidegap/cli`, then `tidegap install` again.",
    );
  }
  return [node, script];
}

/** Shell-quote a single argv token for embedding in the helper script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function helperScript(opts: { launcher: string[]; dbPath: string }): string {
  const tidegap = opts.launcher.map(shq).join(" ");
  const db = shq(opts.dbPath);
  return `#!/usr/bin/env bash
# laptop-wake.sh — register wake events for newly-scheduled Tidegap tasks.
# Generated by \`tidegap install --laptop\`. Re-run any time.

set -euo pipefail

DB=${db}
TIDEGAP=(${tidegap})

# List scheduled tasks and extract their task ids. The queue table has a
# header row + a separator row, so we skip the first two lines (\`tail -n
# +3\`); the id is the first whitespace-delimited column. \`--db "$DB"\` is
# passed to BOTH invocations so a custom queue path is honoured.
# register-wake needs a sudoers entry for pmset/rtcwake; it prints the
# exact command if not authorized.
"\${TIDEGAP[@]}" queue list --db "$DB" --status scheduled \\
  | tail -n +3 \\
  | awk 'NF { print $1 }' \\
  | while read -r TASK_ID; do
      [ -n "$TASK_ID" ] || continue
      "\${TIDEGAP[@]}" register-wake --db "$DB" "$TASK_ID" || true
    done
`;
}

/** File content, or null when it does not exist or cannot be read. */
function readOr(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** True when the ledger has a `running` row (never creates the ledger). */
function taskRunning(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let store: TaskStore | undefined;
  try {
    store = new TaskStore({ dbPath });
    return store.list({ status: "running" }).length > 0;
  } catch {
    return false;
  } finally {
    store?.close();
  }
}

/** The `tidegap status` lines that end a real install (none on a dry run). */
function statusBlock(
  opts: InstallOptions,
  ctx: { dbPath: string; home: string; platform: NodeJS.Platform; exec: PlatformExec; uid: number },
): string {
  if (opts.dryRun) return "";
  const { rendered } = runStatus({
    db: ctx.dbPath,
    home: ctx.home,
    platform: ctx.platform,
    uid: ctx.uid,
    exec: (cmd, args) => ({ status: ctx.exec(cmd, args).status }),
  });
  return `\n${rendered}\n`;
}

export async function runInstall(
  opts: InstallOptions,
): Promise<InstallArtifacts> {
  const platform = opts.platform ?? currentPlatform();
  const home = opts.home ?? homedir();
  const exec = opts.exec ?? defaultPlatformExec;
  const picked = opts.mode ? undefined : detectInstallMode(platform, exec);
  const mode: InstallMode = opts.mode ?? picked!.mode;
  const modeNote = picked
    ? `Picked --${picked.mode}: ${picked.reason}. Pass --${picked.mode === "laptop" ? "server" : "laptop"} to override.\n`
    : "";
  const shouldLoad = opts.load !== false && !opts.dryRun;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const warnings: string[] = [];
  const launcher = resolveLauncher(opts.launcher, warnings);
  // A real install names a left-over 0.17 ~/.ebb-ai on stderr; a dry run
  // touches nothing.
  const dataHome = opts.dryRun
    ? join(home, TIDEGAP_HOME_DIR)
    : resolveTidegapHome(opts.home !== undefined ? { home } : {});
  const dbPath =
    opts.dbPath ?? (opts.dryRun || opts.home !== undefined ? join(dataHome, "queue.db") : defaultDbPath());
  const logPath = join(dataHome, "logs", "tick.log");
  const tickInterval = opts.tickIntervalSec ?? 300;

  // Create the standardized secrets file (0600) if absent. Never on dry-run
  // (tests). A 0.17 secrets file left alone is named under the warnings.
  const envPath = envFilePath(home);
  const oldEnvNotice = oldEnvFileNotice(home);
  if (oldEnvNotice) warnings.push(oldEnvNotice);
  let envFileCreated = false;
  if (!opts.dryRun) envFileCreated = ensureEnvFile(envPath).created;
  const secretsNote =
    `\nProvider keys: ${envFileCreated ? "created" : "expected at"} ${envPath} (0600).\n` +
    `   Add ANTHROPIC_API_KEY / OPENAI_API_KEY there; \`tidegap tick\` loads it on startup.`;
  const warnBlock =
    warnings.length > 0
      ? `\n!! WARNING:\n` +
        warnings.map((w) => `   - ${w}`).join("\n") +
        `\n`
      : "";

  if (platform === "macos") {
    const plistContent = launchdPlist({
      tickIntervalSec: tickInterval,
      launcher,
      dbPath,
      logPath,
    });
    const agentsDir = join(home, "Library", "LaunchAgents");
    const plistPath = join(agentsDir, `${LAUNCHD_LABEL}.plist`);
    const legacyPlist = join(agentsDir, `${LEGACY_LAUNCHD_LABEL}.plist`);
    const helperContent =
      mode === "laptop" ? helperScript({ launcher, dbPath }) : "";
    const helperPath =
      mode === "laptop" ? join(dataHome, "laptop-wake.sh") : "";

    const changed = readOr(plistPath) !== plistContent;
    if (!opts.dryRun) {
      // launchd does not create the StandardOutPath parent directory.
      mkdirSync(dirname(logPath), { recursive: true });
      mkdirSync(dirname(plistPath), { recursive: true });
      writeFileSync(plistPath, plistContent, "utf8");
      mkdirSync(dirname(dbPath), { recursive: true });
      if (helperPath) {
        mkdirSync(dirname(helperPath), { recursive: true });
        writeFileSync(helperPath, helperContent, {
          encoding: "utf8",
          mode: 0o755,
        });
      }
    }

    const load = shouldLoad
      ? loadAgent({ kind: "launchd", label: LAUNCHD_LABEL, plistPath, uid, changed, busy: taskRunning(dbPath) }, exec)
      : null;
    const loadLine = load
      ? load.message
      : `Not loaded${opts.dryRun ? "" : " (--no-load)"}. Load it with:\n     launchctl bootstrap gui/${uid} ${plistPath}`;
    const wakeNote =
      mode === "laptop"
        ? `\n2. Pre-register wake events as tasks are scheduled:\n` +
          `     ${helperPath}\n` +
          `   (Requires a sudoers entry so \`pmset schedule wake\` runs without a\n` +
          `    password prompt — see \`tidegap register-wake\` output for the exact line.)`
        : "";
    const cleanup = existsSync(legacyPlist)
      ? `\n${mode === "laptop" ? 3 : 2}. Remove the 0.17 agent (it ticks the same ledger):\n` +
        `     launchctl unload ${legacyPlist}\n` +
        `     rm ${legacyPlist}`
      : "";
    const nextSteps =
      warnBlock +
      modeNote +
      `Wrote ${plistPath}.\n` +
      secretsNote +
      `\n\n${loadLine}\n` +
      `\nNext steps:\n` +
      `1. (optional) Tail the log:\n` +
      `     tail -f ${logPath}${wakeNote}${cleanup}\n` +
      statusBlock(opts, { dbPath, home, platform: "darwin", exec, uid });

    return {
      platform,
      mode,
      modeReason: picked?.reason,
      load,
      exitCode: load && !load.ok ? 1 : 0,
      launcher,
      warnings,
      envFilePath: envPath,
      envFileCreated,
      logPath,
      plistPath,
      plistContent,
      servicePath: "",
      serviceContent: "",
      timerPath: "",
      timerContent: "",
      helperPath,
      helperContent,
      nextSteps,
    };
  }

  if (platform === "linux") {
    const serviceContent = systemdService({
      launcher,
      dbPath,
      logPath,
    });
    const timerContent = systemdTimer({
      tickIntervalSec: tickInterval,
    });
    const systemdDir = join(home, ".config", "systemd", "user");
    const servicePath = join(systemdDir, `${SYSTEMD_UNIT}.service`);
    const timerPath = join(systemdDir, `${SYSTEMD_UNIT}.timer`);
    const legacyService = join(systemdDir, `${LEGACY_SYSTEMD_UNIT}.service`);
    const legacyTimer = join(systemdDir, `${LEGACY_SYSTEMD_UNIT}.timer`);
    const helperContent =
      mode === "laptop" ? helperScript({ launcher, dbPath }) : "";
    const helperPath =
      mode === "laptop" ? join(dataHome, "laptop-wake.sh") : "";

    const changed = readOr(servicePath) !== serviceContent || readOr(timerPath) !== timerContent;
    if (!opts.dryRun) {
      // systemd `StandardOutput=append:` does not create the parent directory.
      mkdirSync(dirname(logPath), { recursive: true });
      mkdirSync(systemdDir, { recursive: true });
      writeFileSync(servicePath, serviceContent, "utf8");
      writeFileSync(timerPath, timerContent, "utf8");
      mkdirSync(dirname(dbPath), { recursive: true });
      if (helperPath) {
        mkdirSync(dirname(helperPath), { recursive: true });
        writeFileSync(helperPath, helperContent, {
          encoding: "utf8",
          mode: 0o755,
        });
      }
    }

    const load = shouldLoad ? loadAgent({ kind: "systemd", unit: `${SYSTEMD_UNIT}.timer`, changed }, exec) : null;
    const loadLine = load
      ? load.message
      : `Not enabled${opts.dryRun ? "" : " (--no-load)"}. Enable it with:\n` +
        `     systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}.timer`;
    const wakeNote =
      mode === "laptop"
        ? `\n2. Pre-register wake events as tasks are scheduled:\n` +
          `     ${helperPath}\n` +
          `   (Requires a sudoers entry so \`rtcwake\` runs without a password\n` +
          `    prompt — see \`tidegap register-wake\` output for the exact line.)`
        : "";
    const cleanup = existsSync(legacyTimer) || existsSync(legacyService)
      ? `\n${mode === "laptop" ? 3 : 2}. Remove the 0.17 timer (it ticks the same ledger):\n` +
        `     systemctl --user disable --now ${LEGACY_SYSTEMD_UNIT}.timer\n` +
        `     rm ${legacyService} ${legacyTimer}\n` +
        `     systemctl --user daemon-reload`
      : "";
    const nextSteps =
      warnBlock +
      modeNote +
      `Wrote ${servicePath}\n` +
      `Wrote ${timerPath}` +
      secretsNote +
      `\n\n${loadLine}\n` +
      `\nNext steps:\n` +
      `1. (optional) Tail the log:\n` +
      `     tail -f ${logPath}${wakeNote}${cleanup}\n` +
      statusBlock(opts, { dbPath, home, platform: "linux", exec, uid });

    return {
      platform,
      mode,
      modeReason: picked?.reason,
      load,
      exitCode: load && !load.ok ? 1 : 0,
      launcher,
      warnings,
      envFilePath: envPath,
      envFileCreated,
      logPath,
      plistPath: "",
      plistContent: "",
      servicePath,
      serviceContent,
      timerPath,
      timerContent,
      helperPath,
      helperContent,
      nextSteps,
    };
  }

  // windows — no auto-install; print a ready-to-paste schtasks command.
  const template = schtasksTemplate({
    launcher,
    dbPath,
    tickIntervalSec: tickInterval,
  });
  return {
    platform,
    mode,
    modeReason: picked?.reason,
    load: null,
    exitCode: 0,
    launcher,
    warnings,
    envFilePath: envPath,
    envFileCreated,
    logPath,
    plistPath: "",
    plistContent: "",
    servicePath: "",
    serviceContent: "",
    timerPath: "",
    timerContent: "",
    helperPath: "",
    helperContent: "",
    nextSteps: warnBlock + modeNote + template,
  };
}
