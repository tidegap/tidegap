#!/usr/bin/env node
// Generate the /docs page data and /llms-full.txt from one set of sources:
//   - apps/web/content/docs/NN-<id>.md   one file per category (frontmatter: id, label)
//   - apps/web/public/install.md          the host sections, from the H2
//                                         "## Pick the install path for the host you're in"
//                                         to the next H2
//   - the built @tidegap/core dist        the MCP tool list (toolsForHost("mcp"))
//                                         and the per-model energy coefficients
//
// Outputs (both committed; `pnpm gen:docs:check` regenerates and fails on a diff):
//   apps/web/src/lib/docs.generated.ts    sections, headings, HTML blocks, embeds, FAQ pairs
//   apps/web/public/llms-full.txt         install.md, then every category as markdown
//
// The markdown renderer below covers the subset the docs use (headings, paragraphs,
// lists, fenced code, tables, block quotes, rules, inline code, links, bold, italic).
// It keeps the generator dependency-free. Deterministic: two runs give identical bytes.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTENT_DIR = join(ROOT, "apps/web/content/docs");
const INSTALL_MD = join(ROOT, "apps/web/public/install.md");
export const OUT_TS = join(ROOT, "apps/web/src/lib/docs.generated.ts");
export const OUT_LLMS = join(ROOT, "apps/web/public/llms-full.txt");
const SITE = "https://www.tidegap.com";

/** The H2 that opens the host range in install.md (KTD4). */
export const HOSTS_H2 = "Pick the install path for the host you're in";

/** Ids that old deep links use; each must exist as an explicit `{#id}` (R19). */
export const REQUIRED_IDS = ["commands", "energy", "paths", "env"];

/** Embeds the page renders as components; the rest resolve at generation time. */
export const PAGE_EMBEDS = ["install-picker"];
export const BUILD_EMBEDS = ["install-hosts", "tools", "energy"];

/** Model classes in the energy table; values come from the core dist. */
export const ENERGY_ROWS = [
  { label: "claude-opus-5 · claude-fable-5-1 · gpt-6-astra · o3", model: "claude-opus-5" },
  { label: "gpt-4o · gemini-3.1-pro", model: "gpt-4o" },
  { label: "claude-sonnet-5 · gpt-6-sol · llama-3.1-70b", model: "claude-sonnet-5" },
  { label: "claude-haiku-4-5 · gpt-6-luna · gemini-3.8-flash · gpt-4o-mini", model: "claude-haiku-4-5" },
  { label: "llama-3.1-8b · mistral-7b", model: "llama-3-1-8b" },
  { label: "llama-3.1-405b · gpt-4", model: "llama-3-1-405b" },
];

export class DocsError extends Error {}
const fail = (msg) => {
  throw new DocsError(msg);
};

// ── Small helpers ───────────────────────────────────────────────────────────

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const ENTITIES = { "&quot;": '"', "&lt;": "<", "&gt;": ">", "&amp;": "&" };

/**
 * Renderer HTML to plain text: drop the renderer's own tags, then decode the entities it
 * emits in one pass. Every literal `<` in the source was escaped to `&lt;` by the renderer,
 * so each raw `<` here opens a renderer tag. The result is plain text: callers escape it
 * again (escapeHtml, JSON) before it reaches HTML.
 */
export function toPlain(html) {
  let text = "";
  let inTag = false;
  for (const ch of html) {
    if (inTag) inTag = ch !== ">";
    else if (ch === "<") inTag = true;
    else text += ch;
  }
  return text
    .replace(/&(?:quot|lt|gt|amp);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a `---` frontmatter block of `key: value` lines. */
export function parseFrontmatter(src, file = "<input>") {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) fail(`${file}: missing frontmatter (id, label)`);
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  for (const key of ["id", "label"]) if (!data[key]) fail(`${file}: frontmatter needs "${key}"`);
  const bodyStartLine = m[0].split("\n").length - (m[0].endsWith("\n") ? 1 : 0);
  return { data, body: src.slice(m[0].length), bodyStartLine };
}

// ── Inline markdown ─────────────────────────────────────────────────────────

function renderInline(text) {
  // Code spans first, so nothing inside them is treated as markup.
  return text
    .split(/(`[^`]*`)/)
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      // Finished links are parked behind placeholders, so emphasis never rewrites an href.
      const links = [];
      const park = (html) => `\u0000${links.push(html) - 1}\u0000`;
      let s = escapeHtml(part.replace(/\\([|*_`\\[\]])/g, "$1"));
      s = s.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => park(link(url, url)));
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => park(link(url, emphasis(label))));
      return emphasis(s).replace(/\u0000(\d+)\u0000/g, (_, n) => links[Number(n)]);
    })
    .join("");
}

function emphasis(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
}

/** http(s), mailto, or a scheme-less site path; anything else (javascript:, data:) fails the build. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:|[/#.?]|[^:/?#]*(?:[/?#]|$))/i;

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    fail(`unsafe link href "${url}"`);
  }
}

function link(url, label) {
  if (!SAFE_HREF.test(url) || /[\u0000-\u001f\u007f]/.test(url)) fail(`unsafe link href "${url}"`);
  const external = /^https?:\/\//i.test(url) && originOf(url) !== SITE;
  const attrs = external ? ' target="_blank" rel="noreferrer"' : "";
  return `<a href="${url}"${attrs}>${label}</a>`;
}

// ── Block markdown ──────────────────────────────────────────────────────────

const HEADING = /^(#{1,6})\s+(.*?)(?:\s+\{#([a-z0-9-]+)\})?\s*$/;
const FENCE = /^(\s*)(```+)\s*([\w-]*)\s*$/;
const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,})\s*$/;
const EMBED = /^\s*<!--\s*embed:([\w-]+)\s*-->\s*$/;
const COMMENT_START = /^\s*<!--/;

const isTableDelimiter = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function splitRow(line) {
  const cells = [];
  let cur = "";
  let inCode = false;
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parse markdown into a flat block list. `ctx` collects headings and checks ids:
 * `{ ids: Map<id, line>, headings: [], file, lineOffset }`.
 * Blocks: {type:"html", html} | {type:"embed", name, line}.
 */
export function parseBlocks(src, ctx) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let html = [];
  const flush = () => {
    if (html.length) blocks.push({ type: "html", html: html.join("\n") });
    html = [];
  };
  let i = 0;
  const lineNo = (idx) => (ctx.lineOffset ?? 0) + idx + 1;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const embed = EMBED.exec(line);
    if (embed) {
      flush();
      blocks.push({ type: "embed", name: embed[1], line: lineNo(i) });
      i++;
      continue;
    }
    if (COMMENT_START.test(line)) {
      // Source notes for editors; never rendered.
      const start = i;
      while (i < lines.length && !lines[i].includes("-->")) i++;
      if (i >= lines.length) fail(`${ctx.file}:${lineNo(start)}: unclosed HTML comment`);
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      const id = h[3] ?? slugify(text);
      if (!id) fail(`${ctx.file}:${lineNo(i)}: heading "${text}" has no usable id`);
      const prev = ctx.ids.get(id);
      if (prev) fail(`duplicate id "${id}": ${prev} and ${ctx.file}:${lineNo(i)}`);
      ctx.ids.set(id, `${ctx.file}:${lineNo(i)}`);
      ctx.headings.push({ id, text: toPlain(renderInline(text)), level, explicit: Boolean(h[3]) });
      html.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`);
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = fence[1].length;
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)));
        i++;
      }
      if (i >= lines.length) fail(`${ctx.file}:${lineNo(i - body.length - 1)}: unclosed code fence`);
      i++;
      const cls = fence[3] ? ` class="language-${fence[3]}"` : "";
      html.push(`<pre tabindex="0"><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (RULE.test(line)) {
      html.push("<hr />");
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = head.map((c) => `<th>${renderInline(c)}</th>`).join("");
      const tb = rows
        .map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      html.push(
        `<div class="docs-table" tabindex="0" role="region" aria-label="${escapeHtml(toPlain(renderInline(head.join(", "))))}"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const sub = parseBlocks(inner.join("\n"), { ...ctx, lineOffset: lineNo(i - inner.length) - 1 });
      html.push(`<blockquote>${sub.map((b) => b.html ?? "").join("\n")}</blockquote>`);
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const baseIndent = li[1].length;
      const items = [];
      let contentIndent = 0;
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && m[1].length === baseIndent && /\d/.test(m[2]) === ordered) {
          items.push([m[3]]);
          contentIndent = m[1].length + m[2].length + 1;
          i++;
          continue;
        }
        const cur = lines[i];
        const indent = cur.length - cur.trimStart().length;
        if (cur.trim() && indent > baseIndent && items.length) {
          items[items.length - 1].push(cur.slice(Math.min(contentIndent, indent)));
          i++;
          continue;
        }
        if (!cur.trim() && i + 1 < lines.length) {
          const next = lines[i + 1];
          const nextIndent = next.length - next.trimStart().length;
          const nm = LIST_ITEM.exec(next);
          // Indented content after a blank line belongs to the current item.
          if (next.trim() && nextIndent > baseIndent) {
            items[items.length - 1].push("");
            i++;
            continue;
          }
          // A blank line between two sibling items keeps the list going.
          if (nm && nm[1].length === baseIndent && /\d/.test(nm[2]) === ordered) {
            i++;
            continue;
          }
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      const lis = items.map((itemLines) => {
        const text = itemLines.join("\n");
        const simple = !itemLines.some((l) => !l.trim() || FENCE.test(l) || LIST_ITEM.test(l) || /^\s*>/.test(l));
        if (simple) return `<li>${renderInline(itemLines.map((l) => l.trim()).join(" "))}</li>`;
        const sub = parseBlocks(text, { ...ctx, lineOffset: 0 });
        return `<li>${sub.map((b) => b.html ?? "").join("\n")}</li>`;
      });
      html.push(`<${tag}>${lis.join("")}</${tag}>`);
      continue;
    }
    // Paragraph: until a blank line or the start of another block.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !FENCE.test(lines[i]) &&
      !EMBED.test(lines[i]) &&
      !COMMENT_START.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !(para.length && LIST_ITEM.test(lines[i])) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1]))
    ) {
      para.push(lines[i].trim());
      i++;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  flush();
  return blocks;
}

/** Render markdown to one HTML string (no embeds allowed). */
export function renderMarkdown(src, ctx = { ids: new Map(), headings: [], file: "<input>" }) {
  const blocks = parseBlocks(src, ctx);
  const embed = blocks.find((b) => b.type === "embed");
  if (embed) fail(`${ctx.file}:${embed.line}: embed "${embed.name}" is not allowed here`);
  return blocks.map((b) => b.html).join("\n");
}

// ── Sources ─────────────────────────────────────────────────────────────────

/** The install.md host range: after the HOSTS_H2 line, up to the next H2. */
export function extractInstallHosts(installMd) {
  const lines = installMd.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${HOSTS_H2}`);
  if (start === -1) fail(`install.md: the H2 "## ${HOSTS_H2}" is missing`);
  let end = lines.findIndex((l, k) => k > start && /^##\s/.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  while (body.length && (!body[body.length - 1].trim() || RULE.test(body[body.length - 1]))) body.pop();
  return { markdown: body.join("\n").trim(), lineOffset: start + 1 };
}

/** FAQ pairs: each H3 is a question, the blocks until the next heading answer it. */
export function extractFaq(markdown, file = "<faq>") {
  const ctx = { ids: new Map(), headings: [], file };
  const html = parseBlocks(markdown, ctx)
    .map((b) => {
      if (b.type === "embed") fail(`${file}:${b.line}: no embeds in the FAQ`);
      return b.html;
    })
    .join("\n");
  const pairs = [];
  const parts = html.split(/(?=<h[1-6] )/);
  for (const part of parts) {
    const m = /^<h3 id="([^"]+)">([\s\S]*?)<\/h3>\n?([\s\S]*)$/.exec(part);
    if (!m) continue;
    const answerHtml = m[3].trim();
    if (!answerHtml) fail(`${file}: question "${toPlain(m[2])}" has no answer`);
    pairs.push({ id: m[1], question: toPlain(m[2]), answer: toPlain(answerHtml) });
  }
  return pairs;
}

/** First sentence of a tool description. */
export function firstSentence(text) {
  const m = /^(.+?[.!?])(?=\s+[A-Z(]|$)/.exec(text.replace(/\s+/g, " ").trim());
  return m ? m[1] : text;
}

/** Load the tool and energy data from the built @tidegap/core dist. */
export async function loadCoreData() {
  const dist = join(ROOT, "packages/core-ts/dist");
  let surface;
  let energy;
  try {
    surface = await import(pathToFileURL(join(dist, "tool-surface.js")).href);
    energy = await import(pathToFileURL(join(dist, "energy.js")).href);
  } catch (err) {
    fail(`cannot load @tidegap/core dist (run \`pnpm --filter @tidegap/core build\`): ${err.message}`);
  }
  const tools = surface.toolsForHost("mcp").map((t) => ({ name: t.name, summary: firstSentence(t.description) }));
  const energyRows = ENERGY_ROWS.map((row) => {
    const c = energy.MODEL_ENERGY_COEFFICIENTS[row.model];
    if (!c) fail(`energy row "${row.label}": no coefficients for ${row.model}`);
    const wh = Math.round(energy.estimateEnergyKwh({ model: row.model }) * 1000 * 10) / 10;
    return {
      label: row.label,
      whIn: String(c.whPerInputToken),
      whOut: String(c.whPerOutputToken),
      typical: `~${wh.toFixed(1)} Wh`,
      source: c.source,
    };
  });
  return { tools, energyRows };
}

// ── Embeds rendered at generation time ──────────────────────────────────────

/** Escape a table cell: backslashes first, then pipes, so `\\` and `\|` round-trip. */
const mdCell = (s) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function toolsMarkdown(tools) {
  return [
    "| Tool | What it does |",
    "| --- | --- |",
    ...tools.map((t) => `| \`${t.name}\` | ${mdCell(t.summary)} |`),
  ].join("\n");
}

function energyMarkdown(rows) {
  return [
    "| Model class | Wh / input token | Wh / output token | Typical call* | Source |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${mdCell(r.label)} | ${r.whIn} | ${r.whOut} | ${r.typical} | ${mdCell(r.source)} |`),
  ].join("\n");
}

const INSTALL_POINTER = `The full install instructions for every host are at the top of this file, and at <${SITE}/install.md>.`;

// ── Build ───────────────────────────────────────────────────────────────────

/** Read the category files: [{file, src}] sorted by name. */
export function readCategoryFiles(dir = CONTENT_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d\d-[\w-]+\.md$/.test(f))
    .sort()
    .map((file) => ({ file: `content/docs/${file}`, src: readFileSync(join(dir, file), "utf8") }));
}

/**
 * Build both outputs from in-memory sources.
 * @param {{files: {file: string, src: string}[], installMd: string, tools: {name, summary}[], energyRows: object[]}} input
 * @param {{requiredIds?: string[]}} [opts]
 */
export function buildDocs({ files, installMd, tools, energyRows }, opts = {}) {
  const requiredIds = opts.requiredIds ?? REQUIRED_IDS;
  const ids = new Map();
  const explicitIds = new Set();
  const sections = [];
  const llms = [];
  let faq = [];
  const hosts = extractInstallHosts(installMd);

  for (const { file, src } of files) {
    const { data, body, bodyStartLine } = parseFrontmatter(src, file);
    if (ids.has(data.id)) fail(`duplicate id "${data.id}": ${ids.get(data.id)} and ${file}:2`);
    ids.set(data.id, `${file}:2`);
    if (!body.trim()) fail(`${file}: category "${data.label}" is empty`);

    const ctx = { ids, headings: [], file, lineOffset: bodyStartLine };
    const raw = parseBlocks(body, ctx);
    if (!raw.length) fail(`${file}: category "${data.label}" is empty`);
    const blocks = [];
    const pushHtml = (html) => {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "html") last.html += `\n${html}`;
      else blocks.push({ kind: "html", html });
    };
    for (const b of raw) {
      if (b.type === "html") pushHtml(b.html);
      else if (PAGE_EMBEDS.includes(b.name)) blocks.push({ kind: "embed", name: b.name });
      else if (b.name === "install-hosts") {
        const hctx = { ids, headings: ctx.headings, file: "public/install.md", lineOffset: hosts.lineOffset };
        pushHtml(renderMarkdown(hosts.markdown, hctx));
      } else if (b.name === "tools") pushHtml(renderMarkdown(toolsMarkdown(tools), { ...ctx, headings: [] }));
      else if (b.name === "energy") pushHtml(renderMarkdown(energyMarkdown(energyRows), { ...ctx, headings: [] }));
      else fail(`${file}:${b.line}: unknown embed "${b.name}"`);
    }

    for (const h of ctx.headings) if (h.explicit) explicitIds.add(h.id);
    if (data.id === "faq") faq = extractFaq(body, file);

    sections.push({
      id: data.id,
      label: data.label,
      headings: ctx.headings.map(({ id, text, level }) => ({ id, text, level })),
      blocks,
    });
    llms.push(`## ${data.label}\n\n${categoryMarkdown(body, { tools, energyRows })}`);
  }

  for (const id of requiredIds) {
    if (!explicitIds.has(id)) fail(`required id "${id}" is missing: add \`{#${id}}\` to its heading`);
  }

  const module = renderModule({ sections, faq });
  const llmsFull = [
    installMd.replace(/\r\n/g, "\n").trimEnd(),
    "",
    "---",
    "",
    "# Tidegap docs",
    "",
    `The same content as <${SITE}/docs>, as plain markdown.`,
    "",
    llms.join("\n\n"),
    "",
  ].join("\n");
  return { sections, faq, module, llmsFull };
}

/** A category body as plain markdown: no `{#id}` suffixes, comments, or embeds. */
function categoryMarkdown(body, { tools, energyRows }) {
  const out = [];
  let inFence = false;
  let inComment = false;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence || /^\s*```/.test(line)) {
      out.push(line);
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const embed = EMBED.exec(line);
    if (embed) {
      const name = embed[1];
      if (name === "tools") out.push(toolsMarkdown(tools));
      else if (name === "energy") out.push(energyMarkdown(energyRows));
      else out.push(INSTALL_POINTER);
      continue;
    }
    if (COMMENT_START.test(line)) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    out.push(line.replace(/\s+\{#[a-z0-9-]+\}\s*$/, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderModule({ sections, faq }) {
  const json = (v) => JSON.stringify(v, null, 2);
  return `// Generated by scripts/build-docs.mjs from apps/web/content/docs/*.md,
// apps/web/public/install.md and the @tidegap/core dist. Do not edit by hand:
// run \`pnpm gen:docs\`. \`pnpm gen:docs:check\` fails when this file is stale.

export type DocsEmbedName = ${PAGE_EMBEDS.map((n) => JSON.stringify(n)).join(" | ")};

export type DocsBlock = { kind: "html"; html: string } | { kind: "embed"; name: DocsEmbedName };

export interface DocsHeading {
  id: string;
  text: string;
  level: number;
}

export interface DocsSection {
  id: string;
  label: string;
  headings: readonly DocsHeading[];
  blocks: readonly DocsBlock[];
}

export interface DocsFaqPair {
  id: string;
  question: string;
  answer: string;
}

export const DOCS_SECTIONS: readonly DocsSection[] = ${json(sections)};

export const DOCS_FAQ: readonly DocsFaqPair[] = ${json(faq)};
`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const { tools, energyRows } = await loadCoreData();
  const { module, llmsFull, sections } = buildDocs({
    files: readCategoryFiles(),
    installMd: readFileSync(INSTALL_MD, "utf8"),
    tools,
    energyRows,
  });
  writeFileSync(OUT_TS, module);
  writeFileSync(OUT_LLMS, llmsFull);
  console.log(`gen:docs: ${sections.length} categories -> apps/web/src/lib/docs.generated.ts, apps/web/public/llms-full.txt`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof DocsError ? `gen:docs: ${err.message}` : err);
    process.exit(1);
  });
}
