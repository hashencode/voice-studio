import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { writeExportAtomically } from "../../../src/main/domain/workspace/atomic_export_writer";
import { exportMeetingResponseSchema } from "../../../src/shared/contracts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("publishes through a same-directory 0600 temp file and preserves an existing export on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice2text-export-"));
  roots.push(root);
  const destination = join(root, "meeting.txt");
  writeFileSync(destination, "old", { mode: 0o600 });
  chmodSync(destination, 0o600);

  await expect(
    writeExportAtomically(destination, "new", {
      beforeRename: async () => {
        throw new Error("injected publication failure");
      },
    }),
  ).rejects.toThrow(/injected/);
  expect(readFileSync(destination, "utf8")).toBe("old");
  expect(statSync(destination).mode & 0o777).toBe(0o600);

  await writeExportAtomically(destination, "new");
  expect(readFileSync(destination, "utf8")).toBe("new");
  expect(statSync(destination).mode & 0o777).toBe(0o600);
});

it("exposes export failures as a bounded typed response without a destination path", () => {
  expect(
    exportMeetingResponseSchema.parse({
      state: "failed",
      code: "export-write-failed",
      message: "会议导出失败，请重试。",
    }),
  ).toEqual({
    state: "failed",
    code: "export-write-failed",
    message: "会议导出失败，请重试。",
  });
  expect(() =>
    exportMeetingResponseSchema.parse({
      state: "failed",
      code: "export-write-failed",
      message: "failed",
      path: "/private/profile/secret.txt",
    }),
  ).toThrow();
});
