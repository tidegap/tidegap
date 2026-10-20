// Shortcuts kind (integrations plan U12): the fake `shortcuts` bin (TIDEGAP_SHORTCUTS_BIN in the QA env) records its argv and input.
// S13.8 (a real Shortcut from the launchd tick) stays owner-manual; QA never runs a real Shortcut.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const kind = "shortcuts";

export const cases = [
  {
    id: "S13.8f",
    title: "a finished task runs `shortcuts run <name> --input-path <file>` with the message; the file is gone after",
    async run({ s, addChannel, runTask, lastDelivery, expect }) {
      if (process.platform !== "darwin") return void s.log("S13.8f: Shortcuts is macOS only; nothing to run here");
      const log = join(s.home, "fake-shortcuts.log");
      addChannel("shortcuts", { config: { name: "Tidegap QA" } });
      await runTask("qa shortcut run");
      const runs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      expect(runs.length === 1, `the fake bin ran ${runs.length} time(s)`);
      const [run] = runs;
      expect(run.argv[0] === "run" && run.argv[1] === "Tidegap QA" && run.argv[2] === "--input-path", `argv: ${run.argv.slice(0, 3).join(" ")}`);
      expect(run.input?.includes("qa shortcut run"), "the input file misses the task title");
      expect(!existsSync(run.argv[3]), "the input file is still there");
      expect(!run.env.some((k) => k.startsWith("TIDEGAP_")), "a TIDEGAP_ variable reached the child");
      expect(lastDelivery("shortcuts")?.ok === true, "channel_last:shortcuts is not ok");
    },
  },
];

/** S2.29: the card's fields (macOS only; the page does not offer the kind elsewhere). */
export const ui = { fields: () => ({ name: "Tidegap QA" }) };
