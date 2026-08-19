import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResourceDownloadCache,
  type ResourceDownload,
} from "../../scripts/resource-download-cache";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  cacheRoot: string;
  stagingRoot: string;
  request: ResourceDownload;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice2text-cache-test-"));
  roots.push(root);
  const bytes = Buffer.from("verified fixture");
  return {
    root,
    cacheRoot: path.join(root, "cache"),
    stagingRoot: path.join(root, "staging"),
    request: {
      source: "https://example.test/resource",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      stagingPath: path.join(root, "staging", "resource.download"),
    },
  };
}

async function markManagedCacheRoot(cacheRoot: string): Promise<void> {
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(
    path.join(cacheRoot, ".voice2text-resource-download-cache-v1"),
    "voice2text-resource-download-cache/v1\n",
  );
}

describe("ResourceDownloadCache", () => {
  it("downloads once and returns verified private snapshots on later uses", async () => {
    const value = await fixture();
    const downloader = vi.fn(async (_source: string, destination: string) => {
      await writeFile(destination, "verified fixture");
    });
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader,
    });

    await cache.assertWorkingSet([value.request]);
    await cache.snapshot(value.request);
    const secondPath = path.join(value.stagingRoot, "second.download");
    await cache.snapshot({ ...value.request, stagingPath: secondPath });

    expect(downloader).toHaveBeenCalledOnce();
    expect(await readFile(secondPath, "utf8")).toBe("verified fixture");
    expect((await lstat(secondPath)).isFile()).toBe(true);
  });

  it("replaces corrupt, symbolic-link, and forced-refresh entries", async () => {
    const value = await fixture();
    const downloader = vi.fn(async (_source: string, destination: string) => {
      await writeFile(destination, "verified fixture");
    });
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader,
    });
    await markManagedCacheRoot(value.cacheRoot);
    const objectPath = cache.objectPath(value.request.sha256);
    await writeFile(objectPath, "corrupt");

    await cache.snapshot(value.request);
    expect(downloader).toHaveBeenCalledOnce();

    await rm(value.request.stagingPath);
    await rm(objectPath);
    await symlink(path.join(value.root, "missing"), objectPath);
    await cache.snapshot(value.request);
    expect(downloader).toHaveBeenCalledTimes(2);

    await rm(value.request.stagingPath);
    const forced = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      forceFresh: true,
      downloader,
    });
    await forced.snapshot(value.request);
    expect(downloader).toHaveBeenCalledTimes(3);
  });

  it("leaves no published partial when acquisition fails", async () => {
    const value = await fixture();
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader: async (_source, destination) => {
        await writeFile(destination, "partial");
        throw new Error("network stopped");
      },
    });

    await expect(cache.snapshot(value.request)).rejects.toThrow(
      "network stopped",
    );
    await expect(
      lstat(cache.objectPath(value.request.sha256)),
    ).rejects.toThrow();
  });

  it("removes abandoned cache-owned downloads on the next use", async () => {
    const value = await fixture();
    await markManagedCacheRoot(value.cacheRoot);
    const abandoned = path.join(
      value.cacheRoot,
      `.${value.request.sha256}.99999999.00000000-0000-4000-8000-000000000000.download`,
    );
    await writeFile(abandoned, "partial");
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader: async (_source, destination) => {
        await writeFile(destination, "verified fixture");
      },
    });

    await cache.snapshot(value.request);

    await expect(lstat(abandoned)).rejects.toThrow();
  });

  it("rejects an undersized ceiling before downloading", async () => {
    const value = await fixture();
    const downloader = vi.fn();
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: value.request.bytes! - 1,
      downloader,
    });

    await expect(cache.assertWorkingSet([value.request])).rejects.toThrow(
      /configured=15 required=16/,
    );
    expect(downloader).not.toHaveBeenCalled();
  });

  it("prunes oldest unprotected objects while keeping protected snapshots valid", async () => {
    const value = await fixture();
    const oldBytes = Buffer.from("old object");
    const oldSha = createHash("sha256").update(oldBytes).digest("hex");
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: value.request.bytes,
      downloader: async (_source, destination) => {
        await writeFile(destination, "verified fixture");
      },
    });
    await markManagedCacheRoot(value.cacheRoot);
    const oldPath = cache.objectPath(oldSha);
    await writeFile(oldPath, oldBytes);
    await utimes(oldPath, new Date(0), new Date(0));
    await cache.snapshot(value.request);

    await cache.prune(new Set([value.request.sha256]));

    await expect(lstat(oldPath)).rejects.toThrow();
    expect(await readFile(value.request.stagingPath, "utf8")).toBe(
      "verified fixture",
    );
  });

  it("does not expose a partial object to concurrent cache instances", async () => {
    const value = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstDownloader = vi.fn(
      async (_source: string, destination: string) => {
        await writeFile(destination, "partial");
        await blocked;
        await writeFile(destination, "verified fixture");
      },
    );
    const secondDownloader = vi.fn(
      async (_source: string, destination: string) => {
        await writeFile(destination, "verified fixture");
      },
    );
    const first = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader: firstDownloader,
    });
    const second = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader: secondDownloader,
    });
    const firstRun = first.snapshot(value.request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPath = path.join(value.stagingRoot, "concurrent.download");
    const secondRun = second.snapshot({
      ...value.request,
      stagingPath: secondPath,
    });
    release();
    await Promise.all([firstRun, secondRun]);

    expect(firstDownloader).toHaveBeenCalledOnce();
    expect(secondDownloader).not.toHaveBeenCalled();
    expect(await readFile(secondPath, "utf8")).toBe("verified fixture");
  });

  it("keeps the cache object isolated from staging mutations", async () => {
    const value = await fixture();
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader: async (_source, destination) => {
        await writeFile(destination, "verified fixture");
      },
    });
    await cache.snapshot(value.request);
    await writeFile(value.request.stagingPath, "mutated staging");

    expect(await readFile(cache.objectPath(value.request.sha256), "utf8")).toBe(
      "verified fixture",
    );
  });

  it("rejects an existing unmarked cache root without changing its contents", async () => {
    const value = await fixture();
    await mkdir(value.cacheRoot, { recursive: true, mode: 0o755 });
    const sentinel = path.join(value.cacheRoot, "keep.txt");
    await writeFile(sentinel, "keep");
    const cache = new ResourceDownloadCache({
      root: value.cacheRoot,
      limitBytes: 1024,
      downloader: vi.fn(),
    });

    await expect(cache.snapshot(value.request)).rejects.toThrow(
      /not managed by Voice2Text/,
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  });

  it("rejects a cache root reached through a symbolic-link parent", async () => {
    const value = await fixture();
    const actualParent = path.join(value.root, "actual");
    const linkedParent = path.join(value.root, "linked");
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent);
    const cache = new ResourceDownloadCache({
      root: path.join(linkedParent, "cache"),
      limitBytes: 1024,
      downloader: vi.fn(),
    });

    await expect(cache.snapshot(value.request)).rejects.toThrow(
      /must not traverse symbolic links/,
    );
  });
});
