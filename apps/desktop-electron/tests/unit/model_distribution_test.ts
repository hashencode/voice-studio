import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AppModelCatalogEntry } from "../../src/main/resources/local_model_service";
import {
  productionModelCatalog,
  validateProductionModelCatalog,
} from "../../src/main/resources/production_model_catalog";

const SHA256 = createHash("sha256").update("fixture").digest("hex");

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
  it("keeps both production entries closed until release evidence exists", () => {
    expect(() =>
      validateProductionModelCatalog(productionModelCatalog),
    ).not.toThrow();
    expect(productionModelCatalog.map((entry) => entry.id)).toEqual([
      "formal-transcription",
      "live-caption",
    ]);
    expect(
      productionModelCatalog.every(
        (entry) =>
          !entry.distributionEligible &&
          !entry.developmentOnly &&
          !entry.licenseComplete &&
          entry.download === null &&
          entry.inventory.length === 0,
      ),
    ).toBe(true);
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
