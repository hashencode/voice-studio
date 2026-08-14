import {
  applicationSnapshotSchema,
  desktopProtocolVersion,
  type ApplicationSnapshot,
  type CaptureSnapshot,
  type ShellSection,
} from "../../shared/contracts";
import type { ElectronProfileInitializationResult } from "../profile/electron_profile";

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
    result: ElectronProfileInitializationResult,
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
      profile: { phase: "ready" },
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

  setLibraryCount(meetingCount: number): ApplicationSnapshot {
    return this.update({
      library:
        meetingCount === 0
          ? { phase: "empty" }
          : { phase: "ready", meetingCount },
    });
  }

  setCapture(
    capture: CaptureSnapshot | null,
    title = "会议录制",
  ): ApplicationSnapshot {
    if (!capture) return this.update({ capture: { phase: "idle" } });
    const phase = capture.state === "recoverable" ? "recovery" : capture.state;
    return this.update({
      capture: {
        phase,
        sessionId: capture.sessionId,
        title,
        elapsedMs: capture.captureTimelineMs,
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
    });
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
}

function captureMessage(reason: string): string {
  if (reason === "system_sleep") return "电脑已进入睡眠，录制已安全暂停。";
  if (reason === "system_wake_requires_resume")
    return "电脑已唤醒，请确认后手动继续录制。";
  if (reason === "disk_space_low") return "磁盘空间不足，已保存当前可用录音。";
  return "录制状态发生变化，请检查轨道状态。";
}
