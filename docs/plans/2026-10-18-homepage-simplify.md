---
title: Homepage simplify — one install box, five sections
date: 2026-10-18
owner_brief: Vitalii, 2026-10-18 ("разгрузить главную максимально")
base: main 8fde030
scope: apps/web homepage only; /about, /docs, install.md content unchanged except where named
---

# Homepage simplify

Goal: a homepage a non-technical reader scans in one pass. Everything a crawler or an
agent reads today stays in the HTML. Eight sections become five. The install paths move
from a section in the middle of the page into tabs inside the top prompt box.

No visual restyle: existing tokens, `Section`, `Card`, `Chip`, `Stat`, `reveal`, `lift`.

## 1. Audit of the current page

Word counts are visible-text estimates (headings + body, not code). Source:
`apps/web/src/app/page.tsx` and `apps/web/src/components/home/*`.

| # | id | Heading | What it does | Words | Verdict | Reason |
|---|---|---|---|---|---|---|
| 1 | hero (`FirstScreen`) | H1 "Run your agent's non-urgent LLM tasks at the cleanest grid hour." | 3 chips, H1, `HeroPrompt` (pre + Copy prompt), trust line, "Other ways to install ↓" | 70 | **keep**; the prompt box becomes the tabbed `InstallBox`; drop the "Other ways" link | Tabs replace the jump link |
| 2 | `#how` (`HowSteps`) | "Tasks that can wait, wait for clean power." | lead + 3 step cards (card 2 holds `MiniCurve`) + `HowItWorksViz` | 75 + 140 (viz) | **merge**: steps become one compact row above the chart; `MiniCurve` cut; viz paragraph and footnote shortened | Two visuals say the same thing; the chart is the one the owner keeps |
| 3 | `#why` (`WhyItMatters`) | "The same electricity is cleaner at some hours." | live visitor curve, real receipt, 4 stats (DOE %, 31 regions, 5 feeds, 72 h), claims caption | 130 | **shorten**: keep curve + receipt; cut the stat row (regions/feeds move to Proof, DOE and 72 h leave the home); add two links (map, plan) | Stats repeat /about and Proof; the curve is the eco-audience hook |
| 4 | `#hosts` (`HostsSection` + `Apps`) | "Works with the agent you already use." | 10 host chips + "Any MCP host →", 2 app cards (Mac, extension) | 90 | **cut** section; host names move into the install tabs; app status lines move into the See-it captions | A chip list with no action; the tabs name the same hosts |
| 5 | `#install` (`InstallBlock`) | "One line. Any host." | second copy of the prompt, "or", host `<select>` + command, "then" line, `/tidegap:defer` hint | 180 | **cut** section; content moves into the hero `InstallBox` tabs; the `/tidegap:defer` hint becomes the box footer | Owner: install variants live inside the top box |
| 6 | `#see` (`Screens`) | "See what is waiting, and when it will run." | 3 frames: `tidegap ui`, Mac menu bar illustration, extension popup | 50 | **keep**; captions absorb the app status (Preview chip + "build from source" / "load unpacked" + `/docs#apps` link) | R12/R13 kept with no extra section |
| 7 | `#explore` (`Explore`) | "Explore the live grid." | 4 tiles: map, plan, stats, docs | 70 | **cut**; map and plan become two links under the live curve; docs link is in the box footer; /stats leaves the home (it is for installed users; nav and footer carry the rest) | Nav + footer already link all four |
| 8 | `#proof` (`Proof`) | "Open source, tested, documented." | 4 stats (tests, MCP tools, hosts, Apache-2.0) + 5 listing links | 40 | **keep, re-stat**: tests, grid regions, live feeds, agent hosts; add the one claims caption for the whole page | Apache is in the hero chips; the tool count is inconsistent across files (see Risks) |

Before: 8 sections, ~845 words. After: 5 sections, ~380 words. Client JavaScript on the
home drops from three components (`HeroPrompt`, `AgentPrompt`, `InstallPicker`) to one
(`InstallBox`).

## 2. Target page outline

| # | id | H2 (H1 for 1) | Intent | Max copy | Component |
|---|---|---|---|---|---|
| 1 | `#top`, box `#install` | H1 as today | Say what it does, give the prompt, offer every install path in one box | H1 + 2-sentence trust line | `FirstScreen` (page.tsx) + new `InstallBox` |
| 2 | `#how` | Tasks that can wait, wait for clean power. | Three steps in one row, then the animated chart as the body | lead 1 sentence; 3 steps × 1 sentence; chart note 1 sentence | `HowSteps` (rewritten) + `HowItWorksViz` (prop) |
| 3 | `#grid` | Your grid, right now. | Show the visitor's own live curve and one real receipt; link to map and plan | lead 1 sentence; receipt caption 1 sentence; 2 links | `WhyItMatters` (trimmed) + `IntensityCurve` + `ReceiptCard` |
| 4 | `#see` | See what is waiting, and when it will run. | Real product views with honest status | lead 1 sentence; 3 captions × 1 line | `Screens` (captions extended); `Apps` deleted |
| 5 | `#proof` | Open source, tested, documented. | Four measured numbers, public listings, one claims caption | 4 stats; 5 links; 1 caption | `Proof` (stats swapped) |

Order rule: action (1) → mechanism (2) → evidence for the eco reader (3) → evidence the
product is real (4) → evidence for the developer (5).

## 3. Install box spec (`apps/web/src/components/install-box.tsx`)

**Prompt** (single source: new `apps/web/src/lib/install-prompt.ts`, plain module, no
`"use client"`):

```
Read https://www.tidegap.com/install.md, then install Tidegap for the host you're in and confirm it worked.
```

Same text as today's `PROMPT` in `agent-prompt.tsx`. That file is deleted; the constant moves.

**Layout** (desktop, max-w-2xl, centred under the H1):

```
┌ role=tablist ───────────────────────────────────────────────────────┐
│ [Prompt] [Claude Code] [Codex] [OpenClaw] [MCP hosts] [Libraries]   │
├─────────────────────────────────────────────────────────────────────┤
│ <pre id="install-prompt"> Read https://www.tidegap.com/install.md…  │
│                                                                     │
│                      [ Copy prompt ]   (accent CTA, Prompt tab only)│
│ role=status: "Copied. Paste it into your agent."                    │
├─────────────────────────────────────────────────────────────────────┤
│ Then: tasks run through `tidegap install --laptop` … All commands → │
└─────────────────────────────────────────────────────────────────────┘
```

Command tabs use the existing code-block pattern: header row (language label left, small
"Copy" right), `<pre><code>` below, one "Then …" line. The Prompt tab keeps the large accent
"Copy prompt" button under the text because it is the primary CTA for the non-technical
reader; developers on the command tabs get the inline copy they expect.

**Tabs**: derived from `HOSTS` in `apps/web/src/lib/hosts.ts`, grouped by `installHeading`
(the same H3s as `install.md`). Fixed order and labels:

| Tab id | Label | `installHeading` | Panel content |
|---|---|---|---|
| `prompt` | Prompt (default) | — | the prompt, Copy prompt, status |
| `claude-code` | Claude Code | Claude Code | the two `/plugin …` lines; then: "Restart the session." |
| `codex` | Codex | OpenAI Codex CLI | `codex mcp add tidegap -- npx -y @tidegap/mcp`; then: "Start a new Codex session. The config.toml form is in install.md." (hosts.ts: swap `command` and the one-liner in `followup`) |
| `openclaw` | OpenClaw | OpenClaw | `openclaw plugins install clawhub:@vitalini/tidegap`; then: "Restart the OpenClaw gateway." |
| `mcp` | MCP hosts | Other MCP hosts | native `<select aria-label="Host">` over Claude Desktop (default), Cursor, Windsurf, Continue, Cline, Zed, Goose, mcphost / mcp-cli, Any MCP host (`id: mcp`); every host's `desc` + `<pre>` + `followup` is rendered, inactive ones `hidden`; `<option data-host={id}>` keeps the R11 host ids in the DOM |
| `lib` | Libraries | Libraries | both blocks visible, no select: `npm install @tidegap/core`, `pip install tidegap` |

Shared footer (all tabs, one `<p>`): "Queued tasks run through a small local daemon:
`npm install -g @tidegap/cli && tidegap install --laptop`. The prompt path sets it up for
you. All commands →" (`/docs`). This replaces today's `/tidegap:defer` hint and closes the
"installed the plugin, nothing runs" gap install.md warns about.

**Keyboard / a11y** (WAI-ARIA tabs, automatic activation):
- `<div role="tablist" aria-label="Install method">`; each tab is a `<button role="tab" id="tab-{id}" aria-selected aria-controls="panel-{id}" tabIndex={active ? 0 : -1}>`.
- Arrow Left/Right move focus and select (wrap); Home/End jump. Enter/Space not needed.
- Each panel: `<section role="tabpanel" id="panel-{id}" aria-labelledby="tab-{id}" tabIndex={0} hidden={!active}>`.
- The box has `<h2 class="sr-only">Install Tidegap</h2>` so the heading outline reads H1 → H2 Install → H2 How it works …
- Copy result in one shared `<p role="status" aria-live="polite">`; failure text: "Copy blocked. Select the text and copy it."
- Prompt `<pre>` stays `select-text whitespace-pre-wrap`; command `<pre>` is `overflow-x-auto`.
- Focus ring from the existing tokens; tap targets ≥ 44 px (`min-h-11`).

**Mobile** (390 px): the tablist is one row, `overflow-x-auto`, `scroll-snap-type: x
proximity`, no wrap, 16 px gutter, fade on the right edge is optional and CSS-only. The
`<select>` in the MCP tab is native. The first screen keeps `min-h-[calc(100svh-…)]`; if the
box pushes the trust line below the fold at 390×844 that is accepted (content first).

**Crawlers and agents**: `InstallBox` is a `"use client"` component but Next renders it on
the server, so the initial HTML contains all six panels; inactive ones carry the `hidden`
attribute, never `display:none` via a class on a lazy boundary and never `dynamic()`. The
default panel (the prompt) is visible without JavaScript. The unit test (section 8) proves
every `HOSTS[].command` and the prompt string are in `renderToStaticMarkup(<InstallBox/>)`.

**Sync** (who owns what):
- `apps/web/src/lib/hosts.ts` — commands, labels, `installHeading`; `HOST_COUNT`.
- `apps/web/public/install.md` — the agent document; unchanged in this work.
- `apps/web/src/lib/install-prompt.ts` — the prompt string (new).
- `scripts/check-agent-files.mjs` — already proves every `installHeading` has an install.md heading (`install` group). Extend the `head` group: `/` HTML contains the prompt string, six `role="tabpanel"`, and the first line of every `HOSTS[].command`; `/llms.txt` contains the prompt string (`llms` group).
- `scripts/build-docs.mjs` — builds `/docs` and `llms-full.txt` from install.md; untouched.
- `apps/web/public/llms.txt` — add the prompt under "## For agents"; reword the home bullet.

## 4. How it works + chart merge

Keep `Section id="how"`, eyebrow "How it works", title as today, lead cut to one sentence.
Body, top to bottom:

1. **Steps row**: `<ol>` of three items, lg: three columns with the M6 connector, below
   lg: stacked with the vertical connector. No `Card`, no `MiniCurve`. Each item: the
   numbered badge, an `<h3>` (Ask / Wait / Run), one sentence. The M5 `reveal` stagger
   stays.
2. **Chart**: `HowItWorksViz` directly under the row (`mt-8`). It is the section's visual;
   the steps are its legend: 1 = the task arrives at the peak, 2 = it rides down the curve,
   3 = dispatch and the four wins.

`HowItWorksViz` changes (also used on `/about`):
- new prop `summary?: ReactNode` for the paragraph under the h3; default = today's text so
  `/about` does not change; the home passes `summary={null}`.
- the h3 "One scheduled task, four parallel wins." and the eyebrow stay (the owner's line).
- the footnote shrinks on both pages to: "Illustrative loop, not live data. Cost and
  grid-load figures are projected or simulated; sources in docs/claims.md."

Text that leaves the home: the 60-word viz paragraph (stays on `/about` via the default
prop); the lead's second clause and "More about the project" link move to the footer line
of the section as one link: "More about the project →" (`/about`). Nothing new goes to
`/docs`.

## 5. Copy drafts (paste-ready)

**1. Hero**
- Chips: unchanged (Open source · Apache-2.0 · vX.Y.Z).
- H1: unchanged. "Run your agent's non-urgent LLM tasks at the cleanest grid hour."
- Trust line (`#hero-helper`): "Paste it into Claude Code, Codex, Cursor or any MCP host.
  The agent reads the public install.md and installs the Apache-2.0 package (source on
  GitHub)."
- Tab labels: Prompt · Claude Code · Codex · OpenClaw · MCP hosts · Libraries
- Copy button: "Copy prompt" (Prompt tab), "Copy" (others). Status: "Copied. Paste it into
  your agent." / "Copy blocked. Select the text and copy it."
- "Then" lines: Claude Code "Restart the session." Codex "Start a new Codex session. The
  config.toml form is in install.md." OpenClaw "Restart the OpenClaw gateway." MCP hosts:
  the per-host `followup` from hosts.ts, trimmed to one sentence each. Libraries: "Same
  scheduler API in TypeScript and Python. Docs →"
- Footer: "Queued tasks run through a small local daemon: `npm install -g @tidegap/cli &&
  tidegap install --laptop`. The prompt path sets it up for you. All commands →"

**2. How it works**
- Eyebrow: How it works
- H2: Tasks that can wait, wait for clean power.
- Lead: "Tidegap holds an AI task that can wait and runs it at the cleanest grid hour
  before your deadline."
- Step 1 Ask: "Tell your agent: “summarize this by tomorrow 6 pm”."
- Step 2 Wait: "Tidegap reads the grid forecast and picks the cleanest hour before the
  deadline."
- Step 3 Run: "The task runs at that hour, through the cheaper Batch API when the deadline
  allows, and gets a signed receipt."
- Chart eyebrow + h3: unchanged ("one shift, four wins" / "One scheduled task, four
  parallel wins.").
- Chart note: "Illustrative loop, not live data. Cost and grid-load figures are projected
  or simulated; sources in docs/claims.md."
- Section footer link: "More about the project →"

**3. Your grid, right now**
- Eyebrow: Why it matters
- H2: Your grid, right now.
- Lead: "Carbon per kilowatt-hour rises and falls through the day. This curve is live for
  your region."
- Receipt caption: "A real receipt from one run on the GB grid, 2026-09-30."
- Links: "All 31 regions on the live map →" (`/map`) · "Plan a task →" (`/plan`)

**4. See it**
- Eyebrow: See it
- H2: See what is waiting, and when it will run.
- Lead: "Every queued task, its deadline and its clean hour, on your own computer."
- Caption 1: "The queue in your browser (`tidegap ui`)."
- Caption 2: "Tidegap for Mac. Illustration of the real layout. [Preview] Build from source
  (macOS 14+) →" (`/docs#apps`)
- Caption 3: "The browser extension. Chrome, Edge, Firefox; Safari through the Mac app.
  [Preview] Load unpacked from a repo build →" (`/docs#apps`)

**5. Open source**
- Eyebrow: Proof
- H2: Open source, tested, documented.
- Stats: "1,423 — tests across 5 packages — measured 2026-10-16" · "31 — grid regions
  covered — measured" · "5 — live carbon feeds — measured" · "{HOST_COUNT} — agent hosts
  with an install path — measured"
- Listings: GitHub ↗ · npm ↗ · PyPI ↗ · MCP Registry ↗ · ClawHub ↗
- Caption: "Every number on this page has a source in docs/claims.md."

## 6. Agent-readability checklist (implementer must satisfy)

- [ ] One `<h1>`; H2s in order: Install Tidegap (sr-only) · Tasks that can wait… · Your
      grid, right now. · See what is waiting… · Open source, tested, documented. H3s only
      inside sections (steps, chart title, frames).
- [ ] The prompt string is plain text in `<pre id="install-prompt">` in the initial HTML
      (`curl -s / | grep -F "Read https://www.tidegap.com/install.md"`).
- [ ] All six `role="tabpanel"` are in the initial HTML; five carry `hidden`; no
      `next/dynamic`, no `Suspense` around the box.
- [ ] Every `HOSTS[].command` is in the `/` HTML (unit test + check script).
- [ ] `data-host="{id}"` present for every non-lib host (R11 moved from chips to the
      select options).
- [ ] JSON-LD in `layout.tsx` unchanged (`installUrl` → `/install.md` still passes).
- [ ] `<link rel="alternate" type="text/markdown" href="/install.md">` and the `Link`
      header unchanged.
- [ ] `install.md` content unchanged; `llms.txt` has the prompt and the new home bullet;
      `llms-full.txt` regenerated only if `gen:docs:check` asks.
- [ ] `node scripts/check-agent-files.mjs --base http://localhost:3100` prints PASS with the
      extended checks.
- [ ] Lighthouse SEO on `/` ≥ today's score (meta, canonical, h1, link text unchanged).
- [ ] CLS < 0.01 at 1440×900 and 390×844 (R40 observer); tab switching causes no shift
      above the box (panels have a fixed min-height equal to the tallest panel at that
      width, or the box sits at the bottom of the first screen so shifts push only
      downward).
- [ ] `prefers-reduced-motion`: the row reveal and the chart stills still apply.

## 7. Risks and open questions (defaults chosen)

1. **Tool count mismatch.** install.md says "ten new tools", Proof shows 10, llms.txt lists
   12, hosts.ts says OpenClaw registers eleven. Default: remove the tool-count stat from
   the home (done by the Proof re-stat) and file the install.md/llms.txt mismatch as a
   separate one-line ticket; do not fix it in this PR.
2. **Hidden tab content and search weight.** Default: accept. The prompt (default tab) is
   visible; install.md is the canonical agent document and is linked three ways
   (alternate link, Link header, JSON-LD). Mobile-first indexing gives `hidden` tab
   content full weight.
3. **First screen height on phones** with six tabs. Default: tablist scrolls
   horizontally; the trust line may fall below the fold at 390×844; accepted.
4. **`HowItWorksViz` is shared with `/about`.** Default: prop with today's text as the
   default; `/about` renders byte-identical except the shortened footnote.
5. **No test runner in `apps/web`.** Default: add vitest (root already has `vitest`
   4.x) with `environment: node` and a `@/` alias; the one test renders `InstallBox` with
   `react-dom/server`. CI: add `pnpm --filter @tidegap/web test` next to the
   `gen:docs:check` step in `.github/workflows/ci.yml`.

## 8. Implementation streams (sequential, one `ce-work` agent)

**S1 — Install box (foundation)**
- Add `apps/web/src/lib/install-prompt.ts` exporting `INSTALL_PROMPT`.
- Add `apps/web/src/components/install-box.tsx` (`"use client"`): `TABS` constant mapping
  tab id → `installHeading`; panels rendered from `HOSTS`; copy hook moved from
  `agent-prompt.tsx`; WAI-ARIA tabs per section 3.
- Edit `apps/web/src/lib/hosts.ts`: codex `command` = one-liner, `followup` names the
  toml form; trim each `followup` to one sentence.
- Edit `apps/web/src/app/page.tsx`: `FirstScreen` renders `InstallBox` in place of
  `HeroPrompt`; delete `InstallBlock`, `Explore`, `TILES`, the "Other ways to install"
  link, and the unused imports.
- Delete `apps/web/src/components/agent-prompt.tsx`, `apps/web/src/components/install-picker.tsx`.
- Add `apps/web/vitest.config.ts`, `apps/web/src/components/install-box.test.tsx`,
  `"test": "vitest run"` in `apps/web/package.json`, CI step.
- Test asserts: prompt string present; every `HOSTS[].command` present; six
  `role="tabpanel"`, exactly one without `hidden`; every `aria-controls` resolves to a
  panel id; every distinct `HOSTS[].installHeading` has a tab (guards new hosts).

**S2 — How it works merge**
- Rewrite `apps/web/src/components/home/how-steps.tsx`: row layout, `MiniCurve` removed,
  lead shortened, footer link to `/about`, `HowItWorksViz summary={null}`.
- Edit `apps/web/src/components/how-it-works-viz.tsx`: `summary` prop with today's text
  as default; footnote shortened.

**S3 — Trim the rest**
- Edit `apps/web/src/components/home/why-it-matters.tsx`: id `grid`, new title/lead, stat
  row and claims caption removed, two links added under the curve.
- Edit `apps/web/src/components/home/screens.tsx`: captions carry the Preview `Chip`,
  the status line and the `/docs#apps` link (text from `apps.tsx`).
- Delete `apps/web/src/components/home/hosts.tsx`, `apps/web/src/components/home/apps.tsx`.
- Edit `apps/web/src/components/home/proof.tsx`: stats = tests, 31 regions, 5 feeds,
  `HOST_COUNT`; add the claims caption; keep the `docs/claims.md` row comments.
- `grep -rn "InstallPicker\|AgentPrompt\|HeroPrompt\|HostsSection\|from \"./apps\"" apps/web/src` must be empty.

**S4 — Agent files and checks**
- Edit `apps/web/public/llms.txt`: under "## For agents" add "Copy-paste prompt for any
  agent: `Read https://www.tidegap.com/install.md, then install Tidegap for the host you're
  in and confirm it worked.`"; home bullet → "[Home: the install prompt, every install
  path, how it works](https://www.tidegap.com/)".
- Edit `scripts/check-agent-files.mjs`: `head` group adds prompt-in-HTML, six tabpanels,
  every command's first line; `llms` group adds prompt-in-llms.txt. Read the prompt from
  `apps/web/src/lib/install-prompt.ts` with the same regex style as `readHosts`.
- Run `pnpm gen:docs:check`; commit `llms-full.txt` only if it changed.

**Acceptance (run in this order; all from the repo root)**
```
pnpm --filter @tidegap/web typecheck && pnpm --filter @tidegap/web lint
pnpm --filter @tidegap/web test
pnpm --filter @tidegap/web build && (cd apps/web && PORT=3100 pnpm start &) && sleep 4
node scripts/check-agent-files.mjs --base http://localhost:3100
curl -s http://localhost:3100/ | grep -c 'role="tabpanel"'            # 6
curl -s http://localhost:3100/ | grep -c '<h1'                         # 1
curl -s http://localhost:3100/ | grep -o '<h2[^>]*>[^<]*' | wc -l     # 5 (incl. sr-only Install)
curl -s http://localhost:3100/ | grep -F -c 'Read https://www.tidegap.com/install.md'   # ≥ 1
curl -s http://localhost:3100/about | grep -F -c 'A task arrives while the grid is at peak'   # 1 (about unchanged)
pnpm gen:docs:check
```
Browser QA (Haiku, after the gate): 1440×900 and 390×844 screenshots of `/`; tab through
the tablist with keyboard; switch each tab and copy; CLS observer < 0.01; reduced-motion
pass. Evidence to the session scratchpad.

**Out of scope**: `/about`, `/docs` content, install.md wording, the tool-count mismatch,
any token or style change, a `?tab=` deep link.
