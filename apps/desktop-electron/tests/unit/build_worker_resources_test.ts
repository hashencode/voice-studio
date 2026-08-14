import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("worker resource publication", () => {
  it("restores the previous resource tree when signaled after the backup rename", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-resource-publish-"));
    roots.push(root);
    const workerRoot = join(root, "worker");
    const stagingRoot = join(root, ".worker-staging.test");
    mkdirSync(workerRoot);
    mkdirSync(stagingRoot);
    writeFileSync(join(workerRoot, "identity"), "previous");
    writeFileSync(join(stagingRoot, "identity"), "candidate");

    const result = spawnSync(
      "/bin/bash",
      [resolve("scripts/publish-worker-resources.sh"), stagingRoot, workerRoot],
      {
        env: {
          ...process.env,
          VOICE2TEXT_TEST_SIGNAL_AFTER_WORKER_BACKUP: "1",
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(143);
    expect(readFileSync(join(workerRoot, "identity"), "utf8")).toBe("previous");
    expect(readFileSync(join(stagingRoot, "identity"), "utf8")).toBe(
      "candidate",
    );
    expect(
      readdirSync(root).filter((name) => name.startsWith(".worker-previous.")),
    ).toEqual([]);
  });

  it("atomically installs the candidate and removes the backup", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-resource-publish-"));
    roots.push(root);
    const workerRoot = join(root, "worker");
    const stagingRoot = join(root, ".worker-staging.test");
    mkdirSync(workerRoot);
    mkdirSync(stagingRoot);
    writeFileSync(join(workerRoot, "identity"), "previous");
    writeFileSync(join(stagingRoot, "identity"), "candidate");

    const result = spawnSync(
      "/bin/bash",
      [resolve("scripts/publish-worker-resources.sh"), stagingRoot, workerRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(workerRoot, "identity"), "utf8")).toBe(
      "candidate",
    );
    expect(existsSync(stagingRoot)).toBe(false);
    expect(
      readdirSync(root).filter((name) => name.startsWith(".worker-previous.")),
    ).toEqual([]);
  });
});
