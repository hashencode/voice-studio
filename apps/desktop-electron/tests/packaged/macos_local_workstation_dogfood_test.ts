import { describe, expect, it } from "vitest";

import { runPackagedLocalWorkstationSmoke } from "../../scripts/smoke-packaged-processing-macos";

const packagedWorkstationIt =
  process.env.RUN_PACKAGED_WORKSTATION === "1" ? it : it.skip;

describe.skipIf(process.platform !== "darwin")(
  "packaged macOS local audio workstation",
  () => {
    packagedWorkstationIt(
      "reviews, edits, searches, controls audio and exports through packaged Main authority",
      async () => {
        const evidence = await runPackagedLocalWorkstationSmoke();

        expect(evidence.packaged).toBe(true);
        expect(evidence.segmentCount).toBeGreaterThan(0);
        expect(evidence.manualRevisionSurvivedRetry).toBe(true);
        expect(evidence.productionRetryCompleted).toBe(true);
        expect(evidence.productionCancelCompleted).toBe(true);
        expect(evidence.retryTerminal).toEqual({
          state: "completed",
          attempt: expect.any(Number),
        });
        expect(evidence.retryTerminal.attempt).toBeGreaterThanOrEqual(2);
        expect(evidence.cancelTerminal).toEqual({
          state: "canceled",
          attempt: expect.any(Number),
        });
        expect(evidence.cancelTerminal.attempt).toBeGreaterThanOrEqual(1);
        expect(evidence.searchResultCount).toBeGreaterThan(0);
        expect(evidence.playback).toEqual(
          expect.objectContaining({
            initialized: true,
            positionMs: 500,
            speed: 1.5,
            pathRedacted: true,
          }),
        );
        expect(evidence.exported.map((entry) => entry.format)).toEqual([
          "txt",
          "md",
          "vtt",
          "srt",
          "json",
        ]);
        expect(evidence.exported.every((entry) => entry.bytes > 0)).toBe(true);
        expect(evidence.rendererBoundary).toBe(
          "typed-preload-opaque-identifiers-only",
        );
        expect(evidence.rendererDomReady).toBe(true);
        expect(evidence.rendererPreloadDriven).toBe(true);
        expect(evidence.sidebarTasksDriven).toBe(true);
        expect(evidence.importProgressObserved).toBe(true);
        expect(evidence.operationStates).toEqual(
          expect.arrayContaining(["queued", "running"]),
        );
      },
      20 * 60 * 1_000,
    );
  },
);
