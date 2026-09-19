import path from "node:path";

import type { LocalModelBundleId } from "../../shared/contracts";
import type { AppModelCatalogEntry } from "./local_model_service";

export const MODEL_RELEASE_REPOSITORY = "hashencode/voice-studio-models";

export const productionModelCatalog: readonly AppModelCatalogEntry[] = [
  closedProductionEntry("formal-transcription", "本地转写"),
  closedProductionEntry("live-caption", "实时字幕"),
] as const;

export function validateProductionModelCatalog(
  catalog: readonly AppModelCatalogEntry[],
): void {
  const expectedIds = new Set<LocalModelBundleId>([
    "formal-transcription",
    "live-caption",
  ]);
  if (catalog.length !== expectedIds.size) {
    throw new Error(
      "production catalog must contain exactly two model bundles",
    );
  }
  for (const entry of catalog) {
    if (!expectedIds.delete(entry.id)) {
      throw new Error(
        `production catalog contains an unknown or duplicate bundle: ${entry.id}`,
      );
    }
    validateEntry(entry);
  }
  if (expectedIds.size !== 0) {
    throw new Error("production catalog is missing a required model bundle");
  }
}

function closedProductionEntry(
  id: LocalModelBundleId,
  displayName: string,
): AppModelCatalogEntry {
  return {
    id,
    displayName,
    version: "release-evidence-required",
    distributionEligible: false,
    developmentOnly: false,
    licenseComplete: false,
    target: "darwin-arm64",
    runtimeProtocol: "desktop-sherpa-worker/v1",
    download: null,
    inventory: [],
  };
}

function validateEntry(entry: AppModelCatalogEntry): void {
  if (entry.target !== "darwin-arm64") {
    throw new Error(`${entry.id}: unsupported target`);
  }
  if (!entry.runtimeProtocol.trim()) {
    throw new Error(`${entry.id}: runtime protocol is missing`);
  }
  if (entry.distributionEligible) {
    if (entry.developmentOnly) {
      throw new Error(
        `${entry.id}: development-only authority cannot be distributed`,
      );
    }
    if (!entry.licenseComplete) {
      throw new Error(`${entry.id}: license evidence is incomplete`);
    }
    if (!entry.download) {
      throw new Error(`${entry.id}: download metadata is missing`);
    }
    if (entry.inventory.length === 0) {
      throw new Error(`${entry.id}: inventory is missing`);
    }
  }
  if (entry.download) validateDownload(entry);
  validateInventory(entry);
}

function validateDownload(entry: AppModelCatalogEntry): void {
  const download = entry.download!;
  if (
    download.bundleId !== entry.id ||
    download.distributionEligible !== entry.distributionEligible
  ) {
    throw new Error(`${entry.id}: download eligibility disagrees with catalog`);
  }
  if (
    !Number.isSafeInteger(download.archiveBytes) ||
    download.archiveBytes <= 0 ||
    !isSha256(download.archiveSha256) ||
    !isSha256(download.catalogIdentity)
  ) {
    throw new Error(`${entry.id}: archive identity is invalid`);
  }
  const url = new URL(download.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isOwnedVersionedReleaseUrl(url)
  ) {
    throw new Error(`${entry.id}: invalid product GitHub Release URL`);
  }
  if (
    download.allowedOrigins.length === 0 ||
    !download.allowedOrigins.includes(url.origin) ||
    new Set(download.allowedOrigins).size !== download.allowedOrigins.length ||
    download.allowedOrigins.some((origin) => !isHttpsOrigin(origin))
  ) {
    throw new Error(`${entry.id}: redirect origin allowlist is invalid`);
  }
}

function validateInventory(entry: AppModelCatalogEntry): void {
  const paths = new Set<string>();
  for (const item of entry.inventory) {
    if (
      !safeRelativePath(item.path) ||
      paths.has(item.path) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes <= 0 ||
      !isSha256(item.sha256)
    ) {
      throw new Error(`${entry.id}: inventory is invalid`);
    }
    paths.add(item.path);
  }
}

function isOwnedVersionedReleaseUrl(url: URL): boolean {
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repository, releases, download, tag, asset] = parts;
  return (
    url.hostname === "github.com" &&
    parts.length === 6 &&
    owner === "hashencode" &&
    repository === "voice-studio-models" &&
    releases === "releases" &&
    download === "download" &&
    typeof tag === "string" &&
    tag !== "latest" &&
    tag.length > 0 &&
    typeof asset === "string" &&
    asset.length > 0
  );
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === value &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

validateProductionModelCatalog(productionModelCatalog);
