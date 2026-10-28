// Tests for scripts/qa/docs-drift-channels.mjs (node --test): the pass path, each vacuous-pass
// guard and each failure kind of the K13 channels drift rule, on a small fixture page, a fake
// core and a fake --help reader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { channelsDocsProblems } from "./docs-drift-channels.mjs";

// The registry and code lists, cut down to what K13 reads: two ready kinds and one that is not.
const CORE = {
  KIND_DESCRIPTORS: {
    slack: { kind: "slack", ready: true, docsAnchor: "notify-slack", fields: [{ name: "webhook_url" }], errors: { slack_payload: { text: "Slack refused it." } } },
    webhook: { kind: "webhook", ready: true, docsAnchor: "notify-webhook", fields: [{ name: "url" }, { name: "sign_secret" }] },
    shortcuts: { kind: "shortcuts", ready: false, docsAnchor: "notify-shortcuts", fields: [{ name: "shortcut" }] },
  },
  DELIVERY_CODES: ["auth", "http_404", "network", "timeout"],
  EVENT_KINDS: ["task_done", "task_failed", "clean_window", "not_ready", "digest"],
  CHANNEL_KINDS: ["telegram", "slack", "webhook", "shortcuts"],
};

const SUBS = ["add", "list", "test", "remove", "pair"];

const HELP = {
  channels: "Usage: tidegap channels [options] [command]\n\nSend task events to the channels you set up.",
  "channels add": "Usage: tidegap channels add [options] <kind>\n\nConnect a channel: send a test message, then save it.",
};

/** The fake CLI: the stored text for a known command, exit 1 for any other. */
const HELP_READER = (cmd) => (Object.hasOwn(HELP, cmd) ? { code: 0, stdout: `${HELP[cmd]}\n` } : { code: 1, stdout: "" });

// Event kinds, a field name, a `task_` name, `redact_in_receipt` and a kind name in
// parentheses sit beside real codes, so the pass path also proves they are not read as codes.
const PAGE = `### Events {#notify-events}

Events are \`task_done\`, \`clean_window\` and \`digest\`. A retry, \`task_retry\`, is not an event.

### Slack {#notify-slack}

<!-- embed:channel-slack -->

Paste the \`webhook_url\`. A refused payload reads \`slack_payload\`; a deleted hook reads \`http_404\`. This card (\`slack\`) has no secret besides the URL.

### Webhook {#notify-webhook}

<!-- embed:channel-webhook -->

A receiver that does not answer ends with (\`timeout\`). Set \`redact_in_receipt\` to hide the prompt.

### CLI {#notify-cli}

\`\`\`bash
tidegap channels add slack
tidegap channels list
tidegap channels test slack
tidegap channels remove slack
\`\`\`

\`tidegap channels --help\`:

\`\`\`
${HELP.channels}
\`\`\`

\`tidegap channels add --help\`:

\`\`\`text
${HELP["channels add"]}
\`\`\`

### Security {#notify-security}

Secrets stay in the secrets file.
`;
const TELEGRAM = "Pair a chat with `tidegap channels pair`.";

const k13 = ({ page = PAGE, telegram = TELEGRAM, core = CORE, subs = SUBS, help = HELP_READER } = {}) =>
  channelsDocsProblems({ page, pageName: "notifications.md", telegram, core, subs, help });

/** Replace one exact span; fails when the fixture no longer has it, so a mutation never runs vacuously. */
function edit(text, from, to) {
  assert.ok(text.includes(from), `fixture has ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

/** CORE with the descriptor of `kind` replaced by `change(descriptor)`. */
const coreWithKind = (kind, change) => ({ ...CORE, KIND_DESCRIPTORS: { ...CORE.KIND_DESCRIPTORS, [kind]: change(CORE.KIND_DESCRIPTORS[kind]) } });

test("K13: a page, a core and a CLI that agree pass", () => {
  assert.deepEqual(k13(), []);
});

// One case per vacuous-pass guard: one mutation of the fixture page, the fake core or the
// subcommand list, and the full problem list, so a guard that stops firing fails its case.
// Problems that follow from the same input are in the list too.
const GUARDS = [
  {
    name: "an empty DELIVERY_CODES",
    input: () => ({ core: { ...CORE, DELIVERY_CODES: [] } }),
    want: ["core DELIVERY_CODES is empty", "quoted code `http_404` is not in the code", "quoted code `timeout` is not in the code"],
  },
  {
    name: "a registry with no ready kind",
    input: () => ({ core: { ...CORE, KIND_DESCRIPTORS: Object.fromEntries(Object.entries(CORE.KIND_DESCRIPTORS).map(([k, d]) => [k, { ...d, ready: false }])) } }),
    want: [
      "KIND_DESCRIPTORS has no ready kind",
      "kind sections slack,webhook vs registry ",
      "quoted code `webhook_url` is not in the code",
      "quoted code `slack_payload` is not in the code",
    ],
  },
  {
    name: "a page with no {#notify-<kind>} section",
    input: () => ({ page: edit(edit(PAGE, " {#notify-slack}", ""), " {#notify-webhook}", "") }),
    want: [
      "notifications.md has no {#notify-<kind>} section",
      "kind sections  vs registry slack,webhook",
      "slack: section lacks <!-- embed:channel-slack -->",
      "webhook: section lacks <!-- embed:channel-webhook -->",
    ],
  },
  {
    name: "an empty CHANNEL_KINDS",
    input: () => ({ core: { ...CORE, CHANNEL_KINDS: [] } }),
    want: ["CHANNEL_KINDS is empty", "quoted code `slack` is not in the code"],
  },
  {
    name: "a page that quotes no snake-case code",
    input: () => ({
      page: edit(
        edit(PAGE, "A refused payload reads `slack_payload`; a deleted hook reads `http_404`. ", ""),
        " Set `redact_in_receipt` to hide the prompt.",
        "",
      ),
    }),
    want: ["notifications.md quotes no error code"],
  },
  {
    name: "four channels subcommands",
    input: () => ({ subs: SUBS.filter((s) => s !== "pair") }),
    want: ["only 4 channels subcommands found"],
  },
  {
    name: "a page with no --help block",
    input: () => ({
      page: edit(edit(PAGE, `\`tidegap channels --help\`:\n\n\`\`\`\n${HELP.channels}\n\`\`\`\n\n`, ""), `\`tidegap channels add --help\`:\n\n\`\`\`text\n${HELP["channels add"]}\n\`\`\`\n\n`, ""),
    }),
    want: ["notifications.md quotes no `tidegap channels … --help` block"],
  },
  {
    name: "a quoted Usage line outside a checked help block",
    input: () => ({ page: edit(PAGE, "`tidegap channels add --help`:\n\n```text", "`tidegap channels add --help`:\n```text") }),
    want: ["2 quoted `Usage: tidegap channels` lines, but 1 help blocks in the checked shape"],
  },
];

for (const { name, input, want } of GUARDS) {
  test(`K13 guard: ${name} fails`, () => {
    assert.deepEqual(k13(input()), want);
  });
}

// One case per failure kind.
const FAILURES = [
  {
    name: "kind sections out of registry order",
    input: () => {
      const slack = PAGE.slice(PAGE.indexOf("### Slack"), PAGE.indexOf("### Webhook"));
      return { page: edit(PAGE, slack, "").replace("### CLI", `${slack}### CLI`) };
    },
    want: ["kind sections webhook,slack vs registry slack,webhook"],
  },
  {
    name: "a docsAnchor that differs",
    input: () => ({ core: coreWithKind("slack", (d) => ({ ...d, docsAnchor: "notify-slack-app" })) }),
    want: ["slack: docsAnchor notify-slack-app"],
  },
  {
    name: "a kind section without its embed marker",
    input: () => ({ page: edit(PAGE, "<!-- embed:channel-webhook -->\n\n", "") }),
    want: ["webhook: section lacks <!-- embed:channel-webhook -->"],
  },
  {
    name: "a backticked snake-case code that is not in the code",
    input: () => ({ page: edit(PAGE, "reads `slack_payload`", "reads `slack_payload_bad`") }),
    want: ["quoted code `slack_payload_bad` is not in the code"],
  },
  {
    name: "a one-word code in parentheses that is not in the code",
    input: () => ({ page: edit(PAGE, "ends with (`timeout`)", "ends with (`timedout`)") }),
    want: ["quoted code `timedout` is not in the code"],
  },
  {
    name: "a page that names an unknown subcommand",
    input: () => ({ page: edit(PAGE, "tidegap channels list\n", "tidegap channels list\ntidegap channels purge\n") }),
    want: ["page names unknown `tidegap channels purge`"],
  },
  {
    name: "a subcommand on neither page",
    input: () => ({ telegram: "Pair a chat in the Telegram card." }),
    want: ["`tidegap channels pair` is on neither page"],
  },
  {
    name: "a help block that differs from the reader's output",
    input: () => ({ page: edit(PAGE, "Connect a channel: send a test message, then save it.", "Connect a channel and save it.") }),
    want: ["`tidegap channels add --help` block differs from the CLI output"],
  },
  {
    name: "a reader that exits non-zero",
    input: () => ({ help: (cmd) => (cmd === "channels" ? { ...HELP_READER(cmd), code: 1 } : HELP_READER(cmd)) }),
    want: ["`tidegap channels --help` block differs from the CLI output"],
  },
];

for (const { name, input, want } of FAILURES) {
  test(`K13: ${name} fails`, () => {
    assert.deepEqual(k13(input()), want);
  });
}

// Each token the rule must not read as a code, shown to be read when its exclusion is gone:
// the pass path above passes only because the exclusion holds. The `task_` exclusion is a
// pattern, not a list: the pass path fails without it (`task_retry`).
const NOT_CODES = [
  { name: "an event kind", input: () => ({ core: { ...CORE, EVENT_KINDS: CORE.EVENT_KINDS.filter((e) => e !== "clean_window") } }), code: "clean_window" },
  { name: "a field name", input: () => ({ core: coreWithKind("slack", (d) => ({ ...d, fields: [] })) }), code: "webhook_url" },
  { name: "a kind name in parentheses", input: () => ({ core: { ...CORE, CHANNEL_KINDS: CORE.CHANNEL_KINDS.filter((k) => k !== "slack") } }), code: "slack" },
];

for (const { name, input, code } of NOT_CODES) {
  test(`K13: ${name} is not read as a code (and is, once it leaves its list)`, () => {
    assert.deepEqual(k13(input()), [`quoted code \`${code}\` is not in the code`]);
  });
}
