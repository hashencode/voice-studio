import { mkdirSync } from "node:fs";

import type { ExecutionIntent } from "../domain/models";

export function prepareProcessingAttempt(options: {
  intent: ExecutionIntent;
  attemptDirectory: string;
  mkdir?: (path: string) => void;
  interrupt(intent: ExecutionIntent, errorCode: string): boolean;
  emitInterrupted(): void;
}): boolean {
  try {
    (options.mkdir ?? createPrivateDirectory)(options.attemptDirectory);
    return true;
  } catch (error) {
    if (!options.interrupt(options.intent, "PROCESS_INTERRUPTED")) {
      throw new Error("processing attempt could not be durably interrupted", {
        cause: error,
      });
    }
    options.emitInterrupted();
    return false;
  }
}

function createPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
}
