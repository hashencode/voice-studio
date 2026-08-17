import { describe, expect, it } from "vitest";

import {
  capturePreflightAllowsStart,
  hasVerifiedLiveCaptionCapability,
} from "../../src/main/domain/capture/capture_capability";

describe("live caption capability", () => {
  it("does not treat a worker catalog without a caption operation as available", () => {
    const operations = new Set(["worker-health", "asr", "diarization"]);
    expect(
      hasVerifiedLiveCaptionCapability({
        processingIdentity(operationId) {
          return operations.has(operationId) ? {} : null;
        },
      }),
    ).toBe(false);
  });

  it("is available only when the verified catalog declares live-caption", () => {
    expect(
      hasVerifiedLiveCaptionCapability({
        processingIdentity(operationId) {
          return operationId === "live-caption" ? {} : null;
        },
      }),
    ).toBe(true);
  });

  it("blocks a caption-enabled start until the verified model is available", () => {
    const degraded = { canStart: true, captionModelAvailable: false };
    expect(capturePreflightAllowsStart(degraded, true)).toBe(false);
    expect(capturePreflightAllowsStart(degraded, false)).toBe(true);
    expect(
      capturePreflightAllowsStart(
        { canStart: true, captionModelAvailable: true },
        true,
      ),
    ).toBe(true);
  });
});
