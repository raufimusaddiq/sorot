// Terminal questions for the interactive commands (`sorot publish` without
// --to, `sorot connect setup`). A secret answer (an API key) is not echoed.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export function ask(input: Readable, output: Writable, question: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    let muted = false;
    let answered = false;
    if (secret) {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
        if (!muted) output.write(s);
      };
    }
    rl.on("close", () => {
      if (!answered) resolve("");   // end of input: no answer
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (secret) output.write("\n");
      resolve(answer.trim());
    });
    muted = secret;
  });
}
