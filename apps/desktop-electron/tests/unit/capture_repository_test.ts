import { describe, expect, it } from "vitest";

import type { CaptureAuthority } from "../../src/main/domain/capture/capture_authority";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { CaptureRepository } from "../../src/main/storage/repositories/capture_repository";
import type { CaptureSnapshot } from "../../src/shared/contracts";

describe("CaptureRepository recovery marker repair", () => {
  it.each(["recoverable", "failed"] as const)(
    "repairs a proven-invalid historical %s marker without changing journal identity",
    (state) => {
      const database = openAudioDatabase(":memory:");
      const repository = new CaptureRepository(database);
      const sessionId = `session-repair-${state}-123456`;
      const journalSha256 = "b".repeat(64);
      try {
        begin(repository, sessionId);
        database
          .prepare(
            `UPDATE capture_sessions
             SET state = ?, recording_sha256 = ?, journal_sha256 = ?
             WHERE session_id = ?`,
          )
          .run(state, "a".repeat(64), journalSha256, sessionId);

        repository.saveSnapshotAndReceipt(
          snapshot({ sessionId, state, journalSha256 }),
          "recover",
          `repair-${state}`,
          2_000,
          authority(sessionId, state),
        );

        expect(repository.find(sessionId)).toMatchObject({
          state,
          recordingSha256: null,
          journalSha256,
        });
        expect(repository.listRecoveryCandidates()).toEqual([
          expect.objectContaining({
            snapshot: expect.objectContaining({ sessionId, journalSha256 }),
            workspacePath: `/tmp/${sessionId}`,
          }),
        ]);
        expect(repository.recoveryMarkerRepairDiagnostics()).toEqual({
          repaired: 1,
          unchanged: 0,
        });

        repository.saveSnapshotAndReceipt(
          snapshot({ sessionId, state, journalSha256 }),
          "recover",
          `repair-${state}-again`,
          3_000,
          authority(sessionId, state),
        );
        expect(repository.find(sessionId)?.recordingSha256).toBeNull();
        expect(repository.recoveryMarkerRepairDiagnostics()).toEqual({
          repaired: 1,
          unchanged: 1,
        });
      } finally {
        database.close();
      }
    },
  );

  it("leaves valid committed and unknown historical combinations unchanged", () => {
    const database = openAudioDatabase(":memory:");
    const repository = new CaptureRepository(database);
    const validSessionId = "session-valid-stop-123456";
    const unknownSessionId = "session-unknown-repair-123456";
    const journalSha256 = "c".repeat(64);
    try {
      begin(repository, validSessionId);
      repository.saveSnapshotAndReceipt(
        snapshot({
          sessionId: validSessionId,
          state: "completed",
          recordingSha256: journalSha256,
          journalSha256,
        }),
        "stop",
        "valid-stop",
        2_000,
        authority(validSessionId, "completed"),
      );
      database
        .prepare(
          "UPDATE capture_sessions SET state = 'recoverable' WHERE session_id = ?",
        )
        .run(validSessionId);
      repository.saveSnapshotAndReceipt(
        snapshot({
          sessionId: validSessionId,
          state: "recoverable",
          journalSha256,
        }),
        "recover",
        "recover-after-valid-stop",
        3_000,
        authority(validSessionId, "recoverable"),
      );

      begin(repository, unknownSessionId);
      database
        .prepare(
          `UPDATE capture_sessions
           SET state = 'recoverable', recording_sha256 = ?, journal_sha256 = ?
           WHERE session_id = ?`,
        )
        .run("d".repeat(64), journalSha256, unknownSessionId);
      repository.saveSnapshotAndReceipt(
        snapshot({
          sessionId: unknownSessionId,
          state: "recoverable",
          journalSha256,
        }),
        "recover",
        "recover-without-validated-authority",
        4_000,
      );

      expect(repository.find(validSessionId)?.recordingSha256).toBe(
        journalSha256,
      );
      expect(repository.find(unknownSessionId)?.recordingSha256).toBe(
        "d".repeat(64),
      );
      expect(repository.listRecoveryCandidates()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function begin(repository: CaptureRepository, sessionId: string): void {
  repository.beginSession({
    sessionId,
    title: "Recovery marker fixture",
    workspacePath: `/tmp/${sessionId}`,
    nowMs: 1_000,
  });
}

function snapshot(
  overrides: Partial<CaptureSnapshot> & Pick<CaptureSnapshot, "sessionId">,
): CaptureSnapshot {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    state: "recoverable",
    captureMode: "microphone_only",
    captureTimelineMs: 1_000,
    systemAudioHealthy: false,
    microphoneHealthy: false,
    partialCapture: true,
    finalizedChunkCount: 1,
    eventCount: 0,
    gapCount: 0,
    interruptionReason: "unexpected_exit",
    recordingSha256: null,
    journalSha256: "b".repeat(64),
    ...rest,
  };
}

function authority(
  sessionId: string,
  state: "completed" | "recoverable" | "failed",
): CaptureAuthority {
  return {
    schema: "desktop-capture-session/v1",
    sessionId,
    captureMode: "microphone_only",
    state: state === "failed" ? "recoverable" : state,
    tracks: [
      {
        kind: "microphone",
        healthy: false,
        sampleRate: 48_000,
        channels: 1,
        format: "float32",
      },
    ],
    chunks: [
      {
        track: "microphone",
        sequence: 0,
        startMs: 0,
        endMs: 1_000,
        relativePath: "microphone/chunk-000000.caf",
        bytes: 4,
        sha256: "e".repeat(64),
        finalized: true,
      },
    ],
    events: [],
  };
}
