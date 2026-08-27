import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { AudioExportService } from "../../src/main/domain/workspace/audio_export_service";
import { AudioWorkspaceService } from "../../src/main/domain/workspace/audio_workspace_service";
import { AudioPlaybackService } from "../../src/main/features/playback/audio_playback_service";
import {
  createDesktopIpcHandlers,
  type DesktopIpcServices,
} from "../../src/main/ipc/desktop_ipc";
import { initializeAudioProfile } from "../../src/main/profile/audio_profile";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";
import { AudioWorkspaceRepository } from "../../src/main/storage/repositories/audio_workspace_repository";
import { createDesktopApi } from "../../src/preload/api";
import type { ApplicationSnapshot } from "../../src/shared/contracts";
import { companionCommandStubs } from "../fixtures/companion";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("reviews a completed audio through validated Main and Preload contracts without leaking paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "voice2text-u7-e2e-"));
  roots.push(root);
  const initialized = initializeAudioProfile(root);
  if (initialized.status !== "ready") throw new Error(initialized.message);
  const durable = new DesktopRepository(
    initialized.database,
    initialized.profile,
  );
  const domain = new DesktopDomainService(durable);
  const repository = new AudioWorkspaceRepository(
    initialized.database,
    initialized.profile,
  );
  const workspace = new AudioWorkspaceService(repository);
  const audio = domain.createAudio({
    idempotencyKey: "audio:e2e",
    sourceIdentity: "source:e2e",
    displayName: "端到端周会.wav",
    mediaPath: join(
      initialized.profile.mediaDirectory,
      "private-authority.wav",
    ),
    durationMs: 2_000,
  }).value;
  const mediaBytes = Buffer.alloc(64, 9);
  writeFileSync(audio.mediaPath, mediaBytes, { mode: 0o600 });
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
      audio.mediaPath,
      mediaSha256,
      mediaBytes.length,
      audio.durationMs,
      Date.now(),
    );
  initialized.database
    .prepare("UPDATE audio_items SET media_authority_id = ? WHERE id = ?")
    .run(Number(authority.lastInsertRowid), audio.id);
  domain.enqueueProcessingJob({
    audioId: audio.id,
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
  const playback = new AudioPlaybackService(repository, playbackPort);
  const written: string[] = [];
  const exporter = new AudioExportService(workspace, async (request) => {
    written.push(request.contents);
    return { state: "saved", fileName: request.suggestedName };
  });
  const snapshot = applicationSnapshot();
  const services: DesktopIpcServices = {
    ...companionCommandStubs(),
    getAiSettings: vi.fn(),
    createAiProviderProfile: vi.fn(),
    updateAiProviderProfile: vi.fn(),
    selectAiProviderProfile: vi.fn(),
    deleteAiProviderProfile: vi.fn(),
    prepareAudioAi: vi.fn(),
    getAudioAiSnapshot: vi.fn(async () => null),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    applicationSnapshot: () => snapshot,
    navigate: () => snapshot,
    requestBootstrapAction: async () => snapshot,
    markActivityRead: () => snapshot,
    markAllActivityRead: () => snapshot,
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    listProcessingTasks: vi.fn(async () => []),
    importAudio: vi.fn(),
    preflightCapture: vi.fn(),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    listCaptureRecoveries: vi.fn(async () => []),
    actOnCaptureRecovery: vi.fn(),
    getCaptionSnapshot: vi.fn(async () => null),
    retryFormalTranscript: vi.fn(),
    listAudios: async (options) => workspace.listAudios(options),
    openAudio: async (audioId) => workspace.openAudio(audioId),
    searchTranscript: async (options) => workspace.searchTranscript(options),
    editAudioSegment: async (command) => workspace.editSegment(command),
    undoAudioEdit: async (audioId, generationId, revision) =>
      workspace.undo(audioId, generationId, revision),
    redoAudioEdit: async (audioId, generationId, revision) =>
      workspace.redo(audioId, generationId, revision),
    renameAudioSpeaker: async (command) => workspace.renameSpeaker(command),
    mergeAudioSpeakers: async (command) => workspace.mergeSpeakers(command),
    assignAudioSpeaker: async (command) => workspace.assignSpeaker(command),
    controlAudioPlayback: async (audioId, command) =>
      await playback.command({ audioId, ...command }),
    exportAudio: async (audioId, format) =>
      await exporter.exportAudio(audioId, format),
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

  expect(await api.listAudios()).toEqual([
    expect.objectContaining({
      audioId: audio.id,
      processingState: "partial-success",
    }),
  ]);
  const opened = (await api.openAudio(audio.id))!;
  const edited = await api.editAudioSegment({
    audioId: audio.id,
    generationId: opened.summary.generationId!,
    segmentId: opened.segments[0]!.id,
    text: "修订：确认发布。",
    expectedRevision: opened.revision,
  });
  expect(edited.revision).toBe(opened.revision + 1);
  expect((await api.searchTranscript(audio.id, "修订"))[0]?.text).toBe(
    "修订：确认发布。",
  );
  await api.controlAudioPlayback(audio.id, { action: "open" });
  await api.controlAudioPlayback(audio.id, {
    action: "seek",
    positionMs: 1_000,
  });
  expect(await api.exportAudio(audio.id, "json")).toEqual({
    state: "saved",
    fileName: "端到端周会.wav.json",
  });
  expect(written[0]).toContain("修订：确认发布。");
  expect(JSON.stringify(await api.openAudio(audio.id))).not.toContain(
    initialized.profile.mediaDirectory,
  );
  initialized.database.close();
});

function applicationSnapshot(): ApplicationSnapshot {
  return {
    protocolVersion: 2,
    revision: 1,
    navigation: { section: "library" },
    profile: { phase: "ready", legacyDatabaseArchived: false },
    connectivity: "online",
    capability: { processing: "available" },
    library: { phase: "ready", audioCount: 1 },
    reconciliation: [],
    capture: { phase: "idle" },
  };
}
