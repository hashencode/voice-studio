import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopDomainService } from "../../../src/main/domain/desktop_domain_service";
import {
  AudioExportService,
  safeFilenameBase,
} from "../../../src/main/domain/workspace/audio_export_service";
import { AudioWorkspaceService } from "../../../src/main/domain/workspace/audio_workspace_service";
import { initializeAudioProfile } from "../../../src/main/profile/audio_profile";
import { DesktopRepository } from "../../../src/main/storage/desktop_repository";
import { AudioWorkspaceRepository } from "../../../src/main/storage/repositories/audio_workspace_repository";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "voice2text-u7-workspace-"));
  roots.push(root);
  const initialized = initializeAudioProfile(root);
  if (initialized.status !== "ready") throw new Error(initialized.message);
  let now = 1_000;
  const repository = new DesktopRepository(
    initialized.database,
    initialized.profile,
  );
  const domain = new DesktopDomainService(repository, () => ++now);
  const workspace = new AudioWorkspaceService(
    new AudioWorkspaceRepository(initialized.database, initialized.profile),
    () => ++now,
  );
  return { ...initialized, domain, repository, workspace };
}

function createAudio(
  context: ReturnType<typeof fixture>,
  displayName = "项目周会.wav",
) {
  return context.domain.createAudio({
    idempotencyKey: `audio:${displayName}`,
    sourceIdentity: `source:${displayName}`,
    displayName,
    mediaPath: join(context.profile.mediaDirectory, displayName),
    durationMs: 6_000,
  }).value;
}

function publish(
  context: ReturnType<typeof fixture>,
  audioId: number,
  id: string,
  segments: Array<Record<string, unknown>>,
) {
  context.domain.enqueueProcessingJob({
    audioId,
    idempotencyKey: `job:${id}`,
    operationId: "asr",
    resourceIdentity: "asr-resource",
    phase: "asr",
    protocolIdentity: "desktop-sherpa-worker/v1",
    sourceSha256: "a".repeat(64),
    modelSha256: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
  });
  const asr = context.domain.claimNextProcessingJob({
    sourceIdentity: `worker:${id}`,
    deadlineAtMs: 60_000,
  });
  if (!asr) throw new Error("processing intent unavailable");
  const intent = context.domain.advanceProcessingPhase(asr, {
    operationId: "diarization",
    resourceIdentity: "diarization-resource",
    phase: "diarization",
    protocolIdentity: "desktop-sherpa-worker/v1",
    modelSha256: "d".repeat(64),
    runtimeSha256: "e".repeat(64),
  });
  context.domain.publishProcessingResult({
    ...intent,
    complete: true,
    payload: {
      segments,
      engineId: "test",
      elapsedMilliseconds: 1,
      peakResidentBytes: 1,
      diarizationSucceeded: true,
      diarizationErrorCode: null,
    },
  });
  return intent;
}

const initialSegments = [
  {
    startSeconds: 0,
    endSeconds: 1.5,
    text: "确认下周发布。",
    speakerAssignment: "anonymous",
    anonymousSpeakerKey: "speaker-a",
  },
  {
    startSeconds: 1.5,
    endSeconds: 3,
    text: "我会准备发布清单。",
    speakerAssignment: "anonymous",
    anonymousSpeakerKey: "speaker-b",
  },
  {
    startSeconds: 3,
    endSeconds: 5,
    text: "好的。",
    speakerAssignment: "overlap",
    anonymousSpeakerKey: null,
  },
] as const;

describe("audio workspace authority", () => {
  it("persists edit, undo/redo and manual speaker authority across a later publication and restart", () => {
    const context = fixture();
    try {
      const audio = createAudio(context);
      publish(context, audio.id, "first", [...initialSegments]);

      const listed = context.workspace.listAudios({ query: " 项目 " });
      expect(listed).toHaveLength(1);
      let snapshot = context.workspace.openAudio(audio.id);
      expect(snapshot?.segments).toHaveLength(3);
      expect(snapshot?.segments[2]?.speakerState).toBe("overlap");

      const first = snapshot!.segments[0]!;
      context.workspace.editSegment({
        audioId: audio.id,
        generationId: snapshot!.summary.generationId!,
        segmentId: first.id,
        text: "修订：确认下周发布。",
        expectedRevision: snapshot!.revision,
      });
      snapshot = context.workspace.openAudio(audio.id);
      expect(snapshot?.canUndo).toBe(true);
      expect(
        context.workspace.undo(
          audio.id,
          snapshot!.summary.generationId!,
          snapshot!.revision,
        ).segments[0]?.text,
      ).toBe("确认下周发布。");
      snapshot = context.workspace.redo(
        audio.id,
        snapshot!.summary.generationId!,
        context.workspace.openAudio(audio.id)!.revision,
      );
      expect(snapshot.segments[0]?.text).toBe("修订：确认下周发布。");

      const targetSpeaker = snapshot.speakers[0]!;
      snapshot = context.workspace.renameSpeaker({
        audioId: audio.id,
        generationId: snapshot.summary.generationId!,
        speakerId: targetSpeaker.id,
        name: "主持人",
        expectedRevision: snapshot.revision,
      });
      snapshot = context.workspace.assignSpeaker({
        audioId: audio.id,
        generationId: snapshot.summary.generationId!,
        segmentId: snapshot.segments[1]!.id,
        state: "assigned",
        speakerId: targetSpeaker.id,
        expectedRevision: snapshot.revision,
      });
      snapshot = context.workspace.mergeSpeakers({
        audioId: audio.id,
        generationId: snapshot.summary.generationId!,
        targetSpeakerId: targetSpeaker.id,
        sourceSpeakerIds: [snapshot.speakers[1]!.id],
        expectedRevision: snapshot.revision,
      });

      publish(context, audio.id, "retry", [
        { ...initialSegments[0], text: "机器重跑不应覆盖修订" },
        { ...initialSegments[1], text: "机器重跑不应覆盖说话人" },
        { ...initialSegments[2], text: "机器重跑" },
      ]);
      context.database.close();

      const reopened = initializeAudioProfile(rootFor(context));
      if (reopened.status !== "ready") throw new Error(reopened.message);
      const afterRestart = new AudioWorkspaceService(
        new AudioWorkspaceRepository(reopened.database, reopened.profile),
      ).openAudio(audio.id)!;
      expect(afterRestart.segments[0]?.text).toBe("修订：确认下周发布。");
      expect(afterRestart.segments[0]?.machineText).toBe(
        "机器重跑不应覆盖修订",
      );
      expect(afterRestart.segments[1]).toEqual(
        expect.objectContaining({
          speakerName: "主持人",
          speakerSource: "manual",
        }),
      );
      expect(
        afterRestart.speakers.filter(
          (speaker) => speaker.mergedIntoSpeakerId !== null,
        ),
      ).toHaveLength(1);
      expect(afterRestart.canUndo).toBe(false);
      reopened.database.close();
    } finally {
      if (context.database.isOpen) context.database.close();
    }
  });

  it("keeps the reviewed generation active when a retry cannot reconcile manual overlays", () => {
    const context = fixture();
    try {
      const audio = createAudio(context);
      publish(context, audio.id, "first-pending", [...initialSegments]);
      let snapshot = context.workspace.openAudio(audio.id)!;
      context.workspace.editSegment({
        audioId: audio.id,
        generationId: snapshot.summary.generationId!,
        segmentId: snapshot.segments[0]!.id,
        text: "人工冻结文本",
        expectedRevision: snapshot.revision,
      });
      snapshot = context.workspace.openAudio(audio.id)!;
      const reviewedGenerationId = snapshot.summary.generationId!;

      publish(context, audio.id, "shifted-retry", [
        { ...initialSegments[0], startSeconds: 0.1, endSeconds: 1.6 },
        ...initialSegments.slice(1),
      ]);

      const afterRetry = context.workspace.openAudio(audio.id)!;
      expect(afterRetry.summary.generationId).toBe(reviewedGenerationId);
      expect(afterRetry.segments[0]!.text).toBe("人工冻结文本");
      expect(
        context.database
          .prepare(
            "SELECT COUNT(*) AS count FROM audio_generations WHERE audio_id = ? AND reconciliation_state = 'pending'",
          )
          .get(audio.id)?.count,
      ).toBe(1);
    } finally {
      context.database.close();
    }
  });

  it("fences history by generation and atomically bumps revision when a retry activates", () => {
    const context = fixture();
    try {
      const audio = createAudio(context);
      publish(context, audio.id, "first-history", [...initialSegments]);
      let snapshot = context.workspace.openAudio(audio.id)!;
      const oldGenerationId = snapshot.summary.generationId!;
      context.workspace.editSegment({
        audioId: audio.id,
        generationId: oldGenerationId,
        segmentId: snapshot.segments[0]!.id,
        text: "可投影人工文本",
        expectedRevision: snapshot.revision,
      });
      snapshot = context.workspace.openAudio(audio.id)!;
      const beforeSwitchRevision = snapshot.revision;
      publish(context, audio.id, "matching-retry", [
        { ...initialSegments[0], text: "新机器文本" },
        ...initialSegments.slice(1),
      ]);
      const afterSwitch = context.workspace.openAudio(audio.id)!;
      expect(afterSwitch.summary.generationId).not.toBe(oldGenerationId);
      expect(afterSwitch.revision).toBe(beforeSwitchRevision + 1);
      expect(() =>
        context.workspace.undo(audio.id, oldGenerationId, afterSwitch.revision),
      ).toThrow(/changed|generation/i);
    } finally {
      context.database.close();
    }
  });

  it("keeps immutable machine speaker provenance separate from manual assignment", () => {
    const context = fixture();
    try {
      const audio = createAudio(context);
      publish(context, audio.id, "speaker-provenance", [...initialSegments]);
      let snapshot = context.workspace.openAudio(audio.id)!;
      const segment = snapshot.segments[0]!;
      const machineSpeakerId = segment.speakerId!;
      const manualSpeakerId = snapshot.speakers[1]!.id;
      snapshot = context.workspace.assignSpeaker({
        audioId: audio.id,
        generationId: snapshot.summary.generationId!,
        segmentId: segment.id,
        state: "assigned",
        speakerId: manualSpeakerId,
        expectedRevision: snapshot.revision,
      });
      const row = context.database
        .prepare(
          "SELECT speaker_id, machine_speaker_id, speaker_source FROM transcript_segments WHERE id = ?",
        )
        .get(segment.id);
      expect(row).toEqual(
        expect.objectContaining({
          speaker_id: manualSpeakerId,
          machine_speaker_id: machineSpeakerId,
          speaker_source: "manual",
        }),
      );
      expect(() =>
        context.database
          .prepare(
            "UPDATE transcript_segments SET machine_text = ? WHERE id = ?",
          )
          .run("tampered machine text", segment.id),
      ).toThrow(/immutable/i);
    } finally {
      context.database.close();
    }
  });

  it("rejects cross-audio generation, segment and speaker relationships in SQLite", () => {
    const context = fixture();
    try {
      const first = createAudio(context, "first.wav");
      const second = createAudio(context, "second.wav");
      publish(context, first.id, "first-authority", [...initialSegments]);
      publish(context, second.id, "second-authority", [...initialSegments]);
      const firstWorkspace = context.workspace.openAudio(first.id)!;
      const secondWorkspace = context.workspace.openAudio(second.id)!;
      expect(() =>
        context.database
          .prepare(
            "UPDATE audio_items SET active_generation_id = ? WHERE id = ?",
          )
          .run(firstWorkspace.summary.generationId!, second.id),
      ).toThrow();
      expect(() =>
        context.database
          .prepare("UPDATE transcript_segments SET audio_id = ? WHERE id = ?")
          .run(second.id, firstWorkspace.segments[0]!.id),
      ).toThrow();
      expect(() =>
        context.database
          .prepare(
            "UPDATE audio_speakers SET merged_into_speaker_id = ? WHERE id = ?",
          )
          .run(secondWorkspace.speakers[0]!.id, firstWorkspace.speakers[0]!.id),
      ).toThrow();
    } finally {
      context.database.close();
    }
  });

  it("resolves playback only through the canonical media authority identity", async () => {
    const context = fixture();
    try {
      const audio = createAudio(context, "authority.wav");
      const bytes = Buffer.alloc(64, 7);
      writeFileSync(audio.mediaPath, bytes, { mode: 0o600 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const authority = context.database
        .prepare(
          `INSERT INTO media_authorities (
            content_sha256, normalized_path, source_sha256, size_bytes,
            duration_ms, receipt_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
        )
        .run(sha256, audio.mediaPath, sha256, bytes.length, 6_000, 1_000);
      context.database
        .prepare("UPDATE audio_items SET media_authority_id = ? WHERE id = ?")
        .run(Number(authority.lastInsertRowid), audio.id);
      const resolver = new AudioWorkspaceRepository(
        context.database,
        context.profile,
      );
      await expect(resolver.resolvePlayback(audio.id)).resolves.toEqual({
        mediaPath: realpathSync(audio.mediaPath),
        durationMs: 6_000,
      });

      writeFileSync(audio.mediaPath, Buffer.alloc(64, 8));
      await expect(resolver.resolvePlayback(audio.id)).rejects.toThrow(
        /identity/i,
      );
    } finally {
      context.database.close();
    }
  });

  it("keeps 3001-segment open and search below the fixed p95 envelope", () => {
    const context = fixture();
    try {
      const audio = createAudio(context, "两小时音频.wav");
      const segments = Array.from({ length: 3001 }, (_, index) => ({
        startSeconds: index * 2,
        endSeconds: index * 2 + 1.5,
        text: index === 2999 ? "唯一检索目标" : `音频片段 ${index}`,
        speakerAssignment: "anonymous",
        anonymousSpeakerKey: `speaker-${index % 5}`,
      }));
      publish(context, audio.id, "large", segments);

      context.workspace.openAudio(audio.id);
      context.workspace.searchTranscript({
        audioId: audio.id,
        query: "唯一检索目标",
      });
      const openSamples: number[] = [];
      const searchSamples: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        let started = performance.now();
        expect(context.workspace.openAudio(audio.id)?.segments).toHaveLength(
          3001,
        );
        openSamples.push(performance.now() - started);
        started = performance.now();
        expect(
          context.workspace.searchTranscript({
            audioId: audio.id,
            query: "唯一检索目标",
          })[0]?.sequenceId,
        ).toBe(2999);
        searchSamples.push(performance.now() - started);
      }
      openSamples.sort((a, b) => a - b);
      searchSamples.sort((a, b) => a - b);
      console.info(
        "U7_PERFORMANCE_EVIDENCE",
        JSON.stringify({
          segmentCount: 3001,
          samples: 20,
          openP95Ms: Number(openSamples[18]!.toFixed(3)),
          searchP95Ms: Number(searchSamples[18]!.toFixed(3)),
        }),
      );
      expect(openSamples[18]).toBeLessThan(2_000);
      expect(searchSamples[18]).toBeLessThan(200);
    } finally {
      context.database.close();
    }
  });

  it("exports only the active reviewed generation in every format with a safe name", async () => {
    const context = fixture();
    try {
      const audio = createAudio(context, "项目/周会:最终.wav");
      publish(context, audio.id, "export", [...initialSegments]);
      const saved: Array<{ name: string; contents: string }> = [];
      const exporter = new AudioExportService(
        context.workspace,
        async (request) => {
          saved.push({
            name: request.suggestedName,
            contents: request.contents,
          });
          return { state: "saved", fileName: request.suggestedName };
        },
      );

      for (const format of ["txt", "md", "vtt", "srt", "json"] as const) {
        await exporter.exportAudio(audio.id, format);
      }

      expect(saved.map((entry) => entry.name)).toEqual([
        "项目_周会_最终.wav.txt",
        "项目_周会_最终.wav.md",
        "项目_周会_最终.wav.vtt",
        "项目_周会_最终.wav.srt",
        "项目_周会_最终.wav.json",
      ]);
      expect(saved[0]?.contents).toContain("说话人 1：确认下周发布。");
      expect(saved[2]?.contents).toContain("00:00:00.000 --> 00:00:01.500");
      expect(saved[3]?.contents).toContain("00:00:00,000 --> 00:00:01,500");
      expect(saved[4]?.contents).toContain('"schemaVersion": 1');
      expect(
        Buffer.byteLength(`${safeFilenameBase("音频".repeat(200))}.json`),
      ).toBeLessThanOrEqual(255);
    } finally {
      context.database.close();
    }
  });
});

function rootFor(context: ReturnType<typeof fixture>): string {
  return join(context.profile.root, "..", "..");
}
