import { expect, it } from "vitest";

import {
  parsePackagedCaptionFormalReceipt,
  runPackagedCaptionFormalSmoke,
  type PackagedCaptionFormalReceipt,
} from "../../scripts/smoke-packaged-caption-formal-macos";

const packagedIt =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  process.env.RUN_PACKAGED_CAPTION_FORMAL === "1"
    ? it
    : it.skip;

it("accepts bounded count/hash evidence and rejects transcript-bearing keys", () => {
  const sha = "a".repeat(64);
  const receipt: PackagedCaptionFormalReceipt = {
    schemaVersion: 1,
    packaged: true,
    sessionIdentitySha256: sha,
    draft: { state: "flushed", utteranceCount: 40, backlogBytes: 0 },
    formal: {
      generationId: 1,
      attempt: 1,
      state: "completed",
      errorCode: null,
    },
    database: {
      processingJobCount: 1,
      publicationCount: 1,
      formalAttemptCount: 1,
      processingAttempt: 1,
    },
    media: { sourceSha256: sha, outputSha256: sha, outputBytes: 3_244 },
    resource: {
      manifestSha256: sha,
      liveCaptionModelSha256: sha,
      liveCaptionRuntimeSha256: sha,
      formalModelSha256: sha,
      formalRuntimeSha256: sha,
    },
    renderer: {
      snapshotVisibleThroughPreload: true,
      retryMethodVisibleThroughPreload: true,
    },
    restart: {
      formalState: "completed",
      generationId: 1,
      snapshotVisibleThroughPreload: true,
    },
  };

  expect(parsePackagedCaptionFormalReceipt(JSON.stringify(receipt))).toEqual(
    receipt,
  );
  for (const forbidden of ["transcriptText", "utterances", "text"]) {
    expect(() =>
      parsePackagedCaptionFormalReceipt(
        JSON.stringify({ ...receipt, [forbidden]: "private content" }),
      ),
    ).toThrow(/transcript text/i);
  }
});

packagedIt(
  "runs caption draft through formal publication and restart in the packaged app",
  async () => {
    const receipt = await runPackagedCaptionFormalSmoke();
    expect(receipt).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        packaged: true,
        draft: expect.objectContaining({
          state: "flushed",
          utteranceCount: expect.any(Number),
        }),
        formal: expect.objectContaining({
          state: "completed",
          attempt: 1,
          generationId: expect.any(Number),
        }),
        database: expect.objectContaining({
          processingJobCount: 1,
          publicationCount: 1,
          formalAttemptCount: 1,
        }),
        renderer: {
          snapshotVisibleThroughPreload: true,
          retryMethodVisibleThroughPreload: true,
        },
        restart: expect.objectContaining({ formalState: "completed" }),
      }),
    );
    expect(receipt).not.toHaveProperty("transcriptText");
  },
  8 * 60_000,
);
