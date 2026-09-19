import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildNormalizedModelArchive } from "../../scripts/build-model-release-assets";

import type { AppModelCatalogEntry } from "../../src/main/resources/local_model_service";
import {
  productionModelCatalog,
  validateProductionModelCatalog,
} from "../../src/main/resources/production_model_catalog";
import { extractTrustedModelArchive } from "../../src/main/resources/model_archive_extractor";
import { TarGzipModelArchiveAdapter } from "../../src/main/resources/tar_gzip_model_archive_adapter";

const SHA256 = createHash("sha256").update("fixture").digest("hex");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function eligibleEntry(
  overrides: Partial<AppModelCatalogEntry> = {},
): AppModelCatalogEntry {
  return {
    id: "formal-transcription",
    displayName: "本地转写",
    version: "fixture-v1",
    distributionEligible: true,
    developmentOnly: false,
    licenseComplete: true,
    target: "darwin-arm64",
    runtimeProtocol: "desktop-sherpa-worker/v1",
    download: {
      bundleId: "formal-transcription",
      catalogIdentity: SHA256,
      url: "https://github.com/hashencode/voice-studio-models/releases/download/fixture-v1/qwen3-asr.tar.gz",
      allowedOrigins: [
        "https://github.com",
        "https://objects.githubusercontent.com",
      ],
      archiveBytes: 7,
      archiveSha256: SHA256,
      distributionEligible: true,
    },
    inventory: [{ path: "model.bin", bytes: 7, sha256: SHA256 }],
    ...overrides,
  };
}

describe("production model distribution catalog", () => {
  it("builds a deterministic normalized archive from only declared members", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-release-builder-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    mkdirSync(join(sourceRoot, "tokenizer"), { recursive: true });
    writeFileSync(join(sourceRoot, "model.bin"), "model");
    writeFileSync(join(sourceRoot, "tokenizer/tokens.txt"), "tokens");
    writeFileSync(join(sourceRoot, "undeclared.txt"), "exclude me");
    const member = (source: string, path: string, contents: string) => ({
      source,
      path,
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
    const spec = {
      schemaVersion: 1 as const,
      bundleId: "formal-transcription" as const,
      version: "fixture-v1",
      target: "darwin-arm64" as const,
      runtimeProtocol: "desktop-sherpa-worker/v1",
      sourceRoot,
      members: [
        member("model.bin", "model.bin", "model"),
        member("tokenizer/tokens.txt", "tokenizer/tokens.txt", "tokens"),
      ],
    };

    const first = await buildNormalizedModelArchive(spec, join(root, "one"));
    const second = await buildNormalizedModelArchive(spec, join(root, "two"));

    expect(first.archiveSha256).toBe(second.archiveSha256);
    expect(first.archiveBytes).toBe(second.archiveBytes);
    expect(first.inventory.map((item) => item.path)).toEqual([
      "model.bin",
      "tokenizer/tokens.txt",
    ]);
    await extractTrustedModelArchive({
      archivePath: first.archivePath,
      stagingRoot: join(root, "extracted"),
      adapter: new TarGzipModelArchiveAdapter(),
      inventory: first.inventory,
    });
  });

  it("authorizes the two immutable production release assets", () => {
    expect(() =>
      validateProductionModelCatalog(productionModelCatalog),
    ).not.toThrow();
    expect(productionModelCatalog.map((entry) => entry.id)).toEqual([
      "formal-transcription",
      "live-caption",
    ]);
    expect(
      productionModelCatalog.map((entry) => ({
        id: entry.id,
        url: entry.download?.url,
        archiveBytes: entry.download?.archiveBytes,
        archiveSha256: entry.download?.archiveSha256,
        catalogIdentity: entry.download?.catalogIdentity,
        inventorySha256: createHash("sha256")
          .update(JSON.stringify(entry.inventory))
          .digest("hex"),
      })),
    ).toEqual([
      {
        id: "formal-transcription",
        url: "https://github.com/hashencode/voice-studio-models/releases/download/models-v1/formal-transcription-qwen3-asr-0.6b-int8-2026-03-25-darwin-arm64.tar.gz",
        archiveBytes: 849_404_180,
        archiveSha256:
          "674908c4b847caabd25a011aa457c280ed1e872b88c8234aa2dc7cbcab64404b",
        catalogIdentity:
          "674908c4b847caabd25a011aa457c280ed1e872b88c8234aa2dc7cbcab64404b",
        inventorySha256:
          "120b4eaa4f62d9f5be7e53e75d21f04bb819bc4aca789e2417a15d05518ecbc1",
      },
      {
        id: "live-caption",
        url: "https://github.com/hashencode/voice-studio-models/releases/download/models-v1/live-caption-sensevoice-2024-07-17-int8-darwin-arm64.tar.gz",
        archiveBytes: 164_107_250,
        archiveSha256:
          "2cb16bb88adee12e4aaf54c76359a3a3e6c0e1fd0a59eb52caa38b9007ece912",
        catalogIdentity:
          "2cb16bb88adee12e4aaf54c76359a3a3e6c0e1fd0a59eb52caa38b9007ece912",
        inventorySha256:
          "5ab3887582180df629733f35f86929eeab297477df5d3464272caf9f88aeae73",
      },
    ]);
    expect(
      productionModelCatalog.every(
        (entry) =>
          entry.distributionEligible &&
          !entry.developmentOnly &&
          entry.licenseComplete &&
          entry.download?.distributionEligible === true &&
          entry.download.allowedOrigins.includes(
            "https://release-assets.githubusercontent.com",
          ),
      ),
    ).toBe(true);
  });

  it("passes explicit model distribution admission for the immutable release", () => {
    const result = spawnSync(
      "bun",
      ["scripts/validate-model-distribution.ts", "--release"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      bundleCount: 2,
      productionDownloadsOpen: true,
    });
  });

  it("accepts an exact eligible GitHub Release fixture", () => {
    expect(() =>
      validateProductionModelCatalog([
        eligibleEntry(),
        eligibleEntry({
          id: "live-caption",
          displayName: "实时字幕",
          download: {
            ...eligibleEntry().download!,
            bundleId: "live-caption",
            url: "https://github.com/hashencode/voice-studio-models/releases/download/fixture-v1/sensevoice.tar.gz",
          },
        }),
      ]),
    ).not.toThrow();
  });

  it.each([
    ["license", { licenseComplete: false }, /license evidence/],
    ["development posture", { developmentOnly: true }, /development-only/],
    ["download", { download: null }, /download metadata/],
    ["inventory", { inventory: [] }, /inventory/],
  ] as const)(
    "rejects eligible entries with missing %s evidence",
    (_, patch, error) => {
      const entry = eligibleEntry(patch as Partial<AppModelCatalogEntry>);
      expect(() =>
        validateProductionModelCatalog([
          entry,
          eligibleEntry({
            id: "live-caption",
            displayName: "实时字幕",
            download: {
              ...eligibleEntry().download!,
              bundleId: "live-caption",
              url: "https://github.com/hashencode/voice-studio-models/releases/download/fixture-v1/sensevoice.tar.gz",
            },
          }),
        ]),
      ).toThrow(error);
    },
  );

  it.each([
    [
      "private repository",
      "https://github.com/hashencode/voice-studio/releases/download/v1/model.tar.gz",
    ],
    [
      "upstream repository",
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/model.tar.gz",
    ],
    [
      "unversioned asset",
      "https://github.com/hashencode/voice-studio-models/releases/latest/download/model.tar.gz",
    ],
    [
      "embedded credentials",
      "https://token@github.com/hashencode/voice-studio-models/releases/download/v1/model.tar.gz",
    ],
  ])("rejects a %s URL", (_, url) => {
    const entry = eligibleEntry({
      download: { ...eligibleEntry().download!, url },
    });
    expect(() =>
      validateProductionModelCatalog([
        entry,
        eligibleEntry({
          id: "live-caption",
          displayName: "实时字幕",
          download: {
            ...eligibleEntry().download!,
            bundleId: "live-caption",
            url: "https://github.com/hashencode/voice-studio-models/releases/download/fixture-v1/sensevoice.tar.gz",
          },
        }),
      ]),
    ).toThrow(/GitHub Release URL/);
  });

  it("rejects malformed archive and inventory identities", () => {
    expect(() =>
      validateProductionModelCatalog([
        eligibleEntry({
          download: {
            ...eligibleEntry().download!,
            archiveBytes: 0,
            archiveSha256: "bad",
          },
        }),
        eligibleEntry({
          id: "live-caption",
          displayName: "实时字幕",
          download: {
            ...eligibleEntry().download!,
            bundleId: "live-caption",
            url: "https://github.com/hashencode/voice-studio-models/releases/download/fixture-v1/sensevoice.tar.gz",
          },
        }),
      ]),
    ).toThrow(/archive identity/);
    expect(() =>
      validateProductionModelCatalog([
        eligibleEntry({
          inventory: [{ path: "../escape", bytes: 7, sha256: SHA256 }],
        }),
        eligibleEntry({
          id: "live-caption",
          displayName: "实时字幕",
          download: {
            ...eligibleEntry().download!,
            bundleId: "live-caption",
            url: "https://github.com/hashencode/voice-studio-models/releases/download/fixture-v1/sensevoice.tar.gz",
          },
        }),
      ]),
    ).toThrow(/inventory/);
  });
});
