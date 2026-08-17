import path from "node:path";

import {
  captureControlCommandSchema,
  capturePreflightSchema,
  captureSnapshotSchema,
  captureStartCommandSchema,
  type CaptureControlCommand,
  type CapturePreflight,
  type CaptureSnapshot,
  type CaptureStartCommand,
} from "../../../shared/contracts";
import type { CaptureRepository } from "../../storage/repositories/capture_repository";
import type { CaptureNativePort } from "./capture_native_port";
import {
  validateCaptureAuthority,
  type CaptureAuthority,
} from "./capture_authority";

export class DesktopCaptureService {
  private currentSessionId: string | null = null;

  constructor(
    private readonly repository: CaptureRepository,
    private readonly native: CaptureNativePort,
    private readonly captureRoot: string,
    private readonly now: () => number = Date.now,
    private readonly authorityValidator: typeof validateCaptureAuthority = validateCaptureAuthority,
  ) {}

  async preflight(command: {
    minimumFreeBytes: number;
    captionModelAvailable: boolean;
    requestPermissions: boolean;
  }): Promise<CapturePreflight> {
    return capturePreflightSchema.parse(await this.native.preflight(command));
  }

  async start(raw: CaptureStartCommand): Promise<CaptureSnapshot> {
    const command = captureStartCommandSchema.parse(raw);
    const cached = this.cached(
      command.sessionId,
      command.idempotencyKey,
      "start",
    );
    if (cached) return cached;
    if (this.repository.hasActionReceipt(command.sessionId, "start")) {
      throw new Error("capture start idempotency conflict");
    }
    this.repository.beginSession({
      sessionId: command.sessionId,
      title: command.title,
      workspacePath: path.join(this.captureRoot, command.sessionId),
      nowMs: this.now(),
    });
    let result: CaptureSnapshot;
    try {
      result = captureSnapshotSchema.parse(await this.native.start(command));
    } catch {
      try {
        result = captureSnapshotSchema.parse(
          await this.native.snapshot(command.sessionId),
        );
      } catch {
        result = captureSnapshotSchema.parse({
          sessionId: command.sessionId,
          state: "failed",
          captureMode: "dual_track",
          captureTimelineMs: 0,
          systemAudioHealthy: false,
          microphoneHealthy: false,
          partialCapture: false,
          finalizedChunkCount: 0,
          eventCount: 0,
          gapCount: 0,
          interruptionReason: "native_start_failed",
          recordingSha256: null,
          journalSha256: null,
        });
      }
    }
    this.assertSession(command.sessionId, result);
    this.currentSessionId = result.sessionId;
    return this.repository.saveSnapshotAndReceipt(
      result,
      "start",
      command.idempotencyKey,
      this.now(),
    );
  }

  async control(raw: CaptureControlCommand): Promise<CaptureSnapshot> {
    const command = captureControlCommandSchema.parse(raw);
    const cached = this.cached(
      command.sessionId,
      command.idempotencyKey,
      command.action,
    );
    if (cached) return cached;
    const result = captureSnapshotSchema.parse(
      await this.native[command.action](command),
    );
    this.assertSession(command.sessionId, result);
    const authority =
      command.action === "stop" &&
      (result.state === "completed" || result.state === "partial_capture")
        ? await this.validatedAuthority(result)
        : undefined;
    return this.repository.saveSnapshotAndReceipt(
      result,
      command.action,
      command.idempotencyKey,
      this.now(),
      authority,
    );
  }

  async lifecycle(
    action: "system-sleep" | "system-wake",
    sessionId: string,
    idempotencyKey: string,
  ): Promise<CaptureSnapshot> {
    const cached = this.cached(sessionId, idempotencyKey, action);
    if (cached) return cached;
    const command = captureControlCommandSchema.parse({
      action: action === "system-sleep" ? "pause" : "resume",
      sessionId,
      idempotencyKey,
    });
    const nativeAction =
      action === "system-sleep" ? "systemSleep" : "systemWake";
    const result = captureSnapshotSchema.parse(
      await this.native[nativeAction](command),
    );
    this.assertSession(sessionId, result);
    return this.repository.saveSnapshotAndReceipt(
      result,
      action,
      idempotencyKey,
      this.now(),
    );
  }

  nextLifecycleIdempotencyKey(
    action: "system-sleep" | "system-wake",
    sessionId: string,
  ): string {
    return `${action}-${sessionId}-${this.repository.nextActionSequence(sessionId, action)}`;
  }

  snapshot(): CaptureSnapshot | null {
    return this.currentSessionId
      ? this.repository.find(this.currentSessionId)
      : this.repository.active();
  }

  async refresh(sessionId: string): Promise<CaptureSnapshot> {
    const result = captureSnapshotSchema.parse(
      await this.native.snapshot(sessionId),
    );
    this.assertSession(sessionId, result);
    if (
      (result.state === "completed" || result.state === "partial_capture") &&
      result.recordingSha256 &&
      !this.repository.hasActionReceipt(sessionId, "stop")
    ) {
      const authority = await this.validatedAuthority(result);
      return this.repository.saveSnapshotAndReceipt(
        result,
        "stop",
        `native-terminal-${result.journalSha256}`,
        this.now(),
        authority,
      );
    }
    return this.repository.saveSnapshot(result, this.now());
  }

  async recover(): Promise<CaptureSnapshot[]> {
    const values = captureSnapshotSchema
      .array()
      .max(256)
      .parse(await this.native.recover());
    for (const value of values) {
      if (!this.repository.find(value.sessionId)) {
        this.repository.beginSession({
          sessionId: value.sessionId,
          title: "中断的音频录制",
          workspacePath: path.join(this.captureRoot, value.sessionId),
          nowMs: this.now(),
        });
      }
      const key = `recover-${value.journalSha256 ?? value.sessionId}`;
      if (value.state === "completed") {
        const completedKey = `recover-completed-${value.journalSha256}`;
        if (!this.repository.receipt(value.sessionId, completedKey)) {
          const authority = await this.validatedAuthority(value);
          this.repository.saveSnapshotAndReceipt(
            value,
            "stop",
            completedKey,
            this.now(),
            authority,
          );
        }
      } else if (!this.repository.receipt(value.sessionId, key)) {
        const authority =
          value.finalizedChunkCount > 0
            ? await this.validatedAuthority(value)
            : undefined;
        this.repository.saveSnapshotAndReceipt(
          value,
          "recover",
          key,
          this.now(),
          authority,
        );
      }
    }
    return values;
  }

  listRecoveries(): CaptureSnapshot[] {
    return this.repository.listRecoveries();
  }

  async discardRecovered(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const cached = this.repository.receipt(sessionId, idempotencyKey);
    if (cached) {
      if (cached.action !== "discard")
        throw new Error("capture idempotency conflict");
      return;
    }
    await this.native.discard(sessionId, idempotencyKey);
    this.repository.discardRecoveryAndReceipt(
      sessionId,
      idempotencyKey,
      this.now(),
    );
  }

  keepRecovered(sessionId: string, idempotencyKey: string): CaptureSnapshot {
    const cached = this.cached(sessionId, idempotencyKey, "keep");
    if (cached) return cached;
    return this.repository.keepRecoveryAndReceipt(
      sessionId,
      idempotencyKey,
      this.now(),
    );
  }

  private cached(
    sessionId: string,
    idempotencyKey: string,
    action: string,
  ): CaptureSnapshot | null {
    const receipt = this.repository.receipt(sessionId, idempotencyKey);
    if (!receipt) return null;
    if (receipt.action !== action)
      throw new Error("capture idempotency conflict");
    return receipt.result;
  }

  private assertSession(expected: string, snapshot: CaptureSnapshot): void {
    if (snapshot.sessionId !== expected) {
      throw new Error("capture helper returned the wrong session");
    }
  }

  private async validatedAuthority(
    snapshot: CaptureSnapshot,
  ): Promise<CaptureAuthority> {
    if (!snapshot.journalSha256) {
      throw new Error("capture helper omitted its journal hash");
    }
    return await this.authorityValidator({
      captureRoot: this.captureRoot,
      sessionId: snapshot.sessionId,
      expectedJournalSha256: snapshot.journalSha256,
    });
  }
}
