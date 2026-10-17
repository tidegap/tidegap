#!/usr/bin/env node
// Agent-path check: proves an agent can find, read and follow the install
// path on a running site (a local `next start` or production). Node built-ins
// only. Prints one line per check, then PASS; on the first failure it prints
// the URL and the wrong value and exits 1.
//
//   node scripts/check-agent-files.mjs --base http://localhost:3100 \
//     [--only install,llms,head,crawl,docs]
//
// Groups:
//   install  /install.md: 200, text/markdown, required headings, one heading
//            per `installHeading` in apps/web/src/lib/hosts.ts, no local
//            paths in fenced commands; claims row 18 equals HOST_COUNT.
//   llms     /llms.txt: 200; every https://www.tidegap.com/... link in it,
//            rewritten to --base, returns 200.
//   head     /: Link header and <link rel=alternate> to /install.md, JSON-LD
//            SoftwareApplication with installUrl; /api/* has no Link header.
//   crawl    robots.txt allows / and disallows only /api/; sitemap.xml lists
//            /install.md, /llms.txt and /llms-full.txt.
//   docs     /llms-full.txt: 200 with every docs category label; /docs has
//            FAQPage JSON-LD and both text/markdown alternates.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://www.tidegap.com";
const GROUPS = ["install", "llms", "head", "crawl", "docs"];
const REQUIRED_HEADINGS = [
  "Pick the install path for the host you're in",
  "Run tasks on time",
  "Configure",
  "Confirm the install worked",
];
const DOCS_CATEGORIES = ["Install", "Hosts", "CLI", "MCP tools", "UI & apps", "Receipts & carbon", "Config", "FAQ"];

class CheckError extends Error {}

function parseArgs(argv) {
  const args = { base: process.env.AGENT_BASE ?? "http://localhost:3000", only: GROUPS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!v) throw new CheckError(`${a} needs a value`);
      return v;
    };
    if (a.startsWith("--base")) args.base = val().replace(/\/+$/, "");
    else if (a.startsWith("--only")) args.only = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--") continue;
    else throw new CheckError(`unknown argument ${a}`);
  }
  const bad = args.only.filter((g) => !GROUPS.includes(g));
  if (bad.length) throw new CheckError(`unknown group(s) ${bad.join(", ")}; use ${GROUPS.join(",")}`);
  return args;
}

const ok = (msg) => console.log(`ok    ${msg}`);
function fail(url, msg) {
  throw new CheckError(`${url}: ${msg}`);
}

async function get(base, path, method = "GET") {
  const url = `${base}${path}`;
  let res;
  try {
    res = await fetch(url, { method, redirect: "follow", headers: { "user-agent": "tidegap-check-agent-files" } });
  } catch (err) {
    fail(url, `fetch failed (${err.cause?.code ?? err.message})`);
  }
  const body = method === "HEAD" ? "" : await res.text();
  return { url, res, body };
}

/** `{ id, installHeading, group }` per host entry in hosts.ts, string constants resolved. */
export function readHosts(src) {
  const consts = Object.fromEntries(
    [...src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"\s*;/g)].map((m) => [m[1], m[2]]),
  );
  const hosts = [];
  for (const block of src.split(/\n\s{2}\{\n/).slice(1)) {
    const id = block.match(/^\s*id:\s*"([^"]+)"/m)?.[1];
    const h = block.match(/^\s*installHeading:\s*(?:"([^"]+)"|([A-Z_][A-Z0-9_]*))/m);
    const group = block.match(/^\s*group:\s*"([^"]+)"/m)?.[1];
    if (!id) continue;
    hosts.push({ id, group, installHeading: h ? (h[1] ?? consts[h[2]]) : undefined });
  }
  return hosts;
}

function headings(md) {
  const out = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced) {
      const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

function fencedBlocks(md) {
  return [...md.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);
}

function linkTags(html) {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => {
    const attrs = {};
    for (const a of m[0].matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3];
    return attrs;
  });
}

function markdownAlternates(html) {
  return linkTags(html)
    .filter((l) => l.rel === "alternate" && l.type === "text/markdown")
    .map((l) => l.href.replace(SITE, ""));
}

function jsonLdNodes(html, url) {
  const nodes = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      fail(url, "JSON-LD does not parse");
    }
    for (const d of [data].flat()) nodes.push(...(d["@graph"] ?? [d]));
  }
  return nodes;
}

async function checkInstall(base) {
  const { url, res, body } = await get(base, "/install.md");
  if (res.status !== 200) fail(url, `status ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("text/markdown")) fail(url, `content-type "${type}", want text/markdown`);
  ok(`/install.md 200 ${type}`);

  const hs = headings(body);
  for (const h of REQUIRED_HEADINGS) if (!hs.includes(h)) fail(url, `missing heading "${h}"`);
  ok(`/install.md has ${REQUIRED_HEADINGS.length} required headings`);

  const hosts = readHosts(readFileSync(join(ROOT, "apps/web/src/lib/hosts.ts"), "utf8"));
  if (hosts.length === 0) fail("apps/web/src/lib/hosts.ts", "no host entries parsed");
  for (const host of hosts) {
    if (!host.installHeading) fail("apps/web/src/lib/hosts.ts", `host "${host.id}" has no installHeading`);
    if (!hs.includes(host.installHeading)) fail(url, `no heading "${host.installHeading}" for host "${host.id}"`);
  }
  ok(`/install.md covers all ${hosts.length} hosts.ts entries`);

  for (const block of fencedBlocks(body)) {
    const local = block.match(/(?:^|[\s"'(=])(\.\.?\/[\w./-]+|packages\/[\w./-]+|apps\/[\w./-]+)/m);
    if (local) fail(url, `fenced block uses a local path "${local[1]}"`);
  }
  ok("/install.md fenced blocks use published names only");

  const hostCount = hosts.filter((h) => h.group !== "lib").length;
  const row18 = readFileSync(join(ROOT, "docs/claims.md"), "utf8").split("\n").find((l) => l.startsWith("| 18 |"));
  const claimed = row18?.match(/"(\d+) hosts"/)?.[1];
  if (String(hostCount) !== claimed) fail("docs/claims.md", `row 18 says "${claimed} hosts", HOST_COUNT is ${hostCount}`);
  ok(`claims row 18 = HOST_COUNT (${hostCount})`);
}

async function checkLlms(base) {
  const { url, res, body } = await get(base, "/llms.txt");
  if (res.status !== 200) fail(url, `status ${res.status}`);
  ok("/llms.txt 200");
  const paths = [...new Set([...body.matchAll(/https:\/\/www\.tidegap\.com(\/[^\s)<>"'`]*)?/g)].map((m) => (m[1] ?? "/").replace(/[.,;:]+$/, "")))];
  for (const path of paths) {
    const r = await get(base, path.split("#")[0] || "/");
    if (r.res.status !== 200) fail(r.url, `status ${r.res.status} (linked from /llms.txt)`);
  }
  ok(`/llms.txt: ${paths.length} site links resolve`);
}

async function checkHead(base) {
  const { url, res, body } = await get(base, "/");
  if (res.status !== 200) fail(url, `status ${res.status}`);
  const link = res.headers.get("link") ?? "";
  if (!/<\/install\.md>;\s*rel="alternate";\s*type="text\/markdown"/.test(link)) fail(url, `Link header "${link}"`);
  ok("/ Link header -> /install.md");
  if (!markdownAlternates(body).includes("/install.md")) fail(url, "no <link rel=alternate type=text/markdown href=/install.md>");
  ok("/ <link rel=alternate> -> /install.md");
  const app = jsonLdNodes(body, url).find((n) => n["@type"] === "SoftwareApplication");
  if (!app) fail(url, "no SoftwareApplication JSON-LD");
  if (!String(app.installUrl ?? "").endsWith("/install.md")) fail(url, `JSON-LD installUrl "${app.installUrl}"`);
  ok(`/ JSON-LD SoftwareApplication installUrl ${app.installUrl}`);
  const api = await get(base, "/api/grid/GB", "HEAD");
  if (api.res.headers.get("link")) fail(api.url, `unexpected Link header "${api.res.headers.get("link")}"`);
  ok("/api/grid/GB has no Link header");
}

async function checkCrawl(base) {
  const robots = await get(base, "/robots.txt");
  if (robots.res.status !== 200) fail(robots.url, `status ${robots.res.status}`);
  const lines = robots.body.split("\n").map((l) => l.trim());
  const disallows = [...new Set(lines.filter((l) => /^disallow:/i.test(l)).map((l) => l.split(":")[1].trim()))];
  if (disallows.join() !== "/api/") fail(robots.url, `disallows [${disallows.join(", ")}], want only /api/`);
  if (!lines.some((l) => /^allow:\s*\/$/i.test(l))) fail(robots.url, "no Allow: /");
  ok("robots.txt allows / and disallows only /api/");
  const sm = await get(base, "/sitemap.xml");
  if (sm.res.status !== 200) fail(sm.url, `status ${sm.res.status}`);
  for (const p of ["/install.md", "/llms.txt", "/llms-full.txt"]) {
    if (!sm.body.includes(`<loc>${SITE}${p}</loc>`)) fail(sm.url, `missing ${p}`);
  }
  ok("sitemap.xml lists /install.md, /llms.txt, /llms-full.txt");
}

async function checkDocs(base) {
  const full = await get(base, "/llms-full.txt");
  if (full.res.status !== 200) fail(full.url, `status ${full.res.status}`);
  for (const label of DOCS_CATEGORIES) if (!full.body.includes(label)) fail(full.url, `missing category "${label}"`);
  ok(`/llms-full.txt 200 with ${DOCS_CATEGORIES.length} categories`);
  const docs = await get(base, "/docs");
  if (docs.res.status !== 200) fail(docs.url, `status ${docs.res.status}`);
  if (!jsonLdNodes(docs.body, docs.url).some((n) => n["@type"] === "FAQPage")) fail(docs.url, "no FAQPage JSON-LD");
  ok("/docs FAQPage JSON-LD");
  const alts = markdownAlternates(docs.body);
  for (const p of ["/install.md", "/llms-full.txt"]) if (!alts.includes(p)) fail(docs.url, `no text/markdown alternate ${p} (has ${alts.join(", ") || "none"})`);
  ok("/docs alternates -> /install.md, /llms-full.txt");
}

const RUN = { install: checkInstall, llms: checkLlms, head: checkHead, crawl: checkCrawl, docs: checkDocs };

async function main() {
  const { base, only } = parseArgs(process.argv.slice(2));
  console.log(`base ${base} · groups ${only.join(",")}`);
  for (const g of GROUPS) if (only.includes(g)) await RUN[g](base);
  console.log("PASS");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.log(`FAIL  ${err instanceof CheckError ? err.message : err.stack}`);
    process.exit(1);
  });
}
