import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  AttemptIdentityError,
  DesktopDomainService,
  PartialPublicationError,
} from "../../../src/main/domain/desktop_domain_service";
import { initializeElectronProfile } from "../../../src/main/profile/electron_profile";
import { openElectronDatabase } from "../../../src/main/storage/database";
import {
  DesktopRepository,
  IdempotencyConflictError,
} from "../../../src/main/storage/desktop_repository";

interface CharacterizationFixture {
  meeting: {
    idempotencyKey: string;
    sourceIdentity: string;
    displayName: string;
    mediaPath: string;
    durationMs: number;
  };
  job: {
    idempotencyKey: string;
    operationId: string;
    resourceIdentity: string;
  };
  note: { idempotencyKey: string; body: string };
  receipt: {
    idempotencyKey: string;
    kind: string;
    payload: Record<string, unknown>;
  };
  publication: Record<string, unknown>;
}

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/flutter-reference/desktop_domain_v1.json",
);
const fixture = JSON.parse(
  readFileSync(fixturePath, "utf8"),
) as CharacterizationFixture;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function openService(nowMs = 1000) {
  const root = mkdtempSync(join(tmpdir(), "voice2text-electron-domain-"));
  temporaryRoots.push(root);
  const initialized = initializeElectronProfile(root);
  if (initialized.status !== "ready") throw new Error(initialized.message);
  const { database, profile } = initialized;
  const repository = new DesktopRepository(database, profile);
  const service = new DesktopDomainService(repository, () => nowMs);
  const meetingCommand = {
    ...fixture.meeting,
    mediaPath: join(profile.mediaDirectory, "meeting-001.wav"),
  };
  return { database, meetingCommand, profile, repository, service };
}

function seedMeetingAndJob(
  service: DesktopDomainService,
  meetingCommand: CharacterizationFixture["meeting"],
) {
  const meeting = service.createMeeting(meetingCommand);
  const job = service.enqueueProcessingJob({
    ...fixture.job,
    meetingId: meeting.value.id,
  });
  return { meeting, job };
}

describe("DesktopDomainService idempotency", () => {
  it("rejects durable media paths outside the Electron profile", () => {
    const { database, meetingCommand, service } = openService();
    try {
      expect(() =>
        service.createMeeting({
          ...meetingCommand,
          mediaPath: join(
            dirname(meetingCommand.mediaPath),
            "..",
            "..",
            "outside.wav",
          ),
        }),
      ).toThrow("outside the Electron profile");
      expect(rowCount(database, "meetings")).toBe(0);
    } finally {
      database.close();
    }
  });

  it("does not duplicate a meeting, job, note, or receipt", () => {
    const { database, meetingCommand, service } = openService();
    try {
      const first = seedMeetingAndJob(service, meetingCommand);
      const secondMeeting = service.createMeeting(meetingCommand);
      const secondJob = service.enqueueProcessingJob({
        ...fixture.job,
        meetingId: first.meeting.value.id,
      });
      const firstNote = service.saveMeetingNote({
        ...fixture.note,
        meetingId: first.meeting.value.id,
      });
      const secondNote = service.saveMeetingNote({
        ...fixture.note,
        meetingId: first.meeting.value.id,
      });
      const firstReceipt = service.recordReceipt({
        ...fixture.receipt,
        meetingId: first.meeting.value.id,
      });
      const secondReceipt = service.recordReceipt({
        ...fixture.receipt,
        meetingId: first.meeting.value.id,
      });

      expect(first.meeting.inserted).toBe(true);
      expect(first.job.inserted).toBe(true);
      expect(secondMeeting).toEqual({ ...first.meeting, inserted: false });
      expect(secondJob).toEqual({ ...first.job, inserted: false });
      expect(secondNote).toEqual({ ...firstNote, inserted: false });
      expect(secondReceipt).toEqual({ ...firstReceipt, inserted: false });
      expect(rowCount(database, "meetings")).toBe(1);
      expect(rowCount(database, "processing_jobs")).toBe(1);
      expect(rowCount(database, "meeting_notes")).toBe(1);
      expect(rowCount(database, "durable_receipts")).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rejects reuse of an idempotency key with different content", () => {
    const { database, meetingCommand, service } = openService();
    try {
      service.createMeeting(meetingCommand);
      expect(() =>
        service.createMeeting({
          ...meetingCommand,
          displayName: "Different meeting.wav",
        }),
      ).toThrow(IdempotencyConflictError);
      expect(rowCount(database, "meetings")).toBe(1);
    } finally {
      database.close();
    }
  });
});

describe("attempt and source fenced publication", () => {
  it("records cancellation durably before completion and rejects late output", () => {
    const { database, meetingCommand, repository, service } = openService();
    try {
      const { job } = seedMeetingAndJob(service, meetingCommand);
      const intent = service.claimNextProcessingJob({
        sourceIdentity: "worker:cancel",
        deadlineAtMs: 5000,
      });

      expect(service.requestProcessingCancellation(job.value.id)).toEqual(
        intent,
      );
      expect(repository.findJob(job.value.id)?.state).toBe("canceling");
      expect(() =>
        service.publishProcessingResult({
          ...intent!,
          complete: true,
          payload: fixture.publication,
        }),
      ).toThrow(AttemptIdentityError);
      expect(service.completeProcessingCancellation(intent!)).toBe(true);
      expect(repository.findJob(job.value.id)?.state).toBe("canceled");
      expect(rowCount(database, "result_publications")).toBe(0);
    } finally {
      database.close();
    }
  });

  it("rejects partial, wrong-source, and late results before atomic publication", () => {
    const { database, meetingCommand, repository, service } = openService();
    try {
      const { job } = seedMeetingAndJob(service, meetingCommand);
      const firstIntent = service.claimNextProcessingJob({
        sourceIdentity: "worker:first",
        deadlineAtMs: 5000,
      });
      expect(firstIntent?.attempt).toBe(1);

      expect(() =>
        service.publishProcessingResult({
          ...firstIntent!,
          complete: false,
          payload: fixture.publication,
        }),
      ).toThrow(PartialPublicationError);
      expect(() =>
        service.publishProcessingResult({
          ...firstIntent!,
          sourceIdentity: "worker:impostor",
          complete: true,
          payload: fixture.publication,
        }),
      ).toThrow(AttemptIdentityError);
      expect(rowCount(database, "result_publications")).toBe(0);

      expect(service.reconcileStartup()).toBe(1);
      expect(service.retryInterruptedJob(job.value.id, 1)).toBe(true);
      const secondIntent = service.claimNextProcessingJob({
        sourceIdentity: "worker:second",
        deadlineAtMs: 6000,
      });
      expect(secondIntent?.attempt).toBe(2);
      expect(() =>
        service.publishProcessingResult({
          ...firstIntent!,
          complete: true,
          payload: fixture.publication,
        }),
      ).toThrow(AttemptIdentityError);

      const publication = service.publishProcessingResult({
        ...secondIntent!,
        complete: true,
        payload: fixture.publication,
      });
      expect(publication.attempt).toBe(2);
      expect(rowCount(database, "result_publications")).toBe(1);
      expect(repository.findJob(job.value.id)?.state).toBe("completed");
    } finally {
      database.close();
    }
  });

  it("rolls publication back if the job cannot complete", () => {
    const { database, meetingCommand, repository, service } = openService();
    try {
      seedMeetingAndJob(service, meetingCommand);
      const intent = service.claimNextProcessingJob({
        sourceIdentity: "worker:atomic",
        deadlineAtMs: 5000,
      });
      database.exec(`
        CREATE TRIGGER force_publication_rollback
        BEFORE UPDATE OF state ON processing_jobs
        WHEN NEW.state = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'forced completion failure');
        END;
      `);

      expect(() =>
        service.publishProcessingResult({
          ...intent!,
          complete: true,
          payload: fixture.publication,
        }),
      ).toThrow();
      expect(rowCount(database, "result_publications")).toBe(0);
      expect(repository.findJob(intent!.jobId)?.state).toBe("running");
    } finally {
      database.close();
    }
  });
});

function rowCount(
  database: ReturnType<typeof openElectronDatabase>,
  table:
    | "meetings"
    | "processing_jobs"
    | "meeting_notes"
    | "durable_receipts"
    | "result_publications",
): number {
  return Number(
    database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
  );
}

describe("startup reconciliation", () => {
  it("marks running work interrupted and never automatically retries it", () => {
    const { database, meetingCommand, repository, service } = openService();
    try {
      const { job } = seedMeetingAndJob(service, meetingCommand);
      service.claimNextProcessingJob({
        sourceIdentity: "worker:orphaned",
        deadlineAtMs: 5000,
      });

      expect(service.reconcileStartup()).toBe(1);
      expect(repository.findJob(job.value.id)).toEqual(
        expect.objectContaining({
          state: "interrupted",
          errorCode: "PROCESS_INTERRUPTED",
          attempt: 1,
        }),
      );
      expect(
        service.claimNextProcessingJob({
          sourceIdentity: "worker:must-not-auto-retry",
          deadlineAtMs: 6000,
        }),
      ).toBeNull();
      expect(service.reconcileStartup()).toBe(0);
    } finally {
      database.close();
    }
  });
});
