import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export function writeJsonAtomically(
  destination: string,
  value: Record<string, unknown>,
): void {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  let published = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeSync(
      descriptor,
      `${JSON.stringify(value, null, 2)}\n`,
      undefined,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    published = true;
    syncDirectory(dirname(destination));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the write or publication failure.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // A missing temporary file means rename already published it.
    }
    if (published) {
      try {
        unlinkSync(destination);
      } catch {
        // The caller still receives the durability failure.
      }
    }
    throw error;
  }
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
