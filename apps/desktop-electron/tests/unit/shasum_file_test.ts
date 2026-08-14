import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { sha256FileWithShasum } from "../../scripts/shasum_file";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "voice2text-shasum-test-"));
  temporaryRoots.push(root);
  return root;
}

it.runIf(process.platform === "darwin")(
  "hashes through the bounded macOS shasum subprocess",
  async () => {
    const root = temporaryRoot();
    const file = path.join(root, "fixture.bin");
    writeFileSync(file, "fixture bytes");
    await expect(sha256FileWithShasum(file)).resolves.toBe(
      createHash("sha256").update("fixture bytes").digest("hex"),
    );
  },
);

it.runIf(process.platform === "darwin")(
  "hashes a large sparse artifact without a Bun file stream",
  async () => {
    const root = temporaryRoot();
    const file = path.join(root, "large-artifact.bin");
    const megabyte = Buffer.alloc(1024 * 1024);
    const expected = createHash("sha256");
    writeFileSync(file, "");
    truncateSync(file, 128 * 1024 * 1024);
    for (let index = 0; index < 128; index += 1) expected.update(megabyte);

    await expect(sha256FileWithShasum(file)).resolves.toBe(
      expected.digest("hex"),
    );
  },
);

it("reuses the bounded shasum helper for manifest artifacts", () => {
  const writer = readFileSync(
    path.resolve("scripts/write-worker-manifest.ts"),
    "utf8",
  );
  expect(writer).toContain("sha256FileWithShasum(file)");
  expect(writer).not.toContain("createReadStream");
});

it("kills and rejects a hashing subprocess that exceeds its deadline", async () => {
  const root = temporaryRoot();
  const file = path.join(root, "fixture.bin");
  const command = path.join(root, "stalling-shasum");
  writeFileSync(file, "fixture bytes");
  writeFileSync(command, "#!/bin/sh\nwhile :; do :; done\n");
  chmodSync(command, 0o700);
  await expect(
    sha256FileWithShasum(file, { command, timeoutMs: 25 }),
  ).rejects.toThrow(/deadline/i);
});

it("rejects unbounded subprocess output", async () => {
  const root = temporaryRoot();
  const file = path.join(root, "fixture.bin");
  const command = path.join(root, "noisy-shasum");
  writeFileSync(file, "fixture bytes");
  writeFileSync(command, "#!/bin/sh\nyes x | head -c 2048\n");
  chmodSync(command, 0o700);
  await expect(
    sha256FileWithShasum(file, { command, timeoutMs: 3000 }),
  ).rejects.toThrow(/output limit/i);
});
