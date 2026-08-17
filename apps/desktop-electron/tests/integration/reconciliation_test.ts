import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopDomainService } from "../../src/main/domain/desktop_domain_service";
import { initializeAudioProfile } from "../../src/main/profile/audio_profile";
import { DesktopRepository } from "../../src/main/storage/desktop_repository";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "voice2text-reconcile-"));
  temporaryRoots.push(root);
  return root;
}

function requireReady(result: ReturnType<typeof initializeAudioProfile>) {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error(result.message);
  return result;
}

describe("Electron profile startup reconciliation", () => {
  it("makes every interrupted checkpoint explicit without success or retry", () => {
    const applicationDataRoot = temporaryRoot();
    const initial = requireReady(initializeAudioProfile(applicationDataRoot));
    const repository = new DesktopRepository(initial.database, initial.profile);
    const service = new DesktopDomainService(repository, () => 1_000);
    const audio = service.createAudio({
      idempotencyKey: "audio-1",
      sourceIdentity: "electron-import:1",
      displayName: "Audio.wav",
      mediaPath: join(initial.profile.mediaDirectory, "audio.wav"),
      durationMs: 1,
    });
    const job = service.enqueueProcessingJob({
      audioId: audio.value.id,
      idempotencyKey: "job-1",
      operationId: "operation-1",
      resourceIdentity: "resource-1",
    });
    service.claimNextProcessingJob({
      sourceIdentity: "worker:orphaned",
      deadlineAtMs: 2_000,
    });

    const capture = join(initial.profile.captureDirectory, "capture-1");
    mkdirSync(capture);
    writeFileSync(
      join(capture, "journal.json"),
      JSON.stringify({ schema: "desktop-capture-session/v1" }),
    );
    writeFileSync(
      join(initial.profile.stagingDirectory, "import-1.partial"),
      "x",
    );
    const ai = join(initial.profile.aiWorkspaceDirectory, "ai-1");
    mkdirSync(ai);
    writeFileSync(join(ai, "request.json"), "{}");
    const transfer = join(initial.profile.transferDirectory, "transfer-1");
    mkdirSync(transfer);
    writeFileSync(join(transfer, "checkpoint.json"), "{}");
    initial.database.close();

    const restarted = requireReady(
      initializeAudioProfile(applicationDataRoot, { now: () => 2_000 }),
    );
    try {
      const states = restarted.reconciliation.items.map((item) => [
        item.kind,
        item.state,
        item.requiresExplicitAction,
      ]);
      expect(states).toEqual(
        expect.arrayContaining([
          ["processing", "interrupted", true],
          ["capture", "repairable", true],
          ["staging", "repairable", true],
          ["ai", "interrupted", true],
          ["transfer", "interrupted", true],
        ]),
      );
      expect(
        new DesktopRepository(restarted.database, restarted.profile).findJob(
          job.value.id,
        ),
      ).toEqual(
        expect.objectContaining({
          state: "interrupted",
          errorCode: "PROCESS_INTERRUPTED",
        }),
      );
      expect(
        new DesktopDomainService(
          new DesktopRepository(restarted.database, restarted.profile),
          () => 2_000,
        ).claimNextProcessingJob({
          sourceIdentity: "worker:no-auto-retry",
          deadlineAtMs: 3_000,
        }),
      ).toBeNull();
      for (const item of restarted.reconciliation.items) {
        expect(existsSync(item.receiptPath)).toBe(true);
        expect(JSON.parse(readFileSync(item.receiptPath, "utf8"))).toEqual(
          expect.objectContaining({
            state: item.state,
            requiresExplicitAction: true,
          }),
        );
      }
    } finally {
      restarted.database.close();
    }
  });

  it("keeps repairable checkpoints visible on later starts", () => {
    const applicationDataRoot = temporaryRoot();
    const initial = requireReady(initializeAudioProfile(applicationDataRoot));
    writeFileSync(
      join(initial.profile.stagingDirectory, "retry-me.partial"),
      "x",
    );
    initial.database.close();

    const firstRestart = requireReady(
      initializeAudioProfile(applicationDataRoot),
    );
    expect(firstRestart.reconciliation.items).toEqual([
      expect.objectContaining({ kind: "staging", state: "repairable" }),
    ]);
    firstRestart.database.close();

    const secondRestart = requireReady(
      initializeAudioProfile(applicationDataRoot),
    );
    expect(secondRestart.reconciliation.items).toEqual([
      expect.objectContaining({ kind: "staging", state: "repairable" }),
    ]);
    secondRestart.database.close();
  });
});
