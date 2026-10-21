/** The hidden prompt of `tidegap channels add`: no echo, and a cancel is an error, not an empty answer. */

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { PromptCancelled, promptSecret } from "../src/commands/prompt-secret.js";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (c: Buffer) => (shown += c.toString("utf8")));
  return { input, output, shown: () => shown };
}

describe("promptSecret", () => {
  it("returns the typed line and never writes it to the output", async () => {
    const s = streams();
    const answer = promptSecret("Token (hidden): ", { input: s.input, output: s.output });
    s.input.write("s3cret-value-123\n");
    expect(await answer).toBe("s3cret-value-123");
    expect(s.shown()).toContain("Token (hidden): ");
    expect(s.shown()).not.toContain("s3cret");
  });

  it("end of input (Ctrl+D) before Enter rejects with PromptCancelled", async () => {
    const s = streams();
    const answer = promptSecret("Token: ", { input: s.input, output: s.output });
    s.input.end();
    await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
  });

  it("Ctrl+C rejects with PromptCancelled and echoes nothing typed before it", async () => {
    const s = streams();
    const answer = promptSecret("Token: ", { input: s.input, output: s.output });
    s.input.write("half-typed");
    s.input.write("\x03");
    await expect(answer).rejects.toBeInstanceOf(PromptCancelled);
    expect(s.shown()).not.toContain("half-typed");
  });
});
