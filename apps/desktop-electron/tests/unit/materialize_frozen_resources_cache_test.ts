import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceDownloadCache } from "../../scripts/resource-download-cache";
import { resourceDownloadPlan } from "../../scripts/resource-download-plan";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("frozen resource acquisition plan", () => {
  it("reuses every acquisition category and reacquires only a corrupt digest", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "voice2text-materializer-cache-test-"),
    );
    roots.push(root);
    const contents = new Map([
      ["https://fixture.test/sherpa", "sherpa archive"],
      ["https://fixture.test/runtime", "runtime archive"],
      ["https://fixture.test/sensevoice", "sensevoice archive"],
      ["https://fixture.test/vad", "vad model"],
    ]);
    const downloader = vi.fn(async (source: string, destination: string) => {
      await writeFile(destination, contents.get(source)!);
    });
    const planFor = (stagingRoot: string) =>
      resourceDownloadPlan({
        authority: {
          downloads: [
            {
              id: "sherpa",
              source: "https://fixture.test/sherpa",
              sha256: sha("sherpa archive"),
              bytes: Buffer.byteLength("sherpa archive"),
              kind: "tar.bz2",
            },
          ],
        },
        senseVoiceAuthority: {
          model: {
            source: "https://fixture.test/sensevoice",
            archiveSha256: sha("sensevoice archive"),
          },
          vad: {
            source: "https://fixture.test/vad",
            sha256: sha("vad model"),
          },
        },
        senseVoiceLock: {
          archiveBytes: Buffer.byteLength("sensevoice archive"),
          vadBytes: Buffer.byteLength("vad model"),
        },
        runtime: {
          source: "https://fixture.test/runtime",
          sha256: sha("runtime archive"),
          bytes: Buffer.byteLength("runtime archive"),
        },
        temporaryRoot: stagingRoot,
        liveCaptionOnly: false,
      });
    const cache = new ResourceDownloadCache({
      root: path.join(root, "cache"),
      limitBytes: 1024,
      downloader,
    });

    const materialize = async (name: string) => {
      const plan = planFor(path.join(root, name));
      await cache.assertWorkingSet(plan);
      await Promise.all(plan.map((download) => cache.snapshot(download)));
      await cache.prune(new Set(plan.map((download) => download.sha256)));
      return await Promise.all(
        plan.map(async (download) => ({
          source: download.source,
          sha256: sha(await readFile(download.stagingPath, "utf8")),
        })),
      );
    };

    const first = await materialize("first");
    const second = await materialize("second");
    expect(downloader).toHaveBeenCalledTimes(4);
    expect(second).toEqual(first);

    await writeFile(cache.objectPath(sha("sensevoice archive")), "corrupt");
    const third = await materialize("third");
    expect(downloader).toHaveBeenCalledTimes(5);
    expect(third).toEqual(first);
  });
});
