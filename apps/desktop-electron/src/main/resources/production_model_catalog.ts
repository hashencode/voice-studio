import path from "node:path";

import type { LocalModelBundleId } from "../../shared/contracts";
import type { AppModelCatalogEntry } from "./local_model_service";

export const MODEL_RELEASE_REPOSITORY = "hashencode/voice-studio-models";

export const productionModelCatalog: readonly AppModelCatalogEntry[] = [
  {
    id: "formal-transcription",
    displayName: "本地转写",
    version: "qwen3-asr-0.6b-int8-2026-03-25",
    distributionEligible: true,
    developmentOnly: false,
    licenseComplete: true,
    target: "darwin-arm64",
    runtimeProtocol: "desktop-sherpa-worker/v1",
    download: {
      bundleId: "formal-transcription",
      catalogIdentity:
        "674908c4b847caabd25a011aa457c280ed1e872b88c8234aa2dc7cbcab64404b",
      url: "https://github.com/hashencode/voice-studio-models/releases/download/models-v1/formal-transcription-qwen3-asr-0.6b-int8-2026-03-25-darwin-arm64.tar.gz",
      allowedOrigins: [
        "https://github.com",
        "https://release-assets.githubusercontent.com",
      ],
      archiveBytes: 849_404_180,
      archiveSha256:
        "674908c4b847caabd25a011aa457c280ed1e872b88c8234aa2dc7cbcab64404b",
      distributionEligible: true,
    },
    inventory: [
      {
        path: "asr/conv_frontend.onnx",
        bytes: 44_148_281,
        sha256:
          "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
      },
      {
        path: "asr/decoder.int8.onnx",
        bytes: 755_914_231,
        sha256:
          "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
      },
      {
        path: "asr/encoder.int8.onnx",
        bytes: 182_491_662,
        sha256:
          "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
      },
      {
        path: "asr/tokenizer/merges.txt",
        bytes: 1_671_853,
        sha256:
          "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
      },
      {
        path: "asr/tokenizer/tokenizer_config.json",
        bytes: 12_487,
        sha256:
          "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
      },
      {
        path: "asr/tokenizer/vocab.json",
        bytes: 2_776_833,
        sha256:
          "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
      },
      {
        path: "licenses/qwen3-asr-Apache-2.0.txt",
        bytes: 11_343,
        sha256:
          "a44a6081c73ad75f0255bb2bb5cab74ef1829565a895a24e53a4f11290ab7655",
      },
      {
        path: "licenses/qwen3-asr-README.md",
        bytes: 328,
        sha256:
          "bbc6dbeb9dce5b4ed0e839057137e9cba4bf05c5797277d36a80e22594414e14",
      },
    ],
  },
  {
    id: "live-caption",
    displayName: "实时字幕",
    version: "sensevoice-2024-07-17-int8",
    distributionEligible: true,
    developmentOnly: false,
    licenseComplete: true,
    target: "darwin-arm64",
    runtimeProtocol: "desktop-sherpa-worker/v1",
    download: {
      bundleId: "live-caption",
      catalogIdentity:
        "2cb16bb88adee12e4aaf54c76359a3a3e6c0e1fd0a59eb52caa38b9007ece912",
      url: "https://github.com/hashencode/voice-studio-models/releases/download/models-v1/live-caption-sensevoice-2024-07-17-int8-darwin-arm64.tar.gz",
      allowedOrigins: [
        "https://github.com",
        "https://release-assets.githubusercontent.com",
      ],
      archiveBytes: 164_107_250,
      archiveSha256:
        "2cb16bb88adee12e4aaf54c76359a3a3e6c0e1fd0a59eb52caa38b9007ece912",
      distributionEligible: true,
    },
    inventory: [
      {
        path: "licenses/sensevoice-conversion-LICENSE",
        bytes: 71,
        sha256:
          "221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17",
      },
      {
        path: "licenses/sensevoice-conversion-README.md",
        bytes: 104,
        sha256:
          "763991a00edaea534ab36bf1b7cf89e61e911666dcfabbba71f91f9f7c593a63",
      },
      {
        path: "licenses/sensevoice-FunASR-model-license-v1.1.txt",
        bytes: 5_306,
        sha256:
          "7dba975a2069691db4992b0592d70828b330d2f8a30a71450f4e152a554e84f8",
      },
      {
        path: "model.int8.onnx",
        bytes: 239_233_841,
        sha256:
          "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
      },
      {
        path: "tokens.txt",
        bytes: 315_894,
        sha256:
          "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
      },
    ],
  },
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
