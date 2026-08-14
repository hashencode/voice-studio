import { describe, expect, it } from "vitest";

import {
  buildProcessingSmokeEvidence,
  parseProcessingSmokeReferenceBindings,
} from "../../src/main/application/processing_smoke_evidence";

const referenceBindings = {
  dartSources: [
    {
      path: "packages/desktop_sherpa_worker/lib/src/engine.dart",
      sha256: "a".repeat(64),
    },
  ],
  fixtureSha256: "b".repeat(64),
};

function evidence(
  elapsedMilliseconds: number,
  text = "hello",
  manifestSha256 = "c".repeat(64),
) {
  return buildProcessingSmokeEvidence({
    referenceBindings,
    resource: {
      manifestSha256,
      modelSha256: "d".repeat(64),
      runtimeSha256: "e".repeat(64),
    },
    media: {
      sourceSha256: "f".repeat(64),
      normalizedSha256: "0".repeat(64),
      normalizedSizeBytes: 12,
      durationMs: 34,
    },
    databaseProjection: {
      job: { state: "completed", phase: "diarization" },
      publication: { operationId: "diarization" },
    },
    resultPayload: {
      elapsedMilliseconds,
      peakResidentBytes: elapsedMilliseconds * 2,
      segments: [{ startMs: 0, endMs: 1, text }],
    },
    state: "completed",
    phase: "diarization",
    attempt: 1,
    progressFraction: 1,
  });
}

describe("packaged processing smoke evidence", () => {
  it("canonicalizes stable fields while excluding volatile worker metrics", () => {
    const first = evidence(10);
    const second = evidence(999);

    expect(first).toEqual(second);
    expect(first.transcriptNonEmpty).toBe(true);
    expect(first.segmentCount).toBe(1);
    expect(evidence(10, "different").projectionSha256).not.toBe(
      first.projectionSha256,
    );
    expect(evidence(10, "hello", "9".repeat(64)).projectionSha256).toBe(
      first.projectionSha256,
    );
    expect(
      evidence(10, "hello", "9".repeat(64)).projection.resource.manifestSha256,
    ).toBe("9".repeat(64));
    expect(JSON.stringify(first)).not.toContain("hello");
  });

  it("accepts bounded repository-relative frozen reference bindings only", () => {
    expect(
      parseProcessingSmokeReferenceBindings(
        JSON.stringify({
          fixtureSha256: "b".repeat(64),
          dartSources: [
            { path: "z.dart", sha256: "c".repeat(64) },
            { path: "a.dart", sha256: "a".repeat(64) },
          ],
        }),
      ).dartSources.map((source) => source.path),
    ).toEqual(["a.dart", "z.dart"]);
    expect(() =>
      parseProcessingSmokeReferenceBindings(
        JSON.stringify({
          fixtureSha256: "b".repeat(64),
          dartSources: [{ path: "../escape.dart", sha256: "a".repeat(64) }],
        }),
      ),
    ).toThrow();
  });
});
