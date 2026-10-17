/**
 * The usage module as the core `LimitResetSource` (coherence KTD5): the
 * Claude limit reset for "Later → after limit reset". Claude subscription
 * limits apply to `claude-code` tasks and to `anthropic` tasks, which
 * Claude Code serves when no API key is set; other providers get null.
 */

import type { LimitResetSource } from "@tidegap/core";

import { hostResetTarget, type HostLimitsOptions } from "./host.js";

const CLAUDE_PROVIDERS = new Set(["claude-code", "anthropic"]);

/** A `LimitResetSource` over `hostResetTarget`; `source` reads `usage:<window>`. */
export function usageLimitResetSource(opts: HostLimitsOptions = {}): LimitResetSource {
  return async (task, now) => {
    let spec: { provider?: string; model?: string };
    try {
      spec = JSON.parse(task.bodyJson ?? "") as typeof spec;
    } catch {
      return null;
    }
    if (!spec.provider || !CLAUDE_PROVIDERS.has(spec.provider)) return null;
    const res = await hostResetTarget({ ...opts, now, model: spec.model });
    return res.ok ? { at: res.target.at, source: `usage:${res.target.window}` } : null;
  };
}
