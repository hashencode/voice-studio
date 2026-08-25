import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MacOSNativeHelperClient } from "../../src/main/features/importing/macos_native_helper_client";
import { SecureImportDomainService } from "../../src/main/domain/importing/secure_import_domain_service";
import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { DurableProcessCoordinator } from "../../src/main/processes/durable_process_coordinator";
import {
  adaptExistingAsrWorkerFrame,
  finalizeExistingSherpaResult,
} from "../../src/main/processes/existing_asr_worker_adapter";
import { OwnedProcessSupervisor } from "../../src/main/processes/owned_process_supervisor";
import { initializeAudioProfile } from "../../src/main/profile/audio_profile";
import { ResourceCatalog } from "../../src/main/resources/resource_catalog";
import { sha256File } from "../../src/main/security/sha256_file";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";
import { runPackagedProcessingSmoke } from "../../scripts/smoke-packaged-processing-macos";

const roots: string[] = [];
const packagedProcessingIt =
  process.env.RUN_PACKAGED_PROCESSING === "1" ? it : it.skip;
const directPackagedProcessingIt =
  process.env.RUN_DIRECT_PACKAGED_PROCESSING === "1" ? it : it.skip;

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe.skipIf(process.platform !== "darwin")(
  "packaged macOS processing slice",
  () => {
    packagedProcessingIt(
      "uses inherited pipes, a nonce handshake, allowlisted commands, and capability paths",
      async () => {
        const root = mkdtempSync(
          join(realpathSync(homedir()), ".voice2text-helper-smoke-"),
        );
        roots.push(root);
        const helper = packagedHelper();
        const client = new MacOSNativeHelperClient(helper, {
          handshakeTimeoutMs: 5_000,
        });
        const session = await client.openSession({
          exactSourcePaths: [join(root, "selected.wav")],
          destinationRoots: [join(root, "profile-media")],
        });
        expect(session.transport).toBe("inherited-stdio");
        expect(session.helperNonce).toMatch(/^[a-f0-9]{64}$/);
        expect(session.clientNonce).toMatch(/^[a-f0-9]{64}$/);
        await expect(
          session.invokeRaw({ command: "open-socket", path: "/tmp/socket" }),
        ).rejects.toThrow(/allowlist|command/i);
        await expect(
          session.secureImport({
            sourcePath: "/etc/passwd",
            destinationRoot: join(root, "profile-media"),
            destinationId: "audio-123456789abc",
            maxSourceBytes: 1024,
            minimumFreeBytes: 0,
            temporaryStorageMultiplier: 2,
            maxDurationMs: 60_000,
          }),
        ).rejects.toThrow(/capability/i);
        await session.close();
      },
    );

    packagedProcessingIt(
      "runs the real Swift helper from selected media to validated PCM",
      async () => {
        const root = mkdtempSync(
          join(realpathSync(homedir()), ".voice2text-helper-import-"),
        );
        roots.push(root);
        const source = join(root, "selected.wav");
        const destinationRoot = join(root, "profile-media");
        writeFileSync(source, pcmWaveFixture(8_000, 2));
        const helper = packagedHelper();
        const session = await new MacOSNativeHelperClient(helper).openSession({
          exactSourcePaths: [source],
          destinationRoots: [destinationRoot],
        });
        try {
          const receipt = await session.secureImport({
            sourcePath: source,
            destinationRoot,
            destinationId: "audio-abcdef123456",
            maxSourceBytes: 1024 * 1024,
            minimumFreeBytes: 0,
            temporaryStorageMultiplier: 2,
            maxDurationMs: 60_000,
          });
          expect(receipt).toEqual(
            expect.objectContaining({
              sampleRate: 16_000,
              channels: 1,
              encoding: "pcm_s16le_wav",
            }),
          );
          expect(receipt.normalizedPath).toMatch(
            /\/complete\/audio-abcdef123456\.wav$/,
          );
          expect(receipt.normalizedSha256).toMatch(/^[a-f0-9]{64}$/);
        } finally {
          await session.close();
        }
      },
    );

    packagedProcessingIt(
      "exposes the frozen ASR operation from app-bundle resources",
      async () => {
        const catalog = await ResourceCatalog.load(packagedWorkerRoot());
        const identity = catalog.processingIdentity("asr");
        expect(identity).toEqual({
          protocolIdentity: "desktop-sherpa-worker/v1",
          modelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          runtimeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          resourceIdentity: catalog.identity,
        });
        expect(catalog.command("asr").executable).toBe(
          join(packagedWorkerRoot(), "bin/desktop_sherpa_worker"),
        );
        expect(catalog.processingIdentity("diarization")).toEqual(identity);
        expect(catalog.command("diarization").executable).toBe(
          join(packagedWorkerRoot(), "bin/desktop_sherpa_worker"),
        );
      },
    );

    directPackagedProcessingIt(
      "keeps a direct source-module integration for packaged resources",
      async () => {
        const root = mkdtempSync(
          join(realpathSync(homedir()), ".voice2text-packaged-processing-"),
        );
        roots.push(root);
        const source = resolve("../../benchmark/audio/en.wav");
        const initialized = initializeAudioProfile(join(root, "app-data"));
        if (initialized.status !== "ready") {
          throw new Error(initialized.message);
        }
        const { database, profile } = initialized;
        const repository = new DesktopRepository(database, profile);
        const domain = new DesktopDomainService(repository);
        const catalog = await ResourceCatalog.load(packagedWorkerRoot());
        const processing = catalog.processingIdentity("asr");
        if (!processing)
          throw new Error("packaged ASR identity is unavailable");
        const session = await new MacOSNativeHelperClient(
          packagedHelper(),
        ).openSession({
          exactSourcePaths: [source],
          destinationRoots: [profile.mediaDirectory],
        });
        let databaseClosed = false;
        try {
          const receipt = await session.secureImport({
            sourcePath: source,
            destinationRoot: profile.mediaDirectory,
            destinationId: "audio-packaged-representative",
            maxSourceBytes: 64 * 1024 * 1024,
            minimumFreeBytes: 0,
            temporaryStorageMultiplier: 2,
            maxDurationMs: 60 * 60 * 1_000,
          });
          const importing = new SecureImportDomainService(domain, {
            discard: async (committedPath) =>
              await session.discard(committedPath, profile.mediaDirectory),
          });
          const committed = await importing.commitValidatedImport({
            displayName: "en.wav",
            receipt,
          });
          const queued = domain.enqueueProcessingJob({
            audioId: committed.audioId,
            idempotencyKey: `packaged-manual:${committed.audioId}`,
            operationId: "asr",
            phase: "asr",
            sourceSha256: receipt.normalizedSha256,
            ...processing,
          });
          const intent = domain.claimNextProcessingJob({
            sourceIdentity: "packaged-smoke-worker",
            deadlineAtMs: Date.now() + 29 * 60 * 1_000,
          });
          if (!intent)
            throw new Error("packaged processing job was not claimed");
          const attemptOutputDirectory = join(
            profile.workspaceDirectory,
            "attempts",
            `${intent.jobId}-${intent.attempt}`,
          );
          mkdirSync(attemptOutputDirectory, { recursive: true, mode: 0o700 });
          const supervisor = new OwnedProcessSupervisor({
            workspaceRoot: profile.workspaceDirectory,
          });
          const coordinator = new DurableProcessCoordinator(supervisor, {
            requestCancellation: async (jobId) =>
              domain.requestProcessingCancellation(jobId),
            completeCancellation: async (cancelIntent) =>
              domain.completeProcessingCancellation(cancelIntent),
            recordProgress: async (progressIntent, progress) => {
              domain.recordProcessingProgress(progressIntent, progress);
            },
            publishResult: async (publishIntent, payload) => {
              domain.publishProcessingResult({
                ...publishIntent,
                complete: true,
                payload,
              });
            },
          });
          const startedAtMs = Date.now();
          const asrPayload = await coordinator.runPhase({
            intent,
            command: catalog.command("asr", {
              runtimeRoot: join(catalog.root, "runtime"),
              attemptOutput: attemptOutputDirectory,
            }),
            attemptOutputDirectory,
            inputFrame: {
              schemaVersion: 1,
              sourcePath: receipt.normalizedPath,
              sourceSha256: receipt.normalizedSha256,
            },
            frameAdapter: adaptExistingAsrWorkerFrame,
          });
          const diarizationIdentity = catalog.processingIdentity("diarization");
          if (!diarizationIdentity) {
            throw new Error("packaged diarization identity is unavailable");
          }
          const diarizationIntent = domain.advanceProcessingPhase(intent, {
            operationId: "diarization",
            phase: "diarization",
            ...diarizationIdentity,
          });
          const diarizationPayload = await coordinator.runPhase({
            intent: diarizationIntent,
            command: catalog.command("diarization", {
              runtimeRoot: join(catalog.root, "runtime"),
              attemptOutput: attemptOutputDirectory,
            }),
            attemptOutputDirectory,
            inputFrame: {
              schemaVersion: 1,
              sourcePath: receipt.normalizedPath,
              sourceSha256: receipt.normalizedSha256,
            },
            frameAdapter: adaptExistingAsrWorkerFrame,
          });
          const payload = finalizeExistingSherpaResult(
            asrPayload,
            diarizationPayload,
            null,
            Date.now() - startedAtMs,
          );
          domain.publishProcessingResult({
            ...diarizationIntent,
            complete: true,
            payload,
          });
          await coordinator.shutdown();

          const publication = database
            .prepare(
              "SELECT operation_id, phase, payload_json, source_sha256, model_sha256, runtime_sha256 FROM result_publications WHERE job_id = ?",
            )
            .get(queued.value.id);
          const durableJob = database
            .prepare(
              "SELECT state, progress_fraction FROM processing_jobs WHERE id = ?",
            )
            .get(queued.value.id);
          const durableAudio = database
            .prepare(
              "SELECT media_path, active_publication_id FROM audio_items WHERE id = ?",
            )
            .get(committed.audioId);
          expect(payload.diarizationSucceeded).toBe(true);
          expect(payload.segments).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ text: expect.any(String) }),
            ]),
          );
          expect(durableJob).toEqual(
            expect.objectContaining({
              state: "completed",
              progress_fraction: 1,
            }),
          );
          expect(Number(durableAudio?.active_publication_id)).toBeGreaterThan(
            0,
          );
          expect(String(durableAudio?.media_path)).toBe(receipt.normalizedPath);
          expect(String(publication?.source_sha256)).toBe(
            receipt.normalizedSha256,
          );
          expect(publication).toEqual(
            expect.objectContaining({
              operation_id: "diarization",
              phase: "diarization",
            }),
          );
          expect(String(publication?.model_sha256)).toBe(
            diarizationIdentity.modelSha256,
          );
          expect(String(publication?.runtime_sha256)).toBe(
            diarizationIdentity.runtimeSha256,
          );

          const outputJson = String(publication?.payload_json);
          const transcriptSegments = payload.segments as Array<{
            text: string;
          }>;
          database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          database.close();
          databaseClosed = true;
          const evidence = {
            schemaVersion: 1,
            sourceFixtureSha256: await sha256File(source),
            sourceReceiptSha256: receipt.sourceSha256,
            mediaSha256: await sha256File(receipt.normalizedPath),
            outputSha256: sha256Bytes(outputJson),
            databaseSha256: await sha256File(profile.databasePath),
            resourceManifestSha256: catalog.identity,
            modelSha256: processing.modelSha256,
            runtimeSha256: diarizationIdentity.runtimeSha256,
            audioId: committed.audioId,
            jobId: queued.value.id,
            attempt: intent.attempt,
            state: String(durableJob?.state),
            transcriptNonEmpty: transcriptSegments.some(
              (segment) => segment.text.trim().length > 0,
            ),
            segmentCount: transcriptSegments.length,
          };
          expect(evidence.sourceFixtureSha256).toBe(
            "4944f83f611e6997b45d7b399bd4cf34ae1fac30d8969eb8a4362dd00d3874c9",
          );
          expect(evidence.mediaSha256).toBe(receipt.normalizedSha256);
          console.log(
            `U6_PACKAGED_PROCESSING_EVIDENCE=${JSON.stringify(evidence)}`,
          );
          const evidencePath = process.env.U6_PROCESSING_EVIDENCE_PATH;
          if (evidencePath) {
            writeFileSync(
              evidencePath,
              `${JSON.stringify(evidence, null, 2)}\n`,
              {
                mode: 0o600,
              },
            );
          }
        } finally {
          if (!databaseClosed) database.close();
          await session.close();
        }
      },
      30 * 60 * 1_000,
    );

    packagedProcessingIt(
      "launches the packaged app twice and matches the frozen Dart reference projection",
      async () => {
        const expectation = JSON.parse(
          readFileSync(
            resolve(
              "tests/fixtures/flutter-reference/packaged_processing_projection_v1.json",
            ),
            "utf8",
          ),
        ) as { projectionSha256: string };
        const first = await runPackagedProcessingSmoke();
        const second = await runPackagedProcessingSmoke();

        expect(first.projectionSha256).toBe(expectation.projectionSha256);
        expect(second.projectionSha256).toBe(expectation.projectionSha256);
        expect(second.projection).toEqual(first.projection);
        expect(first.transcriptNonEmpty).toBe(true);
        expect(second.transcriptNonEmpty).toBe(true);
      },
      30 * 60 * 1_000,
    );
  },
);

function pcmWaveFixture(sampleRate: number, channels: number): Buffer {
  const frames = Math.floor(sampleRate / 4);
  const samples = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(4_000 * Math.sin(frame * 0.05));
    for (let channel = 0; channel < channels; channel += 1) {
      samples.writeInt16LE(value, (frame * channels + channel) * 2);
    }
  }
  const output = Buffer.alloc(44 + samples.byteLength);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + samples.byteLength, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * channels * 2, 28);
  output.writeUInt16LE(channels * 2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(samples.byteLength, 40);
  samples.copy(output, 44);
  return output;
}

function packagedHelper(): string {
  const packaged = resolve(
    "out/Voice2Text-darwin-arm64/Voice2Text.app/Contents/Resources/native/macos/bin/desktop_macos_native_helper",
  );
  if (!existsSync(packaged)) {
    throw new Error("packaged macOS helper is missing from the app bundle");
  }
  return packaged;
}

function packagedWorkerRoot(): string {
  const packaged = resolve(
    "out/Voice2Text-darwin-arm64/Voice2Text.app/Contents/Resources/worker",
  );
  if (!existsSync(packaged)) {
    throw new Error(
      "packaged worker resources are missing from the app bundle",
    );
  }
  return packaged;
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
