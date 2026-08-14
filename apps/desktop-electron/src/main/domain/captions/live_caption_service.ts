import type { CaptionSnapshot } from "../../../shared/contracts";
import type {
  DraftExecutionIdentity,
  TranscriptRepository,
} from "../../storage/repositories/transcript_repository";
import type {
  AdaptedCaptionWorkerEvent,
  CaptionWorkerFence,
} from "../../processes/caption_worker_protocol";

export interface LiveCaptionWorkerSession {
  poll(): Promise<{
    offsetBytes: number;
    backlogBytes: number;
  }>;
  flush(): Promise<{
    offsetBytes: number;
    backlogBytes: number;
  }>;
  close(): Promise<void>;
}

export interface LiveCaptionWorkerLauncher {
  launch(options: {
    sessionRoot: string;
    fence: CaptionWorkerFence;
    offsetBytes: number;
    firstSequence: number;
    onUtterance: (
      event: Extract<AdaptedCaptionWorkerEvent, { type: "utterance" }>,
    ) => void | Promise<void>;
    onSilence: (
      event: Extract<AdaptedCaptionWorkerEvent, { type: "silence" }>,
    ) => void | Promise<void>;
  }): Promise<LiveCaptionWorkerSession>;
}

interface ActiveCaption {
  sessionId: string;
  generationId: number;
  attempt: number;
  worker: LiveCaptionWorkerSession;
}

export class LiveCaptionService {
  private active: ActiveCaption | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: TranscriptRepository,
    private readonly launcher: LiveCaptionWorkerLauncher,
    private readonly emit: (snapshot: CaptionSnapshot) => void,
    private readonly now: () => number = Date.now,
  ) {}

  reconcileStartup(): number {
    return this.repository.reconcileStartup(this.now());
  }

  async start(
    command: DraftExecutionIdentity & { sessionRoot: string },
  ): Promise<CaptionSnapshot> {
    return await this.serialize(() => this.startActive(command));
  }

  private async startActive(
    command: DraftExecutionIdentity & { sessionRoot: string },
  ): Promise<CaptionSnapshot> {
    if (this.active) {
      if (this.active.sessionId !== command.sessionId) {
        throw new Error("a different live-caption session is active");
      }
      return this.requireSnapshot(command.sessionId);
    }
    let draft = this.repository.createOrResumeDraft({
      ...command,
      nowMs: this.now(),
    });
    if (draft.state === "flushed") {
      return this.requireSnapshot(command.sessionId);
    }
    if (draft.state !== "preparing") {
      const next = this.repository.beginWorkerAttempt(
        command.sessionId,
        draft.generationId,
        this.now(),
      );
      draft = { ...draft, ...next, state: "preparing" };
    }
    const fence: CaptionWorkerFence = {
      sessionId: command.sessionId,
      generationId: draft.generationId,
      attempt: draft.attempt,
      modelSha256: command.modelSha256,
    };
    try {
      const worker = await this.launcher.launch({
        sessionRoot: command.sessionRoot,
        fence,
        offsetBytes: draft.offsetBytes,
        firstSequence: draft.firstSequence,
        onUtterance: async (event) => {
          this.repository.appendDraftUtterance({
            sessionId: event.sessionId,
            generationId: event.generationId,
            attempt: event.attempt,
            sequence: event.sequence,
            startMs: event.startMs,
            endMs: event.endMs,
            text: event.text,
            language: event.language,
            workerOffsetBytes: event.offsetBytes,
            modelSha256: event.modelSha256,
            nowMs: this.now(),
          });
          this.publish(event.sessionId);
        },
        onSilence: async (event) => {
          this.repository.advanceDraftSilence({
            sessionId: event.sessionId,
            generationId: event.generationId,
            attempt: event.attempt,
            sequence: event.sequence,
            startMs: event.startMs,
            endMs: event.endMs,
            workerOffsetBytes: event.offsetBytes,
            modelSha256: event.modelSha256,
            nowMs: this.now(),
          });
        },
      });
      this.active = {
        sessionId: command.sessionId,
        generationId: draft.generationId,
        attempt: draft.attempt,
        worker,
      };
      this.repository.markDraftState({
        sessionId: command.sessionId,
        generationId: draft.generationId,
        attempt: draft.attempt,
        state: "running",
        errorCode: null,
        nowMs: this.now(),
      });
    } catch {
      this.repository.markDraftState({
        sessionId: command.sessionId,
        generationId: draft.generationId,
        attempt: draft.attempt,
        state: "degraded",
        errorCode: "CAPTION_WORKER_START_FAILED",
        nowMs: this.now(),
      });
    }
    return this.publish(command.sessionId);
  }

  async poll(sessionId: string): Promise<CaptionSnapshot | null> {
    return await this.serialize(() => this.pollActive(sessionId));
  }

  async pause(sessionId: string): Promise<CaptionSnapshot | null> {
    return await this.serialize(() => this.transition(sessionId, "paused"));
  }

  async resume(sessionId: string): Promise<CaptionSnapshot | null> {
    return await this.serialize(() => this.transition(sessionId, "running"));
  }

  async flush(sessionId: string): Promise<CaptionSnapshot | null> {
    return await this.serialize(() => this.flushActive(sessionId));
  }

  private async pollActive(sessionId: string): Promise<CaptionSnapshot | null> {
    const active = this.active;
    if (!active || active.sessionId !== sessionId) {
      return this.repository.getSnapshot(sessionId);
    }
    try {
      const progress = await active.worker.poll();
      if (progress.backlogBytes > 960_000) {
        this.repository.updateProgress({
          sessionId,
          generationId: active.generationId,
          attempt: active.attempt,
          offsetBytes: progress.offsetBytes,
          backlogBytes: 960_000,
          state: "running",
          nowMs: this.now(),
        });
        await this.degrade(active, "CAPTION_BACKLOG_EXCEEDED");
        return this.publish(sessionId);
      }
      this.repository.updateProgress({
        sessionId,
        generationId: active.generationId,
        attempt: active.attempt,
        offsetBytes: progress.offsetBytes,
        backlogBytes: progress.backlogBytes,
        state: "running",
        nowMs: this.now(),
      });
    } catch {
      await this.degrade(active, "CAPTION_WORKER_FAILED");
    }
    return this.publish(sessionId);
  }

  private async flushActive(
    sessionId: string,
  ): Promise<CaptionSnapshot | null> {
    const active = this.active;
    if (!active || active.sessionId !== sessionId) {
      return this.repository.getSnapshot(sessionId);
    }
    this.repository.markDraftState({
      sessionId,
      generationId: active.generationId,
      attempt: active.attempt,
      state: "flushing",
      errorCode: null,
      nowMs: this.now(),
    });
    try {
      const progress = await active.worker.flush();
      if (progress.backlogBytes > 960_000) {
        this.repository.updateProgress({
          sessionId,
          generationId: active.generationId,
          attempt: active.attempt,
          offsetBytes: progress.offsetBytes,
          backlogBytes: 960_000,
          state: "flushing",
          nowMs: this.now(),
        });
        await this.degrade(active, "CAPTION_BACKLOG_EXCEEDED");
        return this.publish(sessionId);
      }
      this.repository.updateProgress({
        sessionId,
        generationId: active.generationId,
        attempt: active.attempt,
        offsetBytes: progress.offsetBytes,
        backlogBytes: progress.backlogBytes,
        state: "flushed",
        nowMs: this.now(),
      });
      await active.worker.close();
      this.active = null;
    } catch {
      await this.degrade(active, "CAPTION_FLUSH_FAILED");
    }
    return this.publish(sessionId);
  }

  async shutdown(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await this.flush(active.sessionId);
  }

  private transition(
    sessionId: string,
    state: "paused" | "running",
  ): CaptionSnapshot | null {
    const active = this.active;
    if (!active || active.sessionId !== sessionId) {
      return this.repository.getSnapshot(sessionId);
    }
    this.repository.markDraftState({
      sessionId,
      generationId: active.generationId,
      attempt: active.attempt,
      state,
      errorCode: null,
      nowMs: this.now(),
    });
    return this.publish(sessionId);
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async degrade(
    active: ActiveCaption,
    errorCode: string,
  ): Promise<void> {
    this.repository.markDraftState({
      sessionId: active.sessionId,
      generationId: active.generationId,
      attempt: active.attempt,
      state: "degraded",
      errorCode,
      nowMs: this.now(),
    });
    this.active = null;
    await active.worker.close().catch(() => undefined);
  }

  private publish(sessionId: string): CaptionSnapshot {
    const snapshot = this.requireSnapshot(sessionId);
    this.emit(snapshot);
    return snapshot;
  }

  private requireSnapshot(sessionId: string): CaptionSnapshot {
    const snapshot = this.repository.getSnapshot(sessionId);
    if (!snapshot) throw new Error("caption snapshot is unavailable");
    return snapshot;
  }
}
