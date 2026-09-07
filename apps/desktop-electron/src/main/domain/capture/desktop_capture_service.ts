import path from "node:path";

import {
  captureControlCommandSchema,
  capturePreflightSchema,
  captureRuntimeSnapshotSchema,
  captureSnapshotSchema,
  captureStartCommandSchema,
  captureTitleSchema,
  type CaptureControlCommand,
  type CapturePreflight,
  type CaptureRecoveryItem,
  type CaptureRuntimeSnapshot,
  type CaptureSnapshot,
  type CaptureStartCommand,
  type SuggestCaptureTitleResponse,
} from "../../../shared/contracts";
import type {
  CaptureRepository,
  StoredCaptureSession,
} from "../../storage/repositories/capture_repository";
import {
  CaptureNativeStopError,
  type CaptureNativePort,
} from "./capture_native_port";
import {
  validateCaptureAuthority,
  type CaptureAuthority,
} from "./capture_authority";

export class DesktopCaptureService {
  private currentSessionId: string | null = null;
  private currentAudioActivity = 0;

  constructor(
    private readonly repository: CaptureRepository,
    private readonly native: CaptureNativePort,
    private readonly captureRoot: string,
    private readonly now: () => number = Date.now,
    private readonly authorityValidator: typeof validateCaptureAuthority = validateCaptureAuthority,
    private readonly captureDay: typeof localCaptureDay = localCaptureDay,
  ) {}

  async preflight(command: {
    minimumFreeBytes: number;
    captionModelAvailable: boolean;
    requestPermissions: boolean;
  }): Promise<CapturePreflight> {
    return capturePreflightSchema.parse(await this.native.preflight(command));
  }

  async start(
    raw: CaptureStartCommand,
    options: { refreshSuggestedTitle?: boolean } = {},
  ): Promise<CaptureSnapshot> {
    const parsed = captureStartCommandSchema.parse(raw);
    const cached = this.cached(
      parsed.sessionId,
      parsed.idempotencyKey,
      "start",
    );
    if (cached) return cached;
    if (this.repository.hasActionReceipt(parsed.sessionId, "start")) {
      throw new Error("capture start idempotency conflict");
    }
    const startNowMs = this.now();
    const command = {
      ...parsed,
      title: options.refreshSuggestedTitle
        ? this.titleSuggestionAt(startNowMs)
        : parsed.title,
    };
    this.repository.beginSession({
      sessionId: command.sessionId,
      title: command.title,
      workspacePath: path.join(this.captureRoot, command.sessionId),
      nowMs: startNowMs,
    });
    let result: CaptureSnapshot;
    try {
      result = this.acceptRuntime(await this.native.start(command));
    } catch {
      try {
        result = this.acceptRuntime(
          await this.native.snapshot(command.sessionId),
        );
      } catch {
        this.currentAudioActivity = 0;
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
    const result = this.acceptRuntime(
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

  async stopAndReconcile(
    raw: CaptureControlCommand,
  ): Promise<CaptureStopReconciliation> {
    const command = captureControlCommandSchema.parse(raw);
    if (command.action !== "stop") {
      throw new Error("stop reconciliation requires a stop command");
    }
    const cached = this.cached(
      command.sessionId,
      command.idempotencyKey,
      "stop",
    );
    if (cached) {
      return {
        snapshot: cached,
        capability: "recovered-terminal",
      };
    }
    try {
      const snapshot = await this.control(command);
      return {
        snapshot,
        capability: "recovered-terminal",
      };
    } catch (error) {
      if (!(error instanceof CaptureNativeStopError)) throw error;
      return error.kind === "command"
        ? await this.reconcileOnLiveSession(
            command.sessionId,
            command,
          )
        : await this.reconcileAfterTransportLoss(
            command.sessionId,
            command,
          );
    }
  }

  abortNativeSession(): void {
    this.native.abort?.();
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
    const result = this.acceptRuntime(await this.native[nativeAction](command));
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

  audioActivity(): number {
    return this.currentAudioActivity;
  }

  suggestCaptureTitle(): SuggestCaptureTitleResponse {
    const title = this.titleSuggestionAt(this.now());
    return { title };
  }

  sessionTitle(sessionId: string): string {
    const title = this.repository.sessionTitle(sessionId);
    if (!title) throw new Error("capture session title is unavailable");
    return title;
  }

  renameSession(sessionId: string, title: string): StoredCaptureSession {
    const currentSessionId =
      this.currentSessionId ??
      this.repository.activeSession()?.snapshot.sessionId ??
      this.repository.firstRecoverySessionId() ??
      null;
    if (sessionId !== currentSessionId) {
      throw new Error("rename must target the current capture session");
    }
    return this.repository.renameSessionTitle(
      sessionId,
      captureTitleSchema.parse(title),
      this.now(),
    );
  }

  async refresh(sessionId: string): Promise<CaptureSnapshot> {
    let result: CaptureSnapshot;
    try {
      result = this.acceptRuntime(await this.native.snapshot(sessionId));
    } catch (error) {
      this.currentAudioActivity = 0;
      throw error;
    }
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
          title: `新录音-${value.sessionId.slice(-12)}`,
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
    this.selectCurrentSession();
    return values;
  }

  listRecoveries(): CaptureRecoveryItem[] {
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
      this.selectCurrentSession();
      return;
    }
    await this.native.discard(sessionId, idempotencyKey);
    this.repository.discardRecoveryAndReceipt(
      sessionId,
      idempotencyKey,
      this.now(),
    );
    this.selectCurrentSession();
  }

  keepRecovered(sessionId: string, idempotencyKey: string): CaptureSnapshot {
    const cached = this.cached(sessionId, idempotencyKey, "keep");
    if (cached) {
      this.selectCurrentSession();
      return cached;
    }
    const result = this.repository.keepRecoveryAndReceipt(
      sessionId,
      idempotencyKey,
      this.now(),
    );
    this.selectCurrentSession();
    return result;
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

  private titleSuggestionAt(nowMs: number): string {
    const day = this.captureDay(nowMs);
    const sequence =
      this.repository.countSessionsCreatedBetween(day.startMs, day.endMs) + 1;
    return `新录音${day.dateStamp}${String(sequence).padStart(2, "0")}`;
  }

  private selectCurrentSession(): void {
    this.currentSessionId =
      this.repository.firstRecoverySessionId() ??
      this.repository.activeSession()?.snapshot.sessionId ??
      null;
  }

  private assertSession(expected: string, snapshot: CaptureSnapshot): void {
    if (snapshot.sessionId !== expected) {
      throw new Error("capture helper returned the wrong session");
    }
  }

  private acceptRuntime(raw: CaptureRuntimeSnapshot): CaptureSnapshot {
    const runtime = captureRuntimeSnapshotSchema.parse(raw);
    const { audioActivity, ...durable } = runtime;
    this.currentAudioActivity =
      (runtime.state === "recording" || runtime.state === "partial_capture") &&
      (runtime.systemAudioHealthy || runtime.microphoneHealthy)
        ? audioActivity
        : 0;
    return captureSnapshotSchema.parse(durable);
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

  private async reconcileOnLiveSession(
    sessionId: string,
    command: CaptureControlCommand,
  ): Promise<CaptureStopReconciliation> {
    try {
      const snapshot = this.acceptRuntime(
        await this.native.snapshot(sessionId),
      );
      this.assertSession(sessionId, snapshot);
      return await this.persistStopReconciliation(
        snapshot,
        command,
        true,
      );
    } catch {
      this.currentAudioActivity = 0;
      return { snapshot: null, capability: "unknown" };
    }
  }

  private async reconcileAfterTransportLoss(
    sessionId: string,
    command: CaptureControlCommand,
  ): Promise<CaptureStopReconciliation> {
    if (!this.native.recreateAfterTransportLoss) {
      return { snapshot: null, capability: "unknown" };
    }
    try {
      await this.native.recreateAfterTransportLoss();
      const recovered = captureSnapshotSchema
        .array()
        .max(256)
        .parse(await this.native.recover())
        .find((snapshot) => snapshot.sessionId === sessionId);
      if (!recovered) {
        return { snapshot: null, capability: "unknown" };
      }
      return await this.persistStopReconciliation(
        recovered,
        command,
        false,
      );
    } catch {
      this.currentAudioActivity = 0;
      return { snapshot: null, capability: "unknown" };
    }
  }

  private async persistStopReconciliation(
    snapshot: CaptureSnapshot,
    command: CaptureControlCommand,
    originalSessionIsLive: boolean,
  ): Promise<CaptureStopReconciliation> {
    if (isDurableTerminal(snapshot)) {
      const authority = await this.validatedAuthority(snapshot);
      const stored = this.repository.saveSnapshotAndReceipt(
        snapshot,
        "stop",
        command.idempotencyKey,
        this.now(),
        authority,
      );
      return {
        snapshot: stored,
        capability: "recovered-terminal",
      };
    }
    if (snapshot.state === "recoverable" || snapshot.state === "failed") {
      const recoveryKey = `stop-reconcile-${snapshot.journalSha256 ?? snapshot.sessionId}`;
      const prior = this.repository.receipt(snapshot.sessionId, recoveryKey);
      if (prior) {
        return {
          snapshot: prior.result,
          capability: "recovered-terminal",
        };
      }
      const authority =
        snapshot.finalizedChunkCount > 0
          ? await this.validatedAuthority(snapshot)
          : undefined;
      const stored = this.repository.saveSnapshotAndReceipt(
        snapshot,
        "recover",
        recoveryKey,
        this.now(),
        authority,
      );
      return {
        snapshot: stored,
        capability: "recovered-terminal",
      };
    }
    const stored = this.repository.saveSnapshot(snapshot, this.now());
    return {
      snapshot: stored,
      capability:
        originalSessionIsLive && isLiveStoppable(snapshot)
          ? "live-stoppable"
          : "unknown",
    };
  }
}

export type CaptureStopCapability =
  "live-stoppable" | "recovered-terminal" | "unknown";

export interface CaptureStopReconciliation {
  snapshot: CaptureSnapshot | null;
  capability: CaptureStopCapability;
}

export function isDurableTerminal(snapshot: CaptureSnapshot): boolean {
  return (
    (snapshot.state === "completed" || snapshot.state === "partial_capture") &&
    snapshot.recordingSha256 !== null
  );
}

function isLiveStoppable(snapshot: CaptureSnapshot): boolean {
  return (
    snapshot.state === "recording" ||
    snapshot.state === "paused" ||
    (snapshot.state === "partial_capture" && snapshot.recordingSha256 === null)
  );
}

export function localCaptureDay(nowMs: number): {
  startMs: number;
  endMs: number;
  dateStamp: string;
} {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("capture title clock is invalid");
  }
  const current = new Date(nowMs);
  const year = current.getFullYear();
  const month = current.getMonth();
  const day = current.getDate();
  return {
    startMs: new Date(year, month, day).getTime(),
    endMs: new Date(year, month, day + 1).getTime(),
    dateStamp: `${String(year).padStart(4, "0")}${String(month + 1).padStart(2, "0")}${String(day).padStart(2, "0")}`,
  };
}
