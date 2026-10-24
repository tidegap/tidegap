/**
 * `tidegap jobs snippet [--host <name>]` (jobs U15, R35, R36): print the
 * block that makes a coding agent schedule recurring work through Tidegap
 * instead of cron, with the files each host reads it from.
 */

import { AGENT_HOSTS, isAgentHost, renderAgentSnippet, type AgentHost } from "@tidegap/core";

import { EXIT } from "./channels.js";
import { JobsCommandError } from "./jobs.js";

/** Names accepted besides {@link AGENT_HOSTS}. */
const ALIASES: Record<string, AgentHost> = { "claude-code": "claude" };

/** The snippet text for `host` (default `generic`); a usage error names the hosts. */
export function runJobsSnippet(opts: { host?: string }): string {
  const name = (opts.host ?? "generic").trim().toLowerCase();
  const host = ALIASES[name] ?? name;
  if (!isAgentHost(host)) {
    throw new JobsCommandError(`unknown host ${JSON.stringify(opts.host)}; use one of: ${AGENT_HOSTS.join(", ")}`, EXIT.usage);
  }
  return renderAgentSnippet(host);
}
