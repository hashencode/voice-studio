import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SecureImportDomainService } from "../../src/main/domain/importing/secure_import_domain_service";
import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import type { ExecutionIntent } from "../../src/main/domain/models";
import { finalizeExistingSherpaResult } from "../../src/main/processes/existing_asr_worker_adapter";
import { initializeAudioProfile } from "../../src/main/profile/audio_profile";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("secure import to durable processing", () => {
  it("processes two distinct media authorities through ASR and diarization", () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-distinct-imports-"));
    roots.push(root);
    const initialized = initializeAudioProfile(root, {
      minimumFreeBytes: 0n,
    });
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const repository = new DesktopRepository(
      initialized.database,
      initialized.profile,
    );
    const domain = new DesktopDomainService(repository, () => 10_000);
    try {
      for (const [index, byte] of [11, 29].entries()) {
        const normalizedPath = join(
          initialized.profile.mediaDirectory,
          `distinct-${index}.wav`,
        );
        writeFileSync(normalizedPath, Buffer.alloc(64, byte));
        const normalizedSha256 = createHash("sha256")
          .update(Buffer.alloc(64, byte))
          .digest("hex");
        domain.commitValidatedImport({
          displayName: `Distinct ${index}.wav`,
          normalizedPath,
          normalizedSha256,
          sourceSha256: String(index + 1).repeat(64),
          normalizedSizeBytes: 64,
          durationMs: 1_000,
          receipt: { fixture: index },
          resourceIdentity: "a".repeat(64),
          phase: "asr",
          protocolIdentity: "desktop-sherpa-worker/v1",
          modelSha256: "b".repeat(64),
          runtimeSha256: "c".repeat(64),
        });
      }

      for (let index = 0; index < 2; index += 1) {
        const asrIntent = domain.claimNextProcessingJob({
          sourceIdentity: `worker-${index}`,
          deadlineAtMs: 20_000,
        });
        expect(asrIntent).not.toBeNull();
        expect(asrIntent?.phase).toBe("asr");
        const diarizationIntent = domain.advanceProcessingPhase(asrIntent!, {
          operationId: "diarization",
          resourceIdentity: "d".repeat(64),
          phase: "diarization",
          protocolIdentity: "desktop-sherpa-worker/v1",
          modelSha256: "e".repeat(64),
          runtimeSha256: "f".repeat(64),
        });
        domain.publishProcessingResult({
          ...diarizationIntent,
          complete: true,
          payload: { transcript: `distinct-${index}` },
        });
      }

      expect(repository.listProcessingJobs()).toEqual([
        expect.objectContaining({ state: "completed", phase: "diarization" }),
        expect.objectContaining({ state: "completed", phase: "diarization" }),
      ]);
      expect(
        initialized.database
          .prepare("SELECT COUNT(*) AS count FROM result_publications")
          .get()?.count,
      ).toBe(2);
    } finally {
      initialized.database.close();
    }
  });

  it("deduplicates normalized content and fences publication by every processing identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-import-flow-"));
    roots.push(root);
    const initialized = initializeAudioProfile(root, {
      minimumFreeBytes: 0n,
    });
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const repository = new DesktopRepository(
      initialized.database,
      initialized.profile,
    );
    const domain = new DesktopDomainService(repository, () => 10_000);
    const pcm = Buffer.alloc(64, 7);
    const pcmHash = createHash("sha256").update(pcm).digest("hex");
    const firstPath = join(initialized.profile.mediaDirectory, "first.wav");
    const duplicatePath = join(
      initialized.profile.mediaDirectory,
      "duplicate.wav",
    );
    writeFileSync(firstPath, pcm);
    writeFileSync(duplicatePath, pcm);
    const discarded: string[] = [];
    const importing = new SecureImportDomainService(domain, {
      discard: async (path) => {
        discarded.push(path);
        rmSync(path, { force: true });
      },
    });
    const receipt = (normalizedPath: string) => ({
      schemaVersion: 1 as const,
      normalizedPath,
      sourceSizeBytes: pcm.byteLength,
      normalizedSizeBytes: pcm.byteLength,
      sourceSha256: "a".repeat(64),
      normalizedSha256: pcmHash,
      mediaType: "audio" as const,
      durationMs: 1_000,
      sampleRate: 16_000 as const,
      channels: 1 as const,
      encoding: "pcm_s16le_wav" as const,
    });

    const first = await importing.commitValidatedImport({
      displayName: "第一次.wav",
      receipt: receipt(firstPath),
      processing: {
        operationId: "asr",
        protocolIdentity: "desktop-sherpa-worker/v1",
        modelSha256: "b".repeat(64),
        runtimeSha256: "c".repeat(64),
        resourceIdentity: "d".repeat(64),
      },
    });
    const duplicate = await importing.commitValidatedImport({
      displayName: "重复.wav",
      receipt: receipt(duplicatePath),
      processing: {
        operationId: "asr",
        protocolIdentity: "desktop-sherpa-worker/v1",
        modelSha256: "b".repeat(64),
        runtimeSha256: "c".repeat(64),
        resourceIdentity: "d".repeat(64),
      },
    });

    expect(duplicate).toEqual({ ...first, inserted: false });
    expect(discarded).toEqual([duplicatePath]);
    expect(readFileSync(firstPath)).toEqual(pcm);
    expect(repository.listMediaAuthorities()).toHaveLength(1);
    expect(repository.listProcessingJobs()).toHaveLength(1);
    expect(repository.listProcessingJobs()[0]).toEqual(
      expect.objectContaining({
        idempotencyKey: `processing:${pcmHash}`,
        operationId: "asr",
        state: "queued",
      }),
    );

    const intent = domain.claimNextProcessingJob({
      sourceIdentity: "worker-instance-1",
      deadlineAtMs: 20_000,
    });
    expect(intent).not.toBeNull();
    domain.recordProcessingProgress(intent!, { phase: "asr", fraction: 0.4 });
    expect(repository.findJob(intent!.jobId)).toEqual(
      expect.objectContaining({ phase: "asr", progressFraction: 0.4 }),
    );
    const diarizationIntent = domain.advanceProcessingPhase(intent!, {
      operationId: "diarization",
      resourceIdentity: "f".repeat(64),
      phase: "diarization",
      protocolIdentity: "desktop-sherpa-worker/v1",
      modelSha256: "1".repeat(64),
      runtimeSha256: "2".repeat(64),
    });
    expect(diarizationIntent).toEqual(
      expect.objectContaining({
        jobId: intent!.jobId,
        attempt: intent!.attempt,
        operationId: "diarization",
        resourceIdentity: "f".repeat(64),
        phase: "diarization",
      }),
    );
    expect(
      initialized.database
        .prepare("SELECT COUNT(*) AS count FROM result_publications")
        .get()?.count,
    ).toBe(0);
    expect(() =>
      domain.publishProcessingResult({
        ...intent!,
        complete: true,
        payload: { text: "late ASR result" },
      }),
    ).toThrow("attempt/source fence");
    for (const mutation of [
      { phase: "asr" },
      { protocolIdentity: "wrong" },
      { sourceSha256: "e".repeat(64) },
      { modelSha256: "e".repeat(64) },
      { runtimeSha256: "e".repeat(64) },
      { attempt: intent!.attempt + 1 },
    ] satisfies Array<Partial<ExecutionIntent>>) {
      expect(() =>
        domain.publishProcessingResult({
          ...diarizationIntent,
          ...mutation,
          complete: true,
          payload: { text: "must-not-publish" },
        }),
      ).toThrow("attempt/source fence");
    }
    const publication = domain.publishProcessingResult({
      ...diarizationIntent,
      complete: true,
      payload: finalizeExistingSherpaResult(
        {
          text: "真实 worker 结果由同一 fence 发布",
          asrResultVersion: 2,
          segments: ["真实 worker 结果由同一 fence 发布"],
          segmentStartSeconds: [0],
          durationSeconds: 1,
        },
        {
          turns: [
            {
              startSeconds: 0,
              endSeconds: 1,
              speakerKey: "speaker_01",
            },
          ],
        },
      ),
    });
    expect(publication.attempt).toBe(1);
    expect(publication.payload).toEqual(
      expect.objectContaining({
        diarizationSucceeded: true,
        segments: [
          expect.objectContaining({
            speakerAssignment: "anonymous",
            anonymousSpeakerKey: "speaker_01",
          }),
        ],
      }),
    );
    expect(repository.findJob(intent!.jobId)).toEqual(
      expect.objectContaining({ state: "completed", progressFraction: 1 }),
    );

    const completedDuplicatePath = join(
      initialized.profile.mediaDirectory,
      "completed-duplicate.wav",
    );
    writeFileSync(completedDuplicatePath, pcm);
    const completedDuplicate = await importing.commitValidatedImport({
      displayName: "已完成重复.wav",
      receipt: receipt(completedDuplicatePath),
      processing: {
        operationId: "asr",
        protocolIdentity: "desktop-sherpa-worker/v1",
        modelSha256: "b".repeat(64),
        runtimeSha256: "c".repeat(64),
        resourceIdentity: "d".repeat(64),
      },
    });
    expect(completedDuplicate).toEqual(
      expect.objectContaining({ inserted: false, state: "completed" }),
    );
    initialized.database
      .prepare(
        "UPDATE processing_jobs SET state = 'failed', error_code = 'MODEL_FAILURE' WHERE id = ?",
      )
      .run(intent!.jobId);
    const failedDuplicatePath = join(
      initialized.profile.mediaDirectory,
      "failed-duplicate.wav",
    );
    writeFileSync(failedDuplicatePath, pcm);
    await expect(
      importing.commitValidatedImport({
        displayName: "失败任务重复.wav",
        receipt: receipt(failedDuplicatePath),
        processing: {
          operationId: "asr",
          protocolIdentity: "desktop-sherpa-worker/v1",
          modelSha256: "b".repeat(64),
          runtimeSha256: "c".repeat(64),
          resourceIdentity: "d".repeat(64),
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ inserted: false, state: "failed" }),
    );
    initialized.database.close();
  });

  it("best-effort discards private output for validation and commit failures without replacing the original error", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice2text-import-errors-"));
    roots.push(root);
    const initialized = initializeAudioProfile(root, {
      minimumFreeBytes: 0n,
    });
    if (initialized.status !== "ready") throw new Error(initialized.message);
    const normalizedPath = join(initialized.profile.mediaDirectory, "bad.wav");
    writeFileSync(normalizedPath, Buffer.alloc(64, 1));
    const original = new Error("commit authority rejected");
    const domain = {
      commitValidatedImport: vi.fn(() => {
        throw original;
      }),
    } as unknown as DesktopDomainService;
    const discard = vi.fn(async () => {
      throw new Error("discard also failed");
    });
    const importing = new SecureImportDomainService(domain, { discard });
    const command = {
      displayName: "bad.wav",
      receipt: {
        schemaVersion: 1 as const,
        normalizedPath,
        sourceSizeBytes: 64,
        normalizedSizeBytes: 64,
        sourceSha256: "a".repeat(64),
        normalizedSha256: createHash("sha256")
          .update(Buffer.alloc(64, 1))
          .digest("hex"),
        mediaType: "audio" as const,
        durationMs: 1,
        sampleRate: 16_000 as const,
        channels: 1 as const,
        encoding: "pcm_s16le_wav" as const,
      },
      processing: {
        operationId: "asr" as const,
        protocolIdentity: "desktop-sherpa-worker/v1",
        modelSha256: "b".repeat(64),
        runtimeSha256: "c".repeat(64),
        resourceIdentity: "d".repeat(64),
      },
    };

    await expect(importing.commitValidatedImport(command)).rejects.toBe(
      original,
    );
    expect(discard).toHaveBeenCalledWith(normalizedPath);

    await expect(
      importing.commitValidatedImport({
        ...command,
        receipt: { ...command.receipt, normalizedSizeBytes: 65 },
      }),
    ).rejects.toThrow("size does not match");
    await expect(
      importing.commitValidatedImport({
        ...command,
        receipt: {
          ...command.receipt,
          normalizedSha256: "e".repeat(64),
        },
      }),
    ).rejects.toThrow("hash does not match");
    await expect(
      importing.commitValidatedImport({
        ...command,
        receipt: {
          ...command.receipt,
          sampleRate: 8_000 as never,
        },
      }),
    ).rejects.toThrow();
    expect(discard).toHaveBeenCalledTimes(4);
    initialized.database.close();
  });
});
