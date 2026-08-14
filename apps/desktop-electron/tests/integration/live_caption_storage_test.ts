import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openElectronDatabase } from "../../src/main/storage/database";
import { TranscriptRepository } from "../../src/main/storage/repositories/transcript_repository";

const sessionId = "session-caption-storage-123456";
const modelSha256 = "a".repeat(64);
const resourceIdentity = "b".repeat(64);
const runtimeSha256 = "c".repeat(64);

describe("live caption storage", () => {
  const database = openElectronDatabase(":memory:");

  beforeEach(() => {
    database.exec("DELETE FROM capture_sessions");
    database
      .prepare(
        `INSERT INTO capture_sessions (
          session_id, title, workspace_path, state, capture_mode,
          created_at_ms, updated_at_ms
        ) VALUES (?, 'Caption test', ?, 'recording', 'dual_track', 1000, 1000)`,
      )
      .run(sessionId, `/tmp/${sessionId}`);
  });

  afterEach(() => {
    database.exec("DELETE FROM capture_sessions");
  });

  it("persists one durable draft generation and resumes with a fenced new attempt", () => {
    const repository = new TranscriptRepository(database);
    const created = repository.createOrResumeDraft({
      sessionId,
      modelSha256,
      resourceIdentity,
      runtimeSha256,
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      nowMs: 1_100,
    });
    const replayed = repository.createOrResumeDraft({
      sessionId,
      modelSha256,
      resourceIdentity,
      runtimeSha256,
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      nowMs: 1_200,
    });

    expect(replayed.generationId).toBe(created.generationId);
    expect(replayed.attempt).toBe(created.attempt);
    expect(
      repository.beginWorkerAttempt(sessionId, created.generationId, 1_300),
    ).toEqual(expect.objectContaining({ attempt: created.attempt + 1 }));
  });

  it("accepts exact utterance replay but rejects late attempts and conflicting sequence reuse", () => {
    const repository = new TranscriptRepository(database);
    const draft = repository.createOrResumeDraft({
      sessionId,
      modelSha256,
      resourceIdentity,
      runtimeSha256,
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      nowMs: 1_100,
    });
    const utterance = {
      sessionId,
      generationId: draft.generationId,
      attempt: draft.attempt,
      sequence: 1,
      startMs: 0,
      endMs: 900,
      text: "仅持久化完整话语。",
      language: "zh",
      workerOffsetBytes: 32_000,
      modelSha256,
      nowMs: 1_200,
    };

    repository.appendDraftUtterance(utterance);
    repository.appendDraftUtterance(utterance);
    expect(repository.getSnapshot(sessionId)?.draft?.utterances).toHaveLength(
      1,
    );
    expect(() =>
      repository.appendDraftUtterance({
        ...utterance,
        text: "同一序号不得换内容。",
      }),
    ).toThrow(/conflict/i);

    repository.beginWorkerAttempt(sessionId, draft.generationId, 1_300);
    expect(() =>
      repository.appendDraftUtterance({ ...utterance, sequence: 2 }),
    ).toThrow(/attempt/i);
  });

  it("returns only the bounded recent window and marks earlier durable utterances", () => {
    const repository = new TranscriptRepository(database);
    const draft = repository.createOrResumeDraft({
      sessionId,
      modelSha256,
      resourceIdentity,
      runtimeSha256,
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      nowMs: 1_100,
    });
    for (let sequence = 1; sequence <= 129; sequence += 1) {
      repository.appendDraftUtterance({
        sessionId,
        generationId: draft.generationId,
        attempt: draft.attempt,
        sequence,
        startMs: sequence * 100,
        endMs: sequence * 100 + 50,
        text: `utterance ${sequence}`,
        language: "en",
        workerOffsetBytes: (sequence + 1) * 3_200,
        modelSha256,
        nowMs: 1_100 + sequence,
      });
    }

    const snapshot = repository.getSnapshot(sessionId);
    expect(snapshot?.draft?.utterances).toHaveLength(128);
    expect(snapshot?.draft?.utterances[0]?.sequence).toBe(2);
    expect(snapshot?.draft?.hasEarlierUtterances).toBe(true);
  });

  it("persists a blank recognition sequence and offset without a visible utterance", () => {
    const repository = new TranscriptRepository(database);
    const draft = repository.createOrResumeDraft({
      sessionId,
      modelSha256,
      resourceIdentity,
      runtimeSha256,
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      nowMs: 1_100,
    });
    const silence = {
      sessionId,
      generationId: draft.generationId,
      attempt: draft.attempt,
      sequence: 1,
      startMs: 0,
      endMs: 100,
      workerOffsetBytes: 3_200,
      modelSha256,
      nowMs: 1_200,
    };

    expect(() =>
      repository.advanceDraftSilence({
        ...silence,
        modelSha256: "0".repeat(64),
      }),
    ).toThrow(/model/i);
    repository.advanceDraftSilence(silence);
    const resumed = repository.createOrResumeDraft({
      sessionId,
      modelSha256,
      resourceIdentity,
      runtimeSha256,
      protocolIdentity: "sensevoice-live-caption-worker/v1",
      nowMs: 1_300,
    });

    expect(resumed).toEqual(
      expect.objectContaining({ offsetBytes: 3_200, firstSequence: 2 }),
    );
    expect(repository.getSnapshot(sessionId)?.draft?.utterances).toEqual([]);
    repository.appendDraftUtterance({
      sessionId,
      generationId: draft.generationId,
      attempt: draft.attempt,
      sequence: 2,
      startMs: 100,
      endMs: 150,
      text: "可见内容",
      language: "zh",
      workerOffsetBytes: 6_400,
      modelSha256,
      nowMs: 1_400,
    });
    expect(repository.getSnapshot(sessionId)?.draft?.utterances).toEqual([
      expect.objectContaining({ sequence: 2, text: "可见内容" }),
    ]);
  });
});
