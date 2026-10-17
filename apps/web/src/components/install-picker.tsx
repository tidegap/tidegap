"use client";

import { useMemo, useState } from "react";

import { GROUP_LABELS, HOSTS, type Host } from "@/lib/hosts";

export function InstallPicker() {
  const [hostId, setHostId] = useState<string>("mcp");
  const [copied, setCopied] = useState(false);

  const host: Host = useMemo(
    () => HOSTS.find((h) => h.id === hostId) ?? HOSTS[0]!,
    [hostId],
  );

  const grouped = useMemo(() => {
    const out: Record<Host["group"], Host[]> = {
      mcp: [],
      ide: [],
      agent: [],
      lib: [],
    };
    for (const h of HOSTS) out[h.group].push(h);
    return out;
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(host.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — fall back to manual select
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="font-mono text-[11px] uppercase tracking-wider text-fg-dim sm:min-w-[120px]">
          install for
        </span>
        <select
          value={hostId}
          onChange={(e) => setHostId(e.target.value)}
          className="w-full rounded-md border border-rule bg-bg-elev px-3 py-2 font-mono text-sm text-fg outline-none transition-colors hover:border-accent/40 focus:border-accent sm:max-w-md"
        >
          {(Object.keys(grouped) as Host["group"][]).map((g) => (
            <optgroup key={g} label={GROUP_LABELS[g]}>
              {grouped[g].map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <p className="text-sm text-fg-muted">{host.desc}</p>

      <div className="relative rounded-md border border-rule bg-bg overflow-hidden">
        <div className="flex items-center justify-between border-b border-rule bg-bg-elev px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-fg-dim">
            {host.lang}
          </span>
          <button
            type="button"
            onClick={copy}
            className="rounded px-2 py-0.5 font-mono text-[11px] text-fg-muted transition-colors hover:bg-bg-card hover:text-accent"
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-fg">
          <code>{host.command}</code>
        </pre>
      </div>

      <p className="text-sm text-fg-muted">
        <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
          then
        </span>{" "}
        {host.followup}
      </p>
    </div>
  );
}
