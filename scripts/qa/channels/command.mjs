// Command kind: the fake program records its argv, stdin, working directory and environment names.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { FAKE_COMMAND } from "../env.mjs";

export const kind = "command";

export const cases = [
  {
    id: "S13.12",
    title: "a finished task runs the program with the Tidegap JSON on stdin, argv as typed, a minimal env",
    async run({ s, addChannel, runTask, lastDelivery, expect }) {
      const log = join(s.home, "command-qa.log");
      addChannel("command", { config: { path: FAKE_COMMAND, args: `${log}\nhello world; $(rm -rf ~)` } });
      const { id } = await runTask("qa command run");
      const runs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      expect(runs.length === 1, `the program ran ${runs.length} time(s)`);
      const [run] = runs;
      expect(run.argv.length === 2 && run.argv[1] === "hello world; $(rm -rf ~)", `argv: ${JSON.stringify(run.argv)}`);
      const body = JSON.parse(run.input);
      expect(body.version === 1 && body.event === "task_done" && body.task?.id === id, `stdin: ${run.input.slice(0, 200)}`);
      const extra = run.env.filter((k) => !["PATH", "HOME", "LANG", "TMPDIR", "PWD", "SHLVL", "_"].includes(k) && !k.startsWith("__CF"));
      expect(extra.length === 0, `extra env: ${extra.join(", ")}`);
      expect(lastDelivery("command")?.ok === true, "channel_last:command is not ok");
    },
  },
];

/** S2.29: the card's fields; with no argument the program logs to $HOME/fake-command.log. */
export const ui = { fields: () => ({ path: FAKE_COMMAND }) };
