import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { MeetingExportService } from "../../src/main/domain/workspace/meeting_export_service";
import { MeetingWorkspaceService } from "../../src/main/domain/workspace/meeting_workspace_service";
import { MeetingPlaybackService } from "../../src/main/features/playback/meeting_playback_service";
import {
  createDesktopIpcHandlers,
  type DesktopIpcServices,
} from "../../src/main/ipc/desktop_ipc";
import { initializeElectronProfile } from "../../src/main/profile/electron_profile";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";
import { MeetingWorkspaceRepository } from "../../src/main/storage/repositories/meeting_workspace_repository";
import { createDesktopApi } from "../../src/preload/api";
import type { ApplicationSnapshot } from "../../src/shared/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("reviews a completed meeting through validated Main and Preload contracts without leaking paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice2text-u7-e2e-"));
  roots.push(root);
  const initialized = initializeElectronProfile(root);
  if (initialized.status !== "ready") throw new Error(initialized.message);
  const durable = new DesktopRepository(
    initialized.database,
    initialized.profile,
  );
  const domain = new DesktopDomainService(durable);
  const repository = new MeetingWorkspaceRepository(
    initialized.database,
    initialized.profile,
  );
  const workspace = new MeetingWorkspaceService(repository);
  const meeting = domain.createMeeting({
    idempotencyKey: "meeting:e2e",
    sourceIdentity: "source:e2e",
    displayName: "端到端周会.wav",
    mediaPath: join(
      initialized.profile.mediaDirectory,
      "private-authority.wav",
    ),
    durationMs: 2_000,
  }).value;
  const mediaBytes = Buffer.alloc(64, 9);
  writeFileSync(meeting.mediaPath, mediaBytes, { mode: 0o600 });
  const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
  const authority = initialized.database
    .prepare(
      `INSERT INTO media_authorities (
        content_sha256, normalized_path, source_sha256, size_bytes,
        duration_ms, receipt_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      mediaSha256,
      meeting.mediaPath,
      mediaSha256,
      mediaBytes.length,
      meeting.durationMs,
      Date.now(),
    );
  initialized.database
    .prepare("UPDATE meetings SET media_authority_id = ? WHERE id = ?")
    .run(Number(authority.lastInsertRowid), meeting.id);
  domain.enqueueProcessingJob({
    meetingId: meeting.id,
    idempotencyKey: "job:e2e",
    operationId: "asr",
    resourceIdentity: "resource:asr",
  });
  const asr = domain.claimNextProcessingJob({
    sourceIdentity: "worker:e2e",
    deadlineAtMs: Date.now() + 60_000,
  })!;
  const intent = domain.advanceProcessingPhase(asr, {
    operationId: "diarization",
    resourceIdentity: "resource:diarization",
    phase: "diarization",
    protocolIdentity: "desktop-sherpa-worker/v1",
    modelSha256: "d".repeat(64),
    runtimeSha256: "e".repeat(64),
  });
  domain.publishProcessingResult({
    ...intent,
    complete: true,
    payload: {
      segments: [
        {
          startSeconds: 0,
          endSeconds: 2,
          text: "确认发布。",
          speakerAssignment: "unknown",
          anonymousSpeakerKey: null,
        },
      ],
      diarizationSucceeded: false,
    },
  });

  const playbackPort = {
    open: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setSpeed: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const playback = new MeetingPlaybackService(repository, playbackPort);
  const written: string[] = [];
  const exporter = new MeetingExportService(workspace, async (request) => {
    written.push(request.contents);
    return { state: "saved", fileName: request.suggestedName };
  });
  const snapshot = applicationSnapshot();
  const services: DesktopIpcServices = {
    applicationSnapshot: () => snapshot,
    navigate: () => snapshot,
    requestBootstrapAction: async () => snapshot,
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    listProcessingTasks: vi.fn(async () => []),
    importMeeting: vi.fn(),
    preflightCapture: vi.fn(),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    listCaptureRecoveries: vi.fn(async () => []),
    actOnCaptureRecovery: vi.fn(),
    getCaptionSnapshot: vi.fn(async () => null),
    retryFormalTranscript: vi.fn(),
    listMeetings: async (options) => workspace.listMeetings(options),
    openMeeting: async (meetingId) => workspace.openMeeting(meetingId),
    searchTranscript: async (options) => workspace.searchTranscript(options),
    editMeetingSegment: async (command) => workspace.editSegment(command),
    undoMeetingEdit: async (meetingId, generationId, revision) =>
      workspace.undo(meetingId, generationId, revision),
    redoMeetingEdit: async (meetingId, generationId, revision) =>
      workspace.redo(meetingId, generationId, revision),
    renameMeetingSpeaker: async (command) => workspace.renameSpeaker(command),
    mergeMeetingSpeakers: async (command) => workspace.mergeSpeakers(command),
    assignMeetingSpeaker: async (command) => workspace.assignSpeaker(command),
    controlMeetingPlayback: async (meetingId, command) =>
      await playback.command({ meetingId, ...command }),
    exportMeeting: async (meetingId, format) =>
      await exporter.exportMeeting(meetingId, format),
  };
  const handlers = createDesktopIpcHandlers({
    trust: {
      senderId: 1,
      frameId: 2,
      origins: new Set(["http://localhost:5173"]),
    },
    services,
  });
  const api = createDesktopApi({
    invoke: async (channel, payload) =>
      await handlers.invoke(
        channel,
        { senderId: 1, frameId: 2, origin: "http://localhost:5173" },
        payload,
      ),
    on: () => undefined,
    off: () => undefined,
  });

  expect(await api.listMeetings()).toEqual([
    expect.objectContaining({
      meetingId: meeting.id,
      processingState: "partial-success",
    }),
  ]);
  const opened = (await api.openMeeting(meeting.id))!;
  const edited = await api.editMeetingSegment({
    meetingId: meeting.id,
    generationId: opened.summary.generationId!,
    segmentId: opened.segments[0]!.id,
    text: "修订：确认发布。",
    expectedRevision: opened.revision,
  });
  expect(edited.revision).toBe(opened.revision + 1);
  expect((await api.searchTranscript(meeting.id, "修订"))[0]?.text).toBe(
    "修订：确认发布。",
  );
  await api.controlMeetingPlayback(meeting.id, { action: "open" });
  await api.controlMeetingPlayback(meeting.id, {
    action: "seek",
    positionMs: 1_000,
  });
  expect(await api.exportMeeting(meeting.id, "json")).toEqual({
    state: "saved",
    fileName: "端到端周会.wav.json",
  });
  expect(written[0]).toContain("修订：确认发布。");
  expect(JSON.stringify(await api.openMeeting(meeting.id))).not.toContain(
    initialized.profile.mediaDirectory,
  );
  initialized.database.close();
});

function applicationSnapshot(): ApplicationSnapshot {
  return {
    protocolVersion: 1,
    revision: 1,
    navigation: { section: "library" },
    profile: { phase: "ready" },
    connectivity: "online",
    capability: { processing: "available" },
    library: { phase: "ready", meetingCount: 1 },
    reconciliation: [],
    capture: { phase: "idle" },
  };
}
