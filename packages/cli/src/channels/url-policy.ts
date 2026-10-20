/**
 * URL policy of the HTTP channel kinds (integrations plan KTD8): allow the
 * user's own network, block a short list.
 *
 * - Allowed: `http` and `https` to public, private and loopback hosts (LAN
 *   receivers such as Home Assistant, self-hosted ntfy or n8n are core use).
 * - Blocked: other schemes, userinfo in the URL, link-local and cloud
 *   metadata addresses, the unspecified address, and the `tidegap ui`
 *   server's own loopback port.
 * - Plain `http` to a host that is not private is allowed with the warning
 *   `cleartext`: the message travels unencrypted.
 *
 * {@link checkUrl} runs on the literal host at connect time; {@link checkAddress}
 * runs at send time on every address the connection's DNS lookup returns, so
 * a name that later resolves to a blocked address (DNS rebinding) is refused
 * on the socket that would use it (see `http.ts`).
 */

import { BlockList, isIP } from "node:net";

import { DEFAULT_UI_PORT, readDiscovery } from "../ui/discovery.js";

export type UrlPolicyCode = "invalid_url" | "scheme" | "userinfo" | "blocked_address" | "ui_port";

export type UrlPolicyResult = { ok: true; url: URL; warning?: "cleartext" } | { ok: false; code: UrlPolicyCode };

export interface UrlPolicyOptions {
  /** Loopback ports of the `tidegap ui` server; a URL to one of them is refused. */
  uiPorts: readonly number[];
}

function list(v4: readonly string[], v6: readonly string[]): BlockList {
  const b = new BlockList();
  for (const [fam, nets] of [["ipv4", v4], ["ipv6", v6]] as const) {
    for (const net of nets) {
      const [a, p] = net.split("/");
      b.addSubnet(a!, Number(p), fam);
    }
  }
  return b;
}

/**
 * Link-local (169.254/16, fe80::/10: AWS, GCP and Azure metadata live at
 * 169.254.169.254), the AWS and GCP IPv6 metadata addresses, Alibaba's
 * 100.100.100.200, and the unspecified addresses (0.0.0.0/8, ::), which
 * reach the local host. IPv4-mapped IPv6 forms match the IPv4 rules
 * (`BlockList` maps them); the NAT64, 6to4 and IPv4-compatible forms of
 * 169.254/16 are listed explicitly.
 */
const BLOCKED = list(
  ["169.254.0.0/16", "100.100.100.200/32", "0.0.0.0/8"],
  ["fe80::/10", "fd00:ec2::254/128", "fd20:ce::254/128", "::/128", "64:ff9b::a9fe:0/112", "2002:a9fe::/32", "::a9fe:0/112"],
);

const LOOPBACK = list(["127.0.0.0/8", "0.0.0.0/8"], ["::1/128", "::/128"]);

/** Addresses that never leave the user's network: loopback, RFC 1918, CGNAT (Tailscale), unique local IPv6. */
const PRIVATE = list(["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"], ["::1/128", "fc00::/7"]);

/** Names that resolve only inside the user's network. */
const PRIVATE_NAME = /(^localhost$|\.localhost$|\.local$|\.lan$|\.home\.arpa$|\.internal$|^[^.]+$)/i;

/** A URL hostname without IPv6 brackets. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function family(ip: string): "ipv4" | "ipv6" | undefined {
  const v = isIP(ip);
  return v === 4 ? "ipv4" : v === 6 ? "ipv6" : undefined;
}

function inList(b: BlockList, ip: string): boolean {
  const f = family(ip);
  return f !== undefined && b.check(ip, f);
}

/** The port a URL connects to. */
export function urlPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
}

/**
 * The send-time check of one resolved address (or an IP literal): `ok`, or
 * the policy code that refuses it.
 */
export function checkAddress(ip: string, port: number, opts: UrlPolicyOptions): { ok: true } | { ok: false; code: "blocked_address" | "ui_port" } {
  const addr = bareHost(ip);
  if (inList(LOOPBACK, addr) && opts.uiPorts.includes(port)) return { ok: false, code: "ui_port" };
  if (inList(BLOCKED, addr)) return { ok: false, code: "blocked_address" };
  return { ok: true };
}

/** The connect-time check of a URL on its literal host (KTD8). */
export function checkUrl(raw: string, opts: UrlPolicyOptions): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "scheme" };
  if (url.username || url.password) return { ok: false, code: "userinfo" };
  const host = bareHost(url.hostname);
  const port = urlPort(url);
  const isIp = family(host) !== undefined;
  if (isIp) {
    const res = checkAddress(host, port, opts);
    if (!res.ok) return res;
  } else if (/^localhost$|\.localhost$/i.test(host) && opts.uiPorts.includes(port)) {
    return { ok: false, code: "ui_port" };
  }
  const isPrivate = isIp ? inList(PRIVATE, host) : PRIVATE_NAME.test(host);
  return url.protocol === "http:" && !isPrivate ? { ok: true, url, warning: "cleartext" } : { ok: true, url };
}

/**
 * The `tidegap ui` ports the policy refuses: the running server's port from
 * the discovery file in `stateDir` (when one is written) and the default
 * port, so the CLI applies the rule with no server running.
 */
export function uiPortsFor(stateDir: string): number[] {
  const running = readDiscovery(stateDir)?.port;
  return running !== undefined && running !== DEFAULT_UI_PORT ? [running, DEFAULT_UI_PORT] : [DEFAULT_UI_PORT];
}
