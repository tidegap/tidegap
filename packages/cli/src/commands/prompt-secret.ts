/**
 * A hidden prompt for `tidegap channels add` (all-channels plan U13): the
 * typed characters are not echoed, so a secret never shows on screen or in
 * the scrollback. Only for a TTY; the caller checks `isTTY` first.
 */

import { createInterface } from "node:readline";

export interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Ctrl+C or Ctrl+D before Enter: the caller stops with a non-zero exit. */
export class PromptCancelled extends Error {
  override name = "PromptCancelled";
}

/** Ask `question`, read one line without echo, resolve with it (untrimmed); reject with {@link PromptCancelled} on Ctrl+C or end of input. */
export function promptSecret(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stderr;
  const rl = createInterface({ input, output, terminal: true });
  let muted = false;
  // readline echoes through this private hook; muted, only the final newline goes out.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
    if (!muted) output.write(s);
    else if (s.includes("\n")) output.write("\n");
  };
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.once("close", () => {
      if (answered) return;
      output.write("\n");
      reject(new PromptCancelled("cancelled"));
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}
