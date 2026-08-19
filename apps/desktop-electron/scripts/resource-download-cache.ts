import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sha256FileWithShasum } from "./shasum_file";

export const DEFAULT_RESOURCE_CACHE_LIMIT_BYTES = 4 * 1024 ** 3;
const LOCK_WAIT_MS = 25;
const SHA256 = /^[a-f0-9]{64}$/;
const CACHE_MARKER = ".voice2text-resource-download-cache-v1";
const CACHE_MARKER_CONTENT = "voice2text-resource-download-cache/v1\n";

export interface ResourceDownload {
  source: string;
  sha256: string;
  bytes?: number;
  stagingPath: string;
}

export type ResourceDownloader = (
  source: string,
  destination: string,
) => Promise<void>;

interface CacheOptions {
  root?: string;
  limitBytes?: number;
  forceFresh?: boolean;
  downloader?: ResourceDownloader;
}

export class ResourceDownloadCache {
  readonly root: string;
  readonly limitBytes: number;
  readonly forceFresh: boolean;
  private readonly downloader: ResourceDownloader;

  constructor(options: CacheOptions = {}) {
    this.root = path.resolve(
      options.root ??
        process.env.VOICE2TEXT_RESOURCE_CACHE_DIR ??
        path.join(
          os.homedir(),
          "Library",
          "Caches",
          "Voice2Text",
          "resource-downloads-v1",
        ),
    );
    this.limitBytes =
      options.limitBytes ?? resourceCacheLimitFromEnvironment(process.env);
    this.forceFresh =
      options.forceFresh ??
      process.env.VOICE2TEXT_FORCE_FRESH_RESOURCE_DOWNLOAD === "1";
    this.downloader = options.downloader ?? curlDownload;
    if (!Number.isSafeInteger(this.limitBytes) || this.limitBytes <= 0) {
      throw new Error("resource cache limit must be a positive integer");
    }
  }

  objectPath(sha256: string): string {
    assertSha256(sha256);
    return path.join(this.root, `${sha256}.blob`);
  }

  async assertWorkingSet(
    downloads: readonly ResourceDownload[],
  ): Promise<void> {
    const unique = new Map<string, number>();
    for (const download of downloads) {
      assertSha256(download.sha256);
      if (
        download.bytes === undefined ||
        !Number.isSafeInteger(download.bytes) ||
        download.bytes <= 0
      ) {
        throw new Error(
          `resource cache working set size is unknown for ${download.sha256}`,
        );
      }
      const prior = unique.get(download.sha256);
      if (prior !== undefined && prior !== download.bytes) {
        throw new Error("resource cache digest has conflicting byte sizes");
      }
      unique.set(download.sha256, download.bytes);
    }
    const required = [...unique.values()].reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    if (required > this.limitBytes) {
      throw new Error(
        `resource cache limit is smaller than the protected working set: configured=${this.limitBytes} required=${required}`,
      );
    }
  }

  async snapshot(download: ResourceDownload): Promise<string> {
    assertSha256(download.sha256);
    if (
      download.bytes !== undefined &&
      (!Number.isSafeInteger(download.bytes) || download.bytes <= 0)
    ) {
      throw new Error("resource cache expected byte size is invalid");
    }
    await this.ensureRoot();
    const object = this.objectPath(download.sha256);
    return await this.withObjectLock(download.sha256, async () => {
      if (!this.forceFresh) {
        if (!(await isVerifiedObject(object, download))) {
          await removeUnsafeEntry(object);
        } else {
          await createPrivateSnapshot(object, download);
          await touch(object);
          return download.stagingPath;
        }
      }

      const temporary = path.join(
        this.root,
        `.${download.sha256}.${process.pid}.${randomUUID()}.download`,
      );
      try {
        await this.downloader(download.source, temporary);
        if (!(await isVerifiedObject(temporary, download))) {
          throw new Error(
            `downloaded resource identity mismatch: ${download.sha256}`,
          );
        }
        await removeUnsafeEntry(object);
        await rename(temporary, object);
        await createPrivateSnapshot(object, download);
        await touch(object);
        return download.stagingPath;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async prune(protectedSha256s: ReadonlySet<string>): Promise<void> {
    for (const sha256 of protectedSha256s) {
      assertSha256(sha256);
    }
    await this.ensureRoot();
    await this.withLock(path.join(this.root, ".prune-lock"), async () => {
      const entries = await readdir(this.root, { withFileTypes: true });
      const objects: Array<{
        path: string;
        sha256: string;
        bytes: number;
        mtimeMs: number;
      }> = [];
      let total = 0;
      for (const entry of entries) {
        const match = /^([a-f0-9]{64})\.blob$/.exec(entry.name);
        if (!match) continue;
        const object = path.join(this.root, entry.name);
        let metadata;
        try {
          metadata = await lstat(object);
        } catch (error) {
          if (isMissingError(error)) continue;
          throw error;
        }
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          await this.withObjectLock(match[1]!, async () => {
            await rm(object, { force: true, recursive: true });
          });
          continue;
        }
        total += metadata.size;
        objects.push({
          path: object,
          sha256: match[1]!,
          bytes: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      }
      objects.sort((left, right) => left.mtimeMs - right.mtimeMs);
      for (const object of objects) {
        if (total <= this.limitBytes) break;
        if (protectedSha256s.has(object.sha256)) continue;
        const removed = await this.withObjectLock(object.sha256, async () => {
          try {
            const current = await lstat(object.path);
            if (!current.isFile() || current.isSymbolicLink()) return 0;
            if (current.mtimeMs !== object.mtimeMs) return 0;
            await rm(object.path, { force: true });
            return current.size;
          } catch (error) {
            if (isMissingError(error)) return 0;
            throw error;
          }
        });
        total -= removed;
      }
      if (total > this.limitBytes) {
        throw new Error(
          `resource cache cannot satisfy limit without removing protected objects: configured=${this.limitBytes} retained=${total}`,
        );
      }
    });
  }

  private async ensureRoot(): Promise<void> {
    const created = await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("resource cache root must be a private directory");
    }
    if ((await realpath(this.root)) !== canonicalSystemPath(this.root)) {
      throw new Error("resource cache root must not traverse symbolic links");
    }
    const marker = path.join(this.root, CACHE_MARKER);
    if (created !== undefined) {
      await writeFile(marker, CACHE_MARKER_CONTENT, {
        flag: "wx",
        mode: 0o600,
      });
    } else {
      let markerValue: string | undefined;
      try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            const markerMetadata = await lstat(marker);
            if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
              throw new Error("resource cache marker is unsafe");
            }
            markerValue = await readFile(marker, "utf8");
            break;
          } catch (error) {
            if (!isMissingError(error) || attempt === 9) throw error;
            await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
          }
        }
      } catch (error) {
        if (isMissingError(error)) {
          throw new Error(
            "existing resource cache root is not managed by Voice2Text",
          );
        }
        throw error;
      }
      if (markerValue !== CACHE_MARKER_CONTENT) {
        throw new Error("resource cache marker is invalid");
      }
    }
    await chmod(this.root, 0o700);
    await this.removeAbandonedDownloads();
  }

  private async removeAbandonedDownloads(): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      const match = /^\.[a-f0-9]{64}\.(\d+)\.[a-f0-9-]+\.download$/.exec(
        entry.name,
      );
      if (!match || !entry.isFile()) continue;
      const ownerPid = Number(match[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) continue;
      if (!processIsAlive(ownerPid)) {
        await rm(path.join(this.root, entry.name), { force: true });
      }
    }
  }

  private async withObjectLock<T>(
    sha256: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.withLock(
      path.join(this.root, `.${sha256}.lock`),
      operation,
    );
  }

  private async withLock<T>(
    lockPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    while (true) {
      if (await tryAcquireShlock(lockPath)) break;
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

export function resourceCacheLimitFromEnvironment(
  environment: NodeJS.ProcessEnv,
): number {
  const raw = environment.VOICE2TEXT_RESOURCE_CACHE_LIMIT_GIB;
  if (raw === undefined || raw === "")
    return DEFAULT_RESOURCE_CACHE_LIMIT_BYTES;
  const gib = Number(raw);
  const bytes = gib * 1024 ** 3;
  if (!Number.isFinite(gib) || gib <= 0 || !Number.isSafeInteger(bytes)) {
    throw new Error(
      "VOICE2TEXT_RESOURCE_CACHE_LIMIT_GIB must be a positive GiB value",
    );
  }
  return bytes;
}

async function isVerifiedObject(
  file: string,
  expected: Pick<ResourceDownload, "sha256" | "bytes">,
): Promise<boolean> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    if (expected.bytes !== undefined && metadata.size !== expected.bytes)
      return false;
    return (await sha256FileWithShasum(file)) === expected.sha256;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

async function createPrivateSnapshot(
  object: string,
  download: ResourceDownload,
): Promise<void> {
  await mkdir(path.dirname(download.stagingPath), {
    recursive: true,
    mode: 0o700,
  });
  await rm(download.stagingPath, { force: true });
  await copyFile(object, download.stagingPath, constants.COPYFILE_FICLONE);
  if (!(await isVerifiedObject(download.stagingPath, download))) {
    await rm(download.stagingPath, { force: true });
    throw new Error(
      `resource staging snapshot identity mismatch: ${download.sha256}`,
    );
  }
}

async function touch(file: string): Promise<void> {
  const now = new Date();
  await utimes(file, now, now);
}

async function removeUnsafeEntry(file: string): Promise<void> {
  try {
    const metadata = await lstat(file);
    await rm(file, { force: true, recursive: metadata.isDirectory() });
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
}

async function tryAcquireShlock(lockPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/shlock",
      ["-f", lockPath, "-p", `${process.pid}`],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`shlock failed with ${signal}`));
      else resolve(code === 0);
    });
  });
}

async function curlDownload(
  source: string,
  destination: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "--fail",
        "--location",
        "--show-error",
        "--progress-bar",
        "--output",
        destination,
        source,
      ],
      { stdio: "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`curl failed with ${signal ?? `exit ${code}`}`));
    });
  });
}

function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("resource cache SHA-256 is invalid");
}

function canonicalSystemPath(value: string): string {
  if (value === "/tmp" || value.startsWith("/tmp/")) {
    return `/private${value}`;
  }
  if (value === "/var" || value.startsWith("/var/")) {
    return `/private${value}`;
  }
  return value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
