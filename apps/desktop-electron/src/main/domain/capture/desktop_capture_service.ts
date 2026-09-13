import path from "node:path";
import { lstatSync, readdirSync, realpathSync } from "node:fs";

import {
  captureControlCommandSchema,
  capturePreflightSchema,
  captureRecoveryActionRequestSchema,
  captureRecoveryActionResponseSchema,
  captureRecoveryItemSchema,
  captureRuntimeSnapshotSchema,
  captureSnapshotSchema,
  captureStartCommandSchema,
  captureTitleSchema,
  type CaptureControlCommand,
  type CapturePreflight,
  type CaptureRecoveryItem,
  type CaptureRecoveryActionRequest,
  type CaptureRecoveryActionResponse,
  type CaptureRecoveryOutcome,
  type CaptureRuntimeSnapshot,
  type CaptureSnapshot,
  type CaptureStartCommand,
  type SuggestCaptureTitleResponse,
} from "../../../shared/contracts";
import type {
  CaptureRepository,
  StoredCaptureRecovery,
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
  private recoveryProjectionSessionId: string | null = null;
  private currentAudioActivity = 0;
  private recoveryScanComplete = false;
  private readonly nativeRecoveries = new Map<string, CaptureSnapshot>();
  private readonly recoveryActions = new Map<
    string,
    Promise<CaptureRecoveryOutcome>
  >();

  constructor(
    private readonly repository: CaptureRepository,
    private readonly native: CaptureNativePort,
    private readonly captureRoot: string,
    private readonly now: () => number = Date.now,
    private readonly authorityValidator: typeof validateCaptureAuthority = validateCaptureAuthority,
    private readonly captureDay: typeof localCaptureDay = localCaptureDay,
    private readonly inspectWorkspace: typeof inspectCaptureRecoveryWorkspace = inspectCaptureRecoveryWorkspace,
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
        ? await this.reconcileOnLiveSession(command.sessionId, command)
        : await this.reconcileAfterTransportLoss(command.sessionId, command);
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
    if (this.currentSessionId) {
      return this.repository.find(this.currentSessionId);
    }
    if (this.recoveryScanComplete) {
      return this.recoveryProjectionSessionId
        ? this.repository.find(this.recoveryProjectionSessionId)
        : null;
    }
    return this.repository.active();
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
      this.currentSessionId ?? this.recoveryProjectionSessionId ?? null;
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
      isDurableTerminal(result) &&
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
    await this.cleanupDiscardedRecoveries();
    const values = captureSnapshotSchema
      .array()
      .max(256)
      .parse(await this.native.recover());
    const accepted: CaptureSnapshot[] = [];
    this.nativeRecoveries.clear();
    for (const value of values) {
      if (!this.repository.find(value.sessionId)) continue;
      accepted.push(value);
      this.nativeRecoveries.set(value.sessionId, value);
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
    this.recoveryScanComplete = true;
    await this.refreshRecoveryProjection();
    return accepted;
  }

  async listRecoveries(): Promise<CaptureRecoveryItem[]> {
    const recoveries: CaptureRecoveryItem[] = [];
    for (const candidate of this.repository.listRecoveryCandidates()) {
      recoveries.push(await this.assessRecovery(candidate));
    }
    return recoveries;
  }

  async actOnRecoveries(
    raw: CaptureRecoveryActionRequest,
  ): Promise<CaptureRecoveryActionResponse> {
    const request = captureRecoveryActionRequestSchema.parse(raw);
    const outcomes: CaptureRecoveryOutcome[] = [];
    for (const sessionId of request.sessionIds) {
      outcomes.push(
        await this.runRecoveryAction(
          sessionId,
          request.action,
          request.intent,
          request.idempotencyKey,
        ),
      );
    }
    const recoveries = await this.listRecoveries();
    this.refreshRecoveryProjectionFrom(recoveries);
    return captureRecoveryActionResponseSchema.parse({
      outcomes,
      recoveries,
    });
  }

  async discardRecovered(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.discardRecoveredWithoutProjectionRefresh(
      sessionId,
      idempotencyKey,
    );
    await this.refreshRecoveryProjection();
  }

  private async discardRecoveredWithoutProjectionRefresh(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const cached = this.repository.receipt(sessionId, idempotencyKey);
    if (cached) {
      if (cached.action !== "discard")
        throw new Error("capture idempotency conflict");
      return;
    }
    this.repository.discardRecoveryAndReceipt(
      sessionId,
      idempotencyKey,
      this.now(),
    );
    try {
      await this.native.discard(sessionId, idempotencyKey);
    } catch {
      console.error(
        JSON.stringify({
          event: "capture-recovery-cleanup-deferred",
          operation: "discard",
          sessionId,
          occurredAtMs: this.now(),
        }),
      );
    }
  }

  keepRecovered(sessionId: string, idempotencyKey: string): CaptureSnapshot {
    const cached = this.cached(sessionId, idempotencyKey, "keep");
    if (cached) {
      if (this.recoveryProjectionSessionId === sessionId) {
        this.recoveryProjectionSessionId = null;
      }
      return cached;
    }
    const result = this.repository.keepRecoveryAndReceipt(
      sessionId,
      idempotencyKey,
      this.now(),
    );
    if (this.recoveryProjectionSessionId === sessionId) {
      this.recoveryProjectionSessionId = null;
    }
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

  private async runRecoveryAction(
    sessionId: string,
    action: "keep" | "discard",
    intent: CaptureRecoveryActionRequest["intent"],
    idempotencyKey: string,
  ): Promise<CaptureRecoveryOutcome> {
    const inFlight = this.recoveryActions.get(sessionId);
    if (inFlight) {
      const settled = await inFlight;
      return settled.action === action
        ? settled
        : recoveryOutcome(sessionId, action, "conflict");
    }
    const operation = this.executeRecoveryAction(
      sessionId,
      action,
      intent,
      idempotencyKey,
    ).finally(() => {
      if (this.recoveryActions.get(sessionId) === operation) {
        this.recoveryActions.delete(sessionId);
      }
    });
    this.recoveryActions.set(sessionId, operation);
    return await operation;
  }

  private async executeRecoveryAction(
    sessionId: string,
    action: "keep" | "discard",
    intent: CaptureRecoveryActionRequest["intent"],
    idempotencyKey: string,
  ): Promise<CaptureRecoveryOutcome> {
    const cached = this.repository.receipt(sessionId, idempotencyKey);
    if (cached) {
      if (cached.action !== action) {
        return recoveryOutcome(sessionId, action, "conflict");
      }
      return recoveryOutcome(
        sessionId,
        action,
        action === "keep" ? "kept" : "discarded",
        cached.result,
      );
    }
    const candidate = this.repository.findRecoveryCandidate(sessionId);
    if (!candidate) return recoveryOutcome(sessionId, action, "conflict");
    const assessed = await this.assessRecovery(candidate);
    if (
      assessed.capability === "preserve-only" ||
      (intent === "automatic-discard-only-cleanup" &&
        assessed.capability !== "discard-only") ||
      (action === "keep" && assessed.capability !== "restorable")
    ) {
      return recoveryOutcome(sessionId, action, "preserved");
    }
    try {
      if (action === "discard") {
        await this.discardRecoveredWithoutProjectionRefresh(
          sessionId,
          idempotencyKey,
        );
        return recoveryOutcome(sessionId, action, "discarded");
      }
      const kept = this.keepRecovered(sessionId, idempotencyKey);
      return recoveryOutcome(sessionId, action, "kept", kept);
    } catch {
      return recoveryOutcome(sessionId, action, "failed");
    }
  }

  private async assessRecovery(
    candidate: StoredCaptureRecovery,
  ): Promise<CaptureRecoveryItem> {
    const snapshot = this.nativeRecoveries.get(candidate.snapshot.sessionId);
    const base = candidate.snapshot;
    const item = (
      capability: CaptureRecoveryItem["capability"],
      reason: CaptureRecoveryItem["reason"],
    ) =>
      captureRecoveryItemSchema.parse({
        ...base,
        title: candidate.title,
        capability,
        reason,
      });
    if (!this.recoveryScanComplete) {
      return item("preserve-only", "currently-unverifiable");
    }
    if (!snapshot) {
      return item("preserve-only", "recovery-metadata-damaged");
    }
    if (
      ["preparing", "recording", "paused", "finalizing"].includes(base.state)
    ) {
      return item("preserve-only", "finalization-in-progress");
    }
    const workspace = this.inspectWorkspace({
      captureRoot: this.captureRoot,
      sessionId: base.sessionId,
      workspacePath: candidate.workspacePath,
    });
    if (!workspace.complete) {
      return item("preserve-only", "currently-unverifiable");
    }
    if (
      snapshot.state !== base.state ||
      snapshot.finalizedChunkCount !== base.finalizedChunkCount ||
      snapshot.journalSha256 !== base.journalSha256
    ) {
      return item("preserve-only", "currently-unverifiable");
    }
    if (
      (snapshot.invalidFinalizedChunks ?? 0) > 0 ||
      (snapshot.quarantinedTailChunks ?? 0) > 0 ||
      workspace.hasQuarantine
    ) {
      return item("preserve-only", "audio-integrity-failed");
    }
    if (snapshot.finalizedChunkCount === 0) {
      if (!workspace.journalPresent) {
        return item("preserve-only", "recovery-metadata-damaged");
      }
      return workspace.audioFiles.length > 0 || workspace.hasPartial
        ? item("preserve-only", "unfinished-audio-data")
        : item("discard-only", "no-audio-data");
    }
    if (
      snapshot.state !== "recoverable" &&
      snapshot.state !== "partial_capture"
    ) {
      return item("preserve-only", "currently-unverifiable");
    }
    try {
      const authority = await this.validatedAuthority(snapshot);
      const referenced = new Set(
        authority.chunks.map((chunk) =>
          normalizeRelativePath(chunk.relativePath),
        ),
      );
      if (
        authority.sessionId !== snapshot.sessionId ||
        authority.chunks.length !== snapshot.finalizedChunkCount ||
        !this.repository.hasRecoveryAuthority(
          snapshot.sessionId,
          snapshot.finalizedChunkCount,
        ) ||
        workspace.hasPartial ||
        workspace.audioFiles.some((file) => !referenced.has(file))
      ) {
        return item("preserve-only", "unfinished-audio-data");
      }
      return item("restorable", null);
    } catch {
      return item("preserve-only", "audio-integrity-failed");
    }
  }

  private async cleanupDiscardedRecoveries(): Promise<void> {
    for (const sessionId of this.repository.listDiscardedRecoverySessionIds()) {
      try {
        await this.native.discard(sessionId, `cleanup-${sessionId}`);
      } catch {
        console.error(
          JSON.stringify({
            event: "capture-recovery-cleanup-deferred",
            operation: "startup-cleanup",
            sessionId,
            occurredAtMs: this.now(),
          }),
        );
      }
    }
  }

  private titleSuggestionAt(nowMs: number): string {
    const day = this.captureDay(nowMs);
    const sequence =
      this.repository.countSessionsCreatedBetween(day.startMs, day.endMs) + 1;
    return `新录音${day.dateStamp}${String(sequence).padStart(2, "0")}`;
  }

  private async refreshRecoveryProjection(): Promise<void> {
    if (!this.recoveryScanComplete) return;
    this.refreshRecoveryProjectionFrom(await this.listRecoveries());
  }

  private refreshRecoveryProjectionFrom(
    recoveries: CaptureRecoveryItem[],
  ): void {
    this.recoveryProjectionSessionId =
      recoveries.find((item) => item.capability === "restorable")?.sessionId ??
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
      return await this.persistStopReconciliation(snapshot, command, true);
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
      return await this.persistStopReconciliation(recovered, command, false);
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

interface CaptureRecoveryWorkspaceInspection {
  complete: boolean;
  audioFiles: string[];
  hasPartial: boolean;
  hasQuarantine: boolean;
  journalPresent: boolean;
}

export function inspectCaptureRecoveryWorkspace(options: {
  captureRoot: string;
  sessionId: string;
  workspacePath: string;
}): CaptureRecoveryWorkspaceInspection {
  const unavailable = (): CaptureRecoveryWorkspaceInspection => ({
    complete: false,
    audioFiles: [],
    hasPartial: false,
    hasQuarantine: false,
    journalPresent: false,
  });
  try {
    const root = realpathSync(path.resolve(options.captureRoot));
    const expected = path.join(root, options.sessionId);
    if (
      path.basename(path.resolve(options.workspacePath)) !== options.sessionId
    ) {
      return unavailable();
    }
    const workspace = realpathSync(options.workspacePath);
    if (workspace !== expected) return unavailable();
    const rootStat = lstatSync(workspace);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      return unavailable();
    const audioFiles: string[] = [];
    let hasPartial = false;
    let hasQuarantine = false;
    let journalPresent = false;
    let visited = 0;
    const walk = (directory: string): boolean => {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        visited += 1;
        if (visited > 4_096 || entry.isSymbolicLink()) return false;
        const absolute = path.join(directory, entry.name);
        const relative = normalizeRelativePath(
          path.relative(workspace, absolute),
        );
        if (entry.isDirectory()) {
          if (entry.name === "quarantine") hasQuarantine = true;
          if (!walk(absolute)) return false;
        } else if (entry.isFile()) {
          if (relative === "journal.json") journalPresent = true;
          if (entry.name.endsWith(".partial")) hasPartial = true;
          if (entry.name.endsWith(".caf")) audioFiles.push(relative);
          if (relative.startsWith("quarantine/")) hasQuarantine = true;
        } else {
          return false;
        }
      }
      return true;
    };
    return walk(workspace)
      ? {
          complete: true,
          audioFiles,
          hasPartial,
          hasQuarantine,
          journalPresent,
        }
      : unavailable();
  } catch {
    return unavailable();
  }
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function recoveryOutcome(
  sessionId: string,
  action: "keep" | "discard",
  result: CaptureRecoveryOutcome["result"],
  capture: CaptureSnapshot | null = null,
): CaptureRecoveryOutcome {
  if (result === "kept") {
    return {
      sessionId,
      action,
      result,
      completionCertainty: "completed",
      audioDurability: "durable",
      transcriptionHandoff: "pending",
      capture,
    };
  }
  if (result === "discarded") {
    return {
      sessionId,
      action,
      result,
      completionCertainty: "completed",
      audioDurability: "discarded",
      transcriptionHandoff: "not-requested",
      capture: null,
    };
  }
  if (result === "preserved") {
    return {
      sessionId,
      action,
      result,
      completionCertainty: "not-completed",
      audioDurability: "preserved",
      transcriptionHandoff: "not-requested",
      capture: null,
    };
  }
  return {
    sessionId,
    action,
    result,
    completionCertainty: result === "conflict" ? "not-completed" : "unknown",
    audioDurability: result === "conflict" ? "unchanged" : "unknown",
    transcriptionHandoff: "not-requested",
    capture: null,
  };
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
