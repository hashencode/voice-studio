import {
  applicationSnapshotSchema,
  desktopProtocolVersion,
  type ApplicationSnapshot,
  type ActivityItem,
  type CaptureLibraryProjectionFailureCode,
  type CaptureSnapshot,
  type ShellSection,
} from "../../shared/contracts";
import type { AudioProfileInitializationResult } from "../profile/audio_profile";

type SnapshotListener = (snapshot: ApplicationSnapshot) => void;

export class DesktopApplicationState {
  private current: ApplicationSnapshot = applicationSnapshotSchema.parse({
    protocolVersion: desktopProtocolVersion,
    revision: 0,
    navigation: { section: "library" },
    profile: { phase: "initializing" },
    connectivity: "online",
    capability: { processing: "available" },
    library: { phase: "loading" },
    reconciliation: [],
    capture: { phase: "idle" },
    libraryProjection: { phase: "idle" },
    activity: [],
  });
  private readonly listeners = new Set<SnapshotListener>();

  snapshot(): ApplicationSnapshot {
    return structuredClone(this.current);
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  beginBootstrap(): ApplicationSnapshot {
    return this.update({
      profile: { phase: "initializing" },
      library: { phase: "loading" },
    });
  }

  completeBootstrap(
    result: AudioProfileInitializationResult,
  ): ApplicationSnapshot {
    if (result.status === "blocked") {
      return this.update({
        profile: {
          phase: "blocked",
          code: result.code,
          message: result.message,
          repairable: true,
        },
        library: {
          phase: "error",
          message: "本机资料库尚未初始化",
          retryable: true,
        },
        reconciliation: [],
      });
    }
    return this.update({
      profile: {
        phase: "ready",
        legacyDatabaseArchived: result.archivedLegacyDatabasePath !== null,
      },
      library: { phase: "empty" },
      reconciliation: result.reconciliation.items.map((item) => ({
        kind: item.kind,
        identity: item.identity,
        state: item.state,
        requiresExplicitAction: true as const,
      })),
    });
  }

  navigate(section: ShellSection): ApplicationSnapshot {
    if (this.current.profile.phase !== "ready") return this.snapshot();
    if (this.current.navigation.section === section) return this.snapshot();
    return this.update({ navigation: { section } });
  }

  setProcessingCapability(reason?: string): ApplicationSnapshot {
    return this.update({
      capability: reason
        ? { processing: "unavailable", reason }
        : { processing: "available" },
    });
  }

  setLibraryCount(audioCount: number): ApplicationSnapshot {
    const library =
      audioCount === 0
        ? ({ phase: "empty" } as const)
        : ({ phase: "ready", audioCount } as const);
    if (
      this.current.library.phase === library.phase &&
      (library.phase === "empty" ||
        (this.current.library.phase === "ready" &&
          this.current.library.audioCount === library.audioCount))
    ) {
      return this.snapshot();
    }
    return this.update({ library });
  }

  setCapture(
    capture: CaptureSnapshot | null,
    title = "音频录制",
    audioActivity = 0,
  ): ApplicationSnapshot {
    if (!capture) return this.update({ capture: { phase: "idle" } });
    const phase = capture.state === "recoverable" ? "recovery" : capture.state;
    const activity = nextActivity(this.current, capture, phase);
    return this.update({
      capture: {
        phase,
        sessionId: capture.sessionId,
        title,
        elapsedMs: capture.captureTimelineMs,
        audioActivity,
        captureMode: capture.captureMode,
        systemAudioHealthy: capture.systemAudioHealthy,
        microphoneHealthy: capture.microphoneHealthy,
        partialCapture: capture.partialCapture,
        gapCount: capture.gapCount,
        interruptionReason: capture.interruptionReason,
        message: capture.interruptionReason
          ? captureMessage(capture.interruptionReason)
          : undefined,
      },
      activity,
    });
  }

  beginCaptureLibraryProjection(command: {
    sessionId: string;
    intentId: string;
  }): ApplicationSnapshot {
    return this.update({
      libraryProjection: { phase: "registering", ...command },
    });
  }

  resetCaptureLibraryProjection(): ApplicationSnapshot {
    if (this.current.libraryProjection.phase === "idle") return this.snapshot();
    return this.update({ libraryProjection: { phase: "idle" } });
  }

  completeCaptureLibraryProjection(command: {
    sessionId: string;
    intentId: string;
    audioId: number;
  }): ApplicationSnapshot {
    if (!this.isCurrentProjection(command)) return this.snapshot();
    return this.update({
      libraryProjection: { phase: "registered", ...command },
    });
  }

  failCaptureLibraryProjection(command: {
    sessionId: string;
    intentId: string;
    code: CaptureLibraryProjectionFailureCode;
  }): ApplicationSnapshot {
    if (!this.isCurrentProjection(command)) return this.snapshot();
    return this.update({
      libraryProjection: {
        phase: "failed",
        ...command,
        message: projectionFailureMessage(command.code),
      },
    });
  }

  markActivityRead(activityId: string): ApplicationSnapshot {
    const currentActivity = this.current.activity ?? [];
    const activity = currentActivity.map((item) =>
      item.id === activityId && !item.read ? { ...item, read: true } : item,
    );
    if (activity.every((item, index) => item === currentActivity[index])) {
      return this.snapshot();
    }
    return this.update({ activity });
  }

  markAllActivityRead(): ApplicationSnapshot {
    const currentActivity = this.current.activity ?? [];
    const activity = currentActivity.map((item) =>
      item.read ? item : { ...item, read: true },
    );
    if (activity.every((item, index) => item === currentActivity[index])) {
      return this.snapshot();
    }
    return this.update({ activity });
  }

  private update(
    patch: Partial<Omit<ApplicationSnapshot, "protocolVersion" | "revision">>,
  ): ApplicationSnapshot {
    this.current = applicationSnapshotSchema.parse({
      ...this.current,
      ...patch,
      revision: this.current.revision + 1,
    });
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  private isCurrentProjection(command: {
    sessionId: string;
    intentId: string;
  }): boolean {
    const current = this.current.libraryProjection;
    return (
      current?.phase === "registering" &&
      current.sessionId === command.sessionId &&
      current.intentId === command.intentId
    );
  }
}

function projectionFailureMessage(
  code: CaptureLibraryProjectionFailureCode,
): string {
  return code === "invalid_authority"
    ? "录音已保存，但无法验证音频资料。请重试。"
    : code === "projection_unavailable"
      ? "录音已保存，音频资料库暂不可用。请稍后重试。"
      : "录音已保存，但暂时无法加入音频资料库。请重试。";
}

export function canRetryCaptureLibraryProjection(
  snapshot: ApplicationSnapshot,
  request: { sessionId: string; intentId: string },
): boolean {
  const projection = snapshot.libraryProjection;
  return (
    projection?.phase === "failed" &&
    projection.sessionId === request.sessionId &&
    projection.intentId === request.intentId &&
    snapshot.capture.phase !== "idle" &&
    snapshot.capture.sessionId === request.sessionId &&
    (snapshot.capture.phase === "completed" ||
      snapshot.capture.phase === "partial_capture")
  );
}

function nextActivity(
  current: ApplicationSnapshot,
  capture: CaptureSnapshot,
  phase: Exclude<ApplicationSnapshot["capture"], { phase: "idle" }>["phase"],
): ActivityItem[] {
  const currentActivity = current.activity ?? [];
  const terminal =
    phase === "completed" ||
    phase === "failed" ||
    (phase === "partial_capture" && capture.recordingSha256 !== null);
  if (!terminal) return currentActivity;

  const kind: ActivityItem["kind"] =
    phase === "completed"
      ? "capture_completed"
      : phase === "partial_capture"
        ? "capture_partial"
        : "capture_failed";
  const id = `${capture.sessionId}:${kind}`;
  if (currentActivity.some((item) => item.id === id)) return currentActivity;
  const warning = kind !== "capture_completed";
  const item: ActivityItem = {
    id,
    kind,
    captureSessionId: capture.sessionId,
    createdAt: Date.now(),
    title:
      kind === "capture_completed"
        ? "录制已保存"
        : kind === "capture_partial"
          ? "部分录制已保存，请检查"
          : "录制需要处理",
    severity: warning ? "warning" : "info",
    read: false,
    resolved: kind === "capture_completed",
    detailTarget: "capture-details",
  };
  return [item, ...currentActivity].slice(0, 20);
}

function captureMessage(reason: string): string {
  if (reason === "system_sleep") return "电脑已进入睡眠，录制已安全暂停。";
  if (reason === "system_wake_requires_resume")
    return "电脑已唤醒，请确认后手动继续录制。";
  if (reason === "disk_space_low") return "磁盘空间不足，已保存当前可用录音。";
  if (reason === "capture_stop_slow") return "保存时间比预期长，仍在继续保存…";
  return "录制状态发生变化，请检查轨道状态。";
}
