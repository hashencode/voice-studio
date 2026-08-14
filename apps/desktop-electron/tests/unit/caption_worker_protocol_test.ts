import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  adaptCaptionWorkerEvent,
  captionWorkerRequestSchema,
  type CaptionWorkerFence,
} from "../../src/main/processes/caption_worker_protocol";

const fence: CaptionWorkerFence = {
  sessionId: "session-caption-protocol-123456",
  generationId: 7,
  attempt: 2,
  modelSha256: "a".repeat(64),
};

describe("SenseVoice live-caption protocol", () => {
  it("allows only the versioned session command vocabulary and contained spool reference", () => {
    expect(
      captionWorkerRequestSchema.parse({
        schemaVersion: 1,
        type: "openSession",
        sessionId: fence.sessionId,
        generationId: fence.generationId,
        spoolRelativePath: "caption/live-caption.pcmspool",
        offsetBytes: 0,
        firstSequence: 1,
      }),
    ).toBeTruthy();
    expect(() =>
      captionWorkerRequestSchema.parse({
        schemaVersion: 1,
        type: "openSession",
        sessionId: fence.sessionId,
        generationId: fence.generationId,
        spoolRelativePath: "../../outside.pcm",
        offsetBytes: 0,
        firstSequence: 1,
      }),
    ).toThrow();
    expect(() =>
      captionWorkerRequestSchema.parse({ schemaVersion: 1, type: "exec" }),
    ).toThrow();
  });

  it("adapts completed utterances and stamps the supervisor attempt fence", () => {
    expect(
      adaptCaptionWorkerEvent(
        {
          schemaVersion: 1,
          type: "utterance",
          sessionId: fence.sessionId,
          generationId: fence.generationId,
          sequence: 3,
          startSeconds: 1.25,
          endSeconds: 2.5,
          text: "完整话语",
          textSha256: createHash("sha256").update("完整话语").digest("hex"),
          language: "zh",
          event: "",
          offsetBytes: 96_000,
          modelSha256: fence.modelSha256,
          residentBytes: 10_000,
        },
        fence,
      ),
    ).toEqual(
      expect.objectContaining({
        type: "utterance",
        attempt: 2,
        sequence: 3,
        startMs: 1_250,
        endMs: 2_500,
      }),
    );
  });

  it("classifies a fully fenced blank recognition as non-content silence", () => {
    const blank = {
      schemaVersion: 1,
      type: "utterance",
      sessionId: fence.sessionId,
      generationId: fence.generationId,
      sequence: 1,
      startSeconds: 0,
      endSeconds: 0.1,
      text: "",
      textSha256: createHash("sha256").update("").digest("hex"),
      language: "zh",
      event: "",
      offsetBytes: 3_200,
      modelSha256: fence.modelSha256,
      residentBytes: 10_000,
    };

    expect(adaptCaptionWorkerEvent(blank, fence)).toEqual({
      type: "silence",
      sessionId: fence.sessionId,
      generationId: fence.generationId,
      attempt: fence.attempt,
      sequence: 1,
      startMs: 0,
      endMs: 100,
      offsetBytes: 3_200,
      modelSha256: fence.modelSha256,
    });
    expect(() =>
      adaptCaptionWorkerEvent({ ...blank, textSha256: "0".repeat(64) }, fence),
    ).toThrow(/hash/i);
    expect(() =>
      adaptCaptionWorkerEvent(
        { ...blank, generationId: fence.generationId + 1 },
        fence,
      ),
    ).toThrow(/generation/i);
    expect(() =>
      adaptCaptionWorkerEvent({ ...blank, modelSha256: "0".repeat(64) }, fence),
    ).toThrow(/model/i);
    expect(() =>
      adaptCaptionWorkerEvent({ ...blank, endSeconds: 0.101 }, fence),
    ).toThrow(/timing/i);
  });

  it("rejects a late generation, wrong model, oversized text, and partial-frame offset", () => {
    const event = {
      schemaVersion: 1,
      type: "utterance",
      sessionId: fence.sessionId,
      generationId: fence.generationId,
      sequence: 1,
      startSeconds: 0,
      endSeconds: 0.5,
      text: "ok",
      textSha256: createHash("sha256").update("ok").digest("hex"),
      language: "zh",
      event: "",
      offsetBytes: 3_200,
      modelSha256: fence.modelSha256,
      residentBytes: 10_000,
    };
    expect(() =>
      adaptCaptionWorkerEvent(
        { ...event, generationId: fence.generationId - 1 },
        fence,
      ),
    ).toThrow(/generation/i);
    expect(() =>
      adaptCaptionWorkerEvent({ ...event, modelSha256: "c".repeat(64) }, fence),
    ).toThrow(/model/i);
    expect(() =>
      adaptCaptionWorkerEvent({ ...event, text: "x".repeat(4_001) }, fence),
    ).toThrow(/text/i);
    expect(() =>
      adaptCaptionWorkerEvent({ ...event, offsetBytes: 3_199 }, fence),
    ).toThrow(/offset/i);
  });

  it("requires the verified model fence on sessionReady", () => {
    const ready = {
      schemaVersion: 1,
      type: "sessionReady",
      sessionId: fence.sessionId,
      generationId: fence.generationId,
      offsetBytes: 0,
      nextSequence: 1,
      backlogBytes: 0,
    };
    expect(() => adaptCaptionWorkerEvent(ready, fence)).toThrow();
    expect(
      adaptCaptionWorkerEvent(
        { ...ready, modelSha256: fence.modelSha256 },
        fence,
      ),
    ).toEqual(expect.objectContaining({ type: "sessionReady" }));
  });
});
