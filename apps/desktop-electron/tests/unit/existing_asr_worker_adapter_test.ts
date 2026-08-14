import { expect, it } from "vitest";

import type { ExecutionIntent } from "../../src/main/domain/models";
import {
  adaptExistingAsrWorkerFrame,
  finalizeExistingSherpaResult,
} from "../../src/main/processes/existing_asr_worker_adapter";

const intent: ExecutionIntent = {
  jobId: 1,
  meetingId: 2,
  operationId: "asr",
  attempt: 3,
  sourceIdentity: "worker-process-9",
  deadlineAtMs: Date.now() + 10_000,
  resourceIdentity: "b".repeat(64),
  phase: "asr",
  protocolIdentity: "desktop-sherpa-worker/v1",
  sourceSha256: "a".repeat(64),
  modelSha256: "c".repeat(64),
  runtimeSha256: "d".repeat(64),
};

it("adapts existing worker frames without rewriting compute and stamps the supervised fence", () => {
  expect(
    adaptExistingAsrWorkerFrame(
      { schemaVersion: 1, type: "progress", phase: "asr", fraction: 0.5 },
      intent,
    ),
  ).toEqual(
    expect.objectContaining({
      type: "progress",
      operationId: intent.operationId,
      attempt: 3,
      protocolIdentity: intent.protocolIdentity,
      sourceSha256: intent.sourceSha256,
      modelSha256: intent.modelSha256,
      runtimeSha256: intent.runtimeSha256,
    }),
  );
  expect(
    adaptExistingAsrWorkerFrame(
      {
        schemaVersion: 1,
        type: "result",
        phase: "asr",
        sourceSha256: intent.sourceSha256,
        text: "真实 worker 文本",
      },
      intent,
    ),
  ).toEqual(
    expect.objectContaining({
      type: "result",
      payload: expect.objectContaining({ text: "真实 worker 文本" }),
    }),
  );
});

it("rejects wrong source and phase before publication", () => {
  expect(() =>
    adaptExistingAsrWorkerFrame(
      {
        schemaVersion: 1,
        type: "result",
        phase: "asr",
        sourceSha256: "e".repeat(64),
      },
      intent,
    ),
  ).toThrow("source hash");
  expect(() =>
    adaptExistingAsrWorkerFrame(
      {
        schemaVersion: 1,
        type: "progress",
        phase: "diarization",
        fraction: 0.1,
      },
      intent,
    ),
  ).toThrow("phase");
});

it("merges ASR and diarization only into a bounded final payload", () => {
  expect(
    finalizeExistingSherpaResult(
      {
        text: "hello world",
        asrResultVersion: 2,
        segments: ["hello", "world"],
        segmentStartSeconds: [0, 1],
        durationSeconds: 2,
        residentBytes: 100,
      },
      {
        turns: [
          { startSeconds: 0, endSeconds: 1, speakerKey: "speaker_01" },
          { startSeconds: 1, endSeconds: 2, speakerKey: "speaker_02" },
        ],
        residentBytes: 200,
      },
    ),
  ).toEqual(
    expect.objectContaining({
      engineId: "sherpa-onnx-1.13.4/qwen3-asr-0.6b-int8-pyannote3",
      diarizationSucceeded: true,
      diarizationErrorCode: null,
      peakResidentBytes: 200,
      segments: [
        expect.objectContaining({
          text: "hello",
          speakerAssignment: "anonymous",
          anonymousSpeakerKey: "speaker_01",
        }),
        expect.objectContaining({
          text: "world",
          speakerAssignment: "anonymous",
          anonymousSpeakerKey: "speaker_02",
        }),
      ],
    }),
  );
});

it("degrades a non-terminal diarization failure without inventing speakers", () => {
  expect(
    finalizeExistingSherpaResult(
      {
        text: "hello",
        asrResultVersion: 2,
        segments: ["hello"],
        segmentStartSeconds: [0],
        durationSeconds: 1,
      },
      null,
      "DIARIZATION_FAILED",
    ),
  ).toEqual(
    expect.objectContaining({
      diarizationSucceeded: false,
      diarizationErrorCode: "DIARIZATION_FAILED",
      segments: [
        expect.objectContaining({
          speakerAssignment: "unknown",
          anonymousSpeakerKey: null,
        }),
      ],
    }),
  );
});

it("rejects ASR timestamps at or beyond the media duration", () => {
  expect(() =>
    finalizeExistingSherpaResult(
      {
        text: "late",
        asrResultVersion: 2,
        segments: ["late"],
        segmentStartSeconds: [1],
        durationSeconds: 1,
      },
      { turns: [] },
    ),
  ).toThrow(/timestamp/i);
});

it.each([
  { startSeconds: 0.5, endSeconds: 0.5 },
  { startSeconds: 0.75, endSeconds: 0.5 },
  { startSeconds: 0.5, endSeconds: 1.01 },
])("rejects malformed diarization turn $startSeconds-$endSeconds", (turn) => {
  expect(() =>
    finalizeExistingSherpaResult(
      {
        text: "hello",
        asrResultVersion: 2,
        segments: ["hello"],
        segmentStartSeconds: [0],
        durationSeconds: 1,
      },
      { turns: [{ ...turn, speakerKey: "speaker_01" }] },
    ),
  ).toThrow(/diarization turn/i);
});
