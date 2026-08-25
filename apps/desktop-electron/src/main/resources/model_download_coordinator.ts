import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

import type { LocalModelBundleId } from "../../shared/contracts";
import { writeJsonAtomically } from "../profile/atomic_json";
import { sha256File } from "../security/sha256_file";

export interface TrustedModelDownload {
  bundleId: LocalModelBundleId;
  catalogIdentity: string;
  url: string;
  allowedOrigins: readonly string[];
  archiveBytes: number;
  archiveSha256: string;
  distributionEligible: boolean;
}

interface DownloadJournal {
  schemaVersion: 1;
  bundleId: LocalModelBundleId;
  catalogIdentity: string;
  urlIdentity: string;
  confirmedBytes: number;
  etag: string | null;
  lastModified: string | null;
}

export class ModelDownloadCoordinator {
  private abort: AbortController | null = null;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  pause(): void {
    this.abort?.abort("paused");
  }

  cancel(partialPath: string, journalPath: string): void {
    this.abort?.abort("canceled");
    removeIfPresent(partialPath);
    removeIfPresent(journalPath);
  }

  async download(options: {
    entry: TrustedModelDownload;
    partialPath: string;
    journalPath: string;
    completedPath: string;
    onProgress: (confirmedBytes: number) => void;
  }): Promise<void> {
    validateEntry(options.entry);
    if (!options.entry.distributionEligible) {
      throw new Error("该模型尚未通过产品分发审核");
    }
    if (this.abort) throw new Error("已有模型下载正在进行");
    const abort = new AbortController();
    this.abort = abort;
    try {
      let journal = readJournal(options.journalPath);
      let offset = existsSync(options.partialPath)
        ? fileSize(options.partialPath)
        : 0;
      if (!journalMatches(journal, options.entry, offset)) {
        removeIfPresent(options.partialPath);
        removeIfPresent(options.journalPath);
        journal = null;
        offset = 0;
      }
      const headers = new Headers();
      if (offset > 0 && journal) {
        headers.set("Range", `bytes=${offset}-`);
        if (journal.etag) headers.set("If-Range", journal.etag);
        else if (journal.lastModified) {
          headers.set("If-Range", journal.lastModified);
        }
      }
      let response = await fetchTrusted(this.fetcher, options.entry, {
        headers,
        signal: abort.signal,
      });
      assertTrustedResponse(response, options.entry);
      if (offset > 0 && !validResumeResponse(response, offset, journal!)) {
        removeIfPresent(options.partialPath);
        removeIfPresent(options.journalPath);
        offset = 0;
        response = await fetchTrusted(this.fetcher, options.entry, {
          signal: abort.signal,
        });
        assertTrustedResponse(response, options.entry);
        if (response.status !== 200) {
          throw new Error("模型下载源无法安全地从头下载");
        }
      } else if (offset === 0 && response.status !== 200) {
        throw new Error("模型下载响应无效");
      }
      if (!response.body) throw new Error("模型下载响应没有内容");
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      const descriptor = openSync(
        options.partialPath,
        offset > 0 ? "a" : "wx",
        0o600,
      );
      try {
        const reader = response.body.getReader();
        let confirmed = offset;
        let durableConfirmed = offset;
        let lastCheckpointMs = Date.now();
        const checkpoint = () => {
          fsyncSync(descriptor);
          writeJsonAtomically(options.journalPath, {
            schemaVersion: 1,
            bundleId: options.entry.bundleId,
            catalogIdentity: options.entry.catalogIdentity,
            urlIdentity: urlIdentity(options.entry.url),
            confirmedBytes: confirmed,
            etag,
            lastModified,
          });
          durableConfirmed = confirmed;
          lastCheckpointMs = Date.now();
        };
        while (true) {
          const timeout = setTimeout(
            () => abort.abort("download-timeout"),
            30_000,
          );
          const { done, value } = await reader.read().finally(() => {
            clearTimeout(timeout);
          });
          if (done) break;
          if (confirmed + value.byteLength > options.entry.archiveBytes) {
            throw new Error("模型下载超过可信大小");
          }
          writeSync(descriptor, value);
          confirmed += value.byteLength;
          if (
            confirmed - durableConfirmed >= 4 * 1024 ** 2 ||
            Date.now() - lastCheckpointMs >= 1_000
          ) {
            checkpoint();
          }
          options.onProgress(confirmed);
        }
        checkpoint();
      } catch (error) {
        const journal = readJournal(options.journalPath);
        ftruncateSync(descriptor, journal?.confirmedBytes ?? offset);
        throw error;
      } finally {
        closeSync(descriptor);
      }
      const size = fileSize(options.partialPath);
      if (
        size !== options.entry.archiveBytes ||
        (await sha256File(options.partialPath)) !== options.entry.archiveSha256
      ) {
        throw new Error("模型下载完整性校验失败");
      }
      renameSync(options.partialPath, options.completedPath);
      removeIfPresent(options.journalPath);
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }
}

async function fetchTrusted(
  fetcher: typeof fetch,
  entry: TrustedModelDownload,
  init: RequestInit,
): Promise<Response> {
  let current = new URL(entry.url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertTrustedUrl(current, entry);
    const response = await fetcher(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === 5) {
      throw new Error("模型下载重定向无效或次数过多");
    }
    current = new URL(location, current);
  }
  throw new Error("模型下载重定向次数过多");
}

function assertTrustedUrl(url: URL, entry: TrustedModelDownload): void {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !entry.allowedOrigins.includes(url.origin)
  ) {
    throw new Error("模型下载发生了不受信任的重定向");
  }
}

function validateEntry(entry: TrustedModelDownload): void {
  const url = new URL(entry.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("模型目录必须使用可信 HTTPS 地址");
  }
  if (
    !Number.isSafeInteger(entry.archiveBytes) ||
    entry.archiveBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(entry.archiveSha256) ||
    !entry.allowedOrigins.includes(url.origin)
  ) {
    throw new Error("模型下载目录条目无效");
  }
}

function assertTrustedResponse(
  response: Response,
  entry: TrustedModelDownload,
): void {
  const finalUrl = new URL(response.url || entry.url);
  assertTrustedUrl(finalUrl, entry);
}

function validResumeResponse(
  response: Response,
  offset: number,
  journal: DownloadJournal,
): boolean {
  if (response.status !== 206) return false;
  if (!response.headers.get("content-range")?.startsWith(`bytes ${offset}-`)) {
    return false;
  }
  const etag = response.headers.get("etag");
  const lastModified = response.headers.get("last-modified");
  return journal.etag
    ? etag === journal.etag
    : Boolean(journal.lastModified && lastModified === journal.lastModified);
}

function readJournal(journalPath: string): DownloadJournal | null {
  try {
    return JSON.parse(readFileSync(journalPath, "utf8")) as DownloadJournal;
  } catch {
    return null;
  }
}

function journalMatches(
  journal: DownloadJournal | null,
  entry: TrustedModelDownload,
  offset: number,
): boolean {
  return Boolean(
    journal &&
    journal.schemaVersion === 1 &&
    journal.bundleId === entry.bundleId &&
    journal.catalogIdentity === entry.catalogIdentity &&
    journal.urlIdentity === urlIdentity(entry.url) &&
    journal.confirmedBytes === offset &&
    offset > 0 &&
    offset < entry.archiveBytes &&
    (journal.etag || journal.lastModified),
  );
}

function urlIdentity(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return createHash("sha256").update(url.toString()).digest("hex");
}

function removeIfPresent(candidate: string): void {
  try {
    unlinkSync(candidate);
  } catch {
    // Missing files are already removed.
  }
}

function fileSize(candidate: string): number {
  const descriptor = openSync(candidate, "r");
  try {
    return fstatSync(descriptor).size;
  } finally {
    closeSync(descriptor);
  }
}
