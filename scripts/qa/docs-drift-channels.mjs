// The channels drift rule of docs-drift.mjs, as a pure function: K13 (notifications docs vs
// the channels code: kind sections vs the registry, quoted error codes vs the code, `tidegap
// channels` subcommands and --help blocks vs the CLI). It takes the page texts, the core
// values, the subcommand list and a --help reader and returns the list of problems;
// docs-drift.mjs reads the files, lists the subcommands and runs the CLI.
// Tests: docs-drift-channels.test.mjs (node --test).

/**
 * K13: one {#notify-<kind>} section per ready descriptor, in card order, each with its
 * generated embed; every quoted error code exists in the code; every `tidegap channels <sub>`
 * on the page exists and every subcommand is on this page or the Telegram page; every quoted
 * `tidegap channels … --help` block equals the CLI's output. `core` needs KIND_DESCRIPTORS,
 * DELIVERY_CODES, EVENT_KINDS and CHANNEL_KINDS. `subs` are the `tidegap channels` subcommand
 * names; `help(cmd)` runs `tidegap <cmd> --help` and returns `{ code, stdout }`.
 */
export function channelsDocsProblems({ page, pageName, telegram, core, subs, help }) {
  const bad = [];
  // Kinds: one {#notify-<kind>} section per ready descriptor, in card order, each with its generated embed.
  const kinds = Object.values(core.KIND_DESCRIPTORS).filter((d) => d.ready);
  if (kinds.length === 0) bad.push("KIND_DESCRIPTORS has no ready kind");
  const sections = [...page.matchAll(/^### .+ \{#notify-([a-z]+)\}$/gm)].map((m) => m[1]);
  const kindSections = sections.filter((k) => Object.hasOwn(core.KIND_DESCRIPTORS, k));
  if (kindSections.length === 0) bad.push(`${pageName} has no {#notify-<kind>} section`);
  const want = kinds.map((d) => d.kind);
  if (kindSections.join(",") !== want.join(",")) bad.push(`kind sections ${kindSections.join(",")} vs registry ${want.join(",")}`);
  for (const d of kinds) {
    if (d.docsAnchor !== `notify-${d.kind}`) bad.push(`${d.kind}: docsAnchor ${d.docsAnchor}`);
    const body = page.split(`{#notify-${d.kind}}`)[1]?.split(/^### /m)[0] ?? "";
    if (!new RegExp(`<!--\\s*embed:channel-${d.kind}\\s*-->`).test(body)) bad.push(`${d.kind}: section lacks <!-- embed:channel-${d.kind} -->`);
  }
  // Error codes quoted in the hand-written text exist in the code: the host's DELIVERY_CODES plus each kind's own.
  const hostCodes = core.DELIVERY_CODES ?? [];
  if (hostCodes.length === 0) bad.push("core DELIVERY_CODES is empty");
  const known = new Set([...hostCodes, ...kinds.flatMap((d) => Object.keys(d.errors ?? {}))]);
  const notCodes = new Set([...core.EVENT_KINDS, ...kinds.flatMap((d) => d.fields.map((f) => f.name)), "redact_in_receipt"]);
  const quoted = [...new Set([...page.matchAll(/`([a-z]+_[a-z0-9_]+)`/g)].map((m) => m[1]))].filter((c) => !notCodes.has(c) && !/^task_/.test(c));
  if (quoted.length === 0) bad.push(`${pageName} quotes no error code`);
  // A code in the "(`code`)" form is checked too, so a one-word code such as `timeout` is covered; kinds are not codes.
  const kindNames = new Set(core.CHANNEL_KINDS);
  if (kindNames.size === 0) bad.push("CHANNEL_KINDS is empty");
  const inParens = [...page.matchAll(/\(`([a-z]+(?:_[a-z0-9]+)*)`\)/g)].map((m) => m[1]).filter((c) => !notCodes.has(c) && !kindNames.has(c));
  for (const c of new Set([...quoted, ...inParens])) if (!known.has(c)) bad.push(`quoted code \`${c}\` is not in the code`);
  // CLI: every `tidegap channels <sub>` the page names exists; every subcommand is on this page or the Telegram page.
  if (subs.length < 5) bad.push(`only ${subs.length} channels subcommands found`);
  const named = new Set([...page.matchAll(/tidegap channels ([a-z]+)/g)].map((m) => m[1]));
  for (const n of named) if (!subs.includes(n)) bad.push(`page names unknown \`tidegap channels ${n}\``);
  for (const sub of subs) if (!named.has(sub) && !telegram.includes(`tidegap channels ${sub}`)) bad.push(`\`tidegap channels ${sub}\` is on neither page`);
  // Every quoted `tidegap channels … --help` block equals the CLI's output.
  const blocks = [...page.matchAll(/^`tidegap (channels(?: [a-z]+)?) --help`:\n\n```[a-z]*\n([\s\S]*?)\n```/gm)];
  if (blocks.length === 0) bad.push(`${pageName} quotes no \`tidegap channels … --help\` block`);
  // A help body in any other shape would drop out of the match above: count every quoted Usage line.
  const usages = page.match(/^Usage: tidegap channels\b/gm)?.length ?? 0;
  if (usages !== blocks.length) bad.push(`${usages} quoted \`Usage: tidegap channels\` lines, but ${blocks.length} help blocks in the checked shape`);
  for (const [, cmd, text] of blocks) {
    const r = help(cmd);
    if (r.code !== 0 || r.stdout.trimEnd() !== text.trimEnd()) bad.push(`\`tidegap ${cmd} --help\` block differs from the CLI output`);
  }
  return bad;
}
