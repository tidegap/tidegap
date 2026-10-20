// Tests for scripts/build-docs.mjs (node --test). Fixtures are small strings, so
// the parsing rules are pinned independently of the real docs content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT,
  buildDocs,
  channelMarkdown,
  extractFaq,
  extractInstallHosts,
  loadCoreData,
  parseBlocks,
  readCategoryFiles,
  renderMarkdown,
} from "./build-docs.mjs";

const ctx = (file = "fixture.md") => ({ ids: new Map(), headings: [], file });

const INSTALL = `# Install

Intro.

## What the install does

Ten tools.

---

## Pick the install path for the host you're in

### Claude Code

\`\`\`text
/plugin install tidegap
\`\`\`

### Cursor

| Host | Path |
| --- | --- |
| Cursor | \`~/.cursor/mcp.json\` |

---

## Libraries

npm install.
`;

const cat = (id, label, body) => ({ file: `content/docs/${id}.md`, src: `---\nid: ${id}\nlabel: ${label}\n---\n\n${body}\n` });

const TOOLS = [
  { name: "schedule_task", summary: "Queue a task." },
  { name: "cancel_task", summary: "Cancel a task." },
];
const ENERGY = [{ label: "m", whIn: "0.001", whOut: "0.005", typical: "~3.5 Wh", source: "estimated" }];

const fixtureFiles = () => [
  cat("install", "Install", "Pick a host.\n\n<!-- embed:install-picker -->"),
  cat("hosts", "Hosts", "Same server everywhere.\n\n<!-- embed:install-hosts -->"),
  cat("cli", "CLI", "### Slash commands {#commands}\n\nEight."),
  cat("tools", "MCP tools", "The surface.\n\n<!-- embed:tools -->"),
  cat("faq", "FAQ", "### Is it safe?\n\n<!-- source: install.md -->\nYes.\n\n### Any account?\n\nNo.\n\n### Does it phone home?\n\nNo, and it says so in `install.md`.\nSecond line."),
];

test("an explicit {#id} wins over the slug, and the text drops it", () => {
  const c = ctx();
  const html = renderMarkdown("## Slash commands {#commands}", c);
  assert.equal(c.headings[0].id, "commands");
  assert.equal(c.headings[0].text, "Slash commands");
  assert.equal(html, '<h2 id="commands">Slash commands</h2>');
});

test("a heading without {#id} gets a slug", () => {
  const c = ctx();
  renderMarkdown("### Run the `tick` daemon", c);
  assert.equal(c.headings[0].id, "run-the-tick-daemon");
});

test("two headings with the same id fail with both line numbers", () => {
  assert.throws(
    () => renderMarkdown("## Paths\n\ntext\n\n## Paths", ctx("a.md")),
    /duplicate id "paths": a\.md:1 and a\.md:5/,
  );
});

test("an embed directive yields an embed block", () => {
  const blocks = parseBlocks("Intro.\n\n<!-- embed:tools -->\n\nAfter.", ctx());
  assert.deepEqual(
    blocks.map((b) => b.type === "embed" ? `embed:${b.name}` : "html"),
    ["html", "embed:tools", "html"],
  );
});

test("an unknown embed fails the build", () => {
  const files = [...fixtureFiles(), cat("x", "X", "<!-- embed:nope -->")];
  assert.throws(
    () => buildDocs({ files, installMd: INSTALL, tools: TOOLS, energyRows: ENERGY }, { requiredIds: [] }),
    /unknown embed "nope"/,
  );
});

test("an empty category fails the build", () => {
  const files = [...fixtureFiles(), { file: "content/docs/09-empty.md", src: "---\nid: empty\nlabel: Empty\n---\n\n" }];
  assert.throws(
    () => buildDocs({ files, installMd: INSTALL, tools: TOOLS, energyRows: ENERGY }, { requiredIds: [] }),
    /category "Empty" is empty/,
  );
});

test("a required id without {#id} fails the build", () => {
  assert.throws(
    () => buildDocs({ files: fixtureFiles(), installMd: INSTALL, tools: TOOLS, energyRows: ENERGY }, { requiredIds: ["commands", "env"] }),
    /required id "env" is missing/,
  );
});

test("the FAQ with 3 questions yields 3 plain-text pairs", () => {
  const faq = extractFaq(fixtureFiles()[4].src.split("---\n").slice(2).join("---\n"));
  assert.equal(faq.length, 3);
  assert.deepEqual(faq.map((p) => p.question), ["Is it safe?", "Any account?", "Does it phone home?"]);
  assert.equal(faq[2].answer, "No, and it says so in install.md. Second line.");
  for (const p of faq) assert.doesNotMatch(p.answer, /<|>|source:/);
});

test("the install.md host range runs from the H2 to the next H2", () => {
  const { markdown } = extractInstallHosts(INSTALL);
  assert.match(markdown, /^### Claude Code/);
  assert.match(markdown, /### Cursor/);
  assert.doesNotMatch(markdown, /Libraries|What the install does/);
  assert.doesNotMatch(markdown, /---\s*$/);
});

test("the install.md host range fails when the H2 is missing", () => {
  assert.throws(() => extractInstallHosts("# Install\n\n## Other\n"), /is missing/);
});

test("llms-full.txt holds the install.md host sections once", () => {
  const { llmsFull } = buildDocs(
    { files: fixtureFiles(), installMd: INSTALL, tools: TOOLS, energyRows: ENERGY },
    { requiredIds: ["commands"] },
  );
  assert.equal(llmsFull.split("### Claude Code").length - 1, 1);
  assert.ok(llmsFull.startsWith("# Install"));
  assert.doesNotMatch(llmsFull, /\{#commands\}|<!--/);
});

test("the tools embed lists exactly toolsForHost(\"mcp\")", async () => {
  const { tools, energyRows } = await loadCoreData();
  const surface = await import(join(ROOT, "packages/core-ts/dist/tool-surface.js"));
  const expected = surface.toolsForHost("mcp").map((t) => t.name);
  const { sections, llmsFull } = buildDocs(
    { files: fixtureFiles(), installMd: INSTALL, tools, energyRows },
    { requiredIds: [] },
  );
  const html = sections.find((s) => s.id === "tools").blocks.map((b) => b.html ?? "").join("");
  const inHtml = [...html.matchAll(/<td><code>([a-z_]+)<\/code><\/td>/g)].map((m) => m[1]);
  assert.deepEqual(inHtml, expected);
  const inMd = [...llmsFull.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(inMd, expected);
});

test("the regions embed lists every catalog zone with its no-key data source", async () => {
  const core = await loadCoreData();
  const region = await import(join(ROOT, "packages/core-ts/dist/region.js"));
  const expected = Object.keys(region.REGION_CATALOG);
  const files = [{ file: "content/docs/01-config.md", src: "---\nid: config\nlabel: Config\n---\n\nZones.\n\n<!-- embed:regions -->\n" }];
  const { sections, llmsFull } = buildDocs({ files, installMd: INSTALL, ...core }, { requiredIds: [] });
  const html = sections[0].blocks.map((b) => b.html ?? "").join("");
  const inHtml = [...html.matchAll(/<tr><td><code>([A-Z0-9-]+)<\/code><\/td>/g)].map((m) => m[1]);
  assert.deepEqual(inHtml, expected);
  const rows = llmsFull.split("\n").filter((l) => /^\| `[A-Z]/.test(l));
  assert.equal(rows.length, expected.length);
  assert.match(rows.find((l) => l.startsWith("| `GB`")), /NESO Carbon Intensity API \| none \| `Europe\/London` \|$/);
  assert.match(rows.find((l) => l.startsWith("| `PL`")), /approximate, no UA data: `Europe\/Kyiv`/);
});

test("two runs give byte-identical output", async () => {
  const core = await loadCoreData();
  const input = () => ({
    files: readCategoryFiles(),
    installMd: readFileSync(join(ROOT, "apps/web/public/install.md"), "utf8"),
    ...core,
  });
  const a = buildDocs(input());
  const b = buildDocs(input());
  assert.equal(a.module, b.module);
  assert.equal(a.llmsFull, b.llmsFull);
});

test("tables, lists, quotes and code render to the expected tags", () => {
  const html = renderMarkdown(
    "> **Note.** Read it.\n>\n> - one\n> - two\n\n| A | B |\n| --- | --- |\n| `a\\|b` | [x](https://example.com) |\n\n1. first\n2. second\n\n```json\n{\"a\": 1}\n```",
    ctx(),
  );
  assert.match(html, /<blockquote><p><strong>Note\.<\/strong> Read it\.<\/p>\n<ul><li>one<\/li><li>two<\/li><\/ul><\/blockquote>/);
  assert.match(html, /<div class="docs-table" tabindex="0"[^>]*><table>/);
  assert.match(html, /<td><code>a\|b<\/code><\/td>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer">x<\/a>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<pre tabindex="0"><code class="language-json">\{&quot;a&quot;: 1\}<\/code><\/pre>/);
});

test("snake_case words outside code are not italicised", () => {
  assert.equal(renderMarkdown("call schedule_task now", ctx()), "<p>call schedule_task now</p>");
});

test("raw HTML in markdown is escaped, not rendered", () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror="a()">', ctx());
  assert.equal(html, "<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=&quot;a()&quot;&gt;</p>");
});

test("a javascript: or data: link fails the build", () => {
  for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "vbscript:x"]) {
    assert.throws(() => renderMarkdown(`[x](${href})`, ctx()), /unsafe link href/);
  }
});

test("site paths, anchors and mailto links render", () => {
  const html = renderMarkdown("[a](/docs#apps) [b](#env) [c](mailto:x@y.z) [d](install.md)", ctx());
  assert.equal(html, '<p><a href="/docs#apps">a</a> <a href="#env">b</a> <a href="mailto:x@y.z">c</a> <a href="install.md">d</a></p>');
});

test("emphasis markers inside an href are left alone", () => {
  const html = renderMarkdown("see [the _x_ doc](https://example.com/a/_b_/c) and _this_", ctx());
  assert.equal(
    html,
    '<p>see <a href="https://example.com/a/_b_/c" target="_blank" rel="noreferrer">the <em>x</em> doc</a> and <em>this</em></p>',
  );
});

test("a required id that exists only as a slug fails the build", () => {
  const files = [...fixtureFiles(), cat("config", "Config", "### Env\n\nVariables.")];
  assert.throws(
    () => buildDocs({ files, installMd: INSTALL, tools: TOOLS, energyRows: ENERGY }, { requiredIds: ["commands", "env"] }),
    /required id "env" is missing/,
  );
});

test("an unclosed HTML comment fails the build", () => {
  assert.throws(() => renderMarkdown("Intro.\n\n<!-- note\nstill a note", ctx()), /fixture\.md:3: unclosed HTML comment/);
});

test("a nested or split <script cannot survive into heading text", () => {
  const c = ctx();
  parseBlocks("## <scr<script>ipt>alert(1)</script> `<script>` **x**", c);
  const [{ text }] = c.headings;
  assert.equal(text, "<scr<script>ipt>alert(1)</script> <script> x");
  // Plain text only: it is escaped again wherever it reaches HTML.
  const html = renderMarkdown("| <scr<script>ipt> |\n| --- |\n| a |", ctx());
  assert.ok(!/<script|<scr</.test(html), html);
});

test("a look-alike host of the site is treated as external", () => {
  const html = renderMarkdown(
    "[a](https://www.tidegap.com.evil.com/x) [b](https://www.tidegap.com@evil.com/) [c](https://www.tidegap.com/docs)",
    ctx(),
  );
  assert.equal(
    html,
    '<p><a href="https://www.tidegap.com.evil.com/x" target="_blank" rel="noreferrer">a</a> ' +
      '<a href="https://www.tidegap.com@evil.com/" target="_blank" rel="noreferrer">b</a> ' +
      '<a href="https://www.tidegap.com/docs">c</a></p>',
  );
});

test("a backslash or pipe in a tool summary round-trips through the table", () => {
  const tools = [{ name: "schedule_task", summary: String.raw`Path C:\tmp\ and a \| or | pipe.` }];
  const { sections } = buildDocs(
    { files: fixtureFiles(), installMd: INSTALL, tools, energyRows: ENERGY },
    { requiredIds: [] },
  );
  const html = sections.find((s) => s.id === "tools").blocks.map((b) => b.html ?? "").join("");
  assert.match(html, /<td>Path C:\\tmp\\ and a \\\| or \| pipe\.<\/td>/);
});

test("a channel-<kind> embed renders the card's steps, fields, presets, events and errors from the descriptors", async () => {
  const { channelKinds } = await loadCoreData();
  const files = [...fixtureFiles(), cat("notifications", "Notifications", "### Email {#notify-email}\n\n<!-- embed:channel-email -->")];
  const { llmsFull, sections } = buildDocs({ files, installMd: INSTALL, tools: TOOLS, energyRows: ENERGY, channelKinds }, { requiredIds: [] });
  const email = channelKinds.email;
  assert.ok(email.steps.length > 0 && email.fields.length > 0 && email.presets.length > 0 && email.errors.length > 0);
  for (const st of email.steps) assert.ok(llmsFull.includes(st.text), st.text);
  assert.match(llmsFull, /\| Email address \| `user` \| yes \| no \| - \|/);
  assert.match(llmsFull, /\| Gmail \| `gmail` \| smtp\.gmail\.com, 465, tls \|/);
  assert.match(llmsFull, /\| `auth_required` \| The mail server needs a login\./);
  assert.ok(llmsFull.includes(`Events on by default: ${email.defaultEvents.map((e) => `\`${e}\``).join(", ")}.`));
  const html = sections.find((x) => x.id === "notifications").blocks.map((b) => b.html).join("");
  assert.match(html, /<table>/);
});

test("a channel embed for a kind that is not ready or unknown fails the build", () => {
  assert.throws(() => channelMarkdown("pager", undefined), /no ready channel kind "pager"/);
});
