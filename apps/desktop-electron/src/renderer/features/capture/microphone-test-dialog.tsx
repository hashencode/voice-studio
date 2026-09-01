import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  CapturePreflight,
  MicrophoneTestSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";
import { resolveRecordingMicrophone } from "./use-recording-preference";

const MICROPHONE_METER_DB_FLOOR = -60;
const MICROPHONE_METER_POLL_INTERVAL_MS = 100;
const MICROPHONE_METER_RELEASE_MS = 300;
const MICROPHONE_MAXIMUM_REFRESH_MS = 500;

type MicrophoneMeterEnvelope = {
  value: number;
  releaseStart: number;
  releaseElapsedMs: number;
};

type MicrophoneTestControllerOptions = {
  api: Voice2TextDesktopApi;
  preferredMicrophoneDeviceId: string;
  refreshCapturePreflight: (
    requestPermissions: boolean,
  ) => Promise<CapturePreflight>;
};

export type MicrophoneTestController = ReturnType<
  typeof useMicrophoneTestController
>;

// The controller is intentionally shared by the Audio and Recording settings owners.
// eslint-disable-next-line react-refresh/only-export-components
export function useMicrophoneTestController({
  api,
  preferredMicrophoneDeviceId,
  refreshCapturePreflight,
}: MicrophoneTestControllerOptions) {
  const [phase, setPhase] = React.useState<
    "closed" | "starting" | "testing" | "failure"
  >("closed");
  const [failureReason, setFailureReason] = React.useState<
    MicrophoneTestSnapshot["reason"] | null
  >(null);
  const [finishPending, setFinishPending] = React.useState(false);
  const [teardownPending, setTeardownPending] = React.useState(false);
  const [settingsManualPathVisible, setSettingsManualPathVisible] =
    React.useState(false);
  const [meterPercentage, setMeterPercentage] = React.useState(0);
  const [displayedMaximumDbfs, setDisplayedMaximumDbfs] = React.useState<
    number | null
  >(null);
  const activeTestIdRef = React.useRef<string | null>(null);
  const startPendingRef = React.useRef(false);
  const generationRef = React.useRef(0);
  const meterEnvelopeRef = React.useRef<MicrophoneMeterEnvelope>({
    value: 0,
    releaseStart: 0,
    releaseElapsedMs: 0,
  });
  const meterPresentationUpdatedAtMsRef = React.useRef<number | null>(null);
  const maximumRmsRef = React.useRef(0);
  const displayedMaximumDbfsRef = React.useRef<number | null>(null);
  const maximumPublishedAtMsRef = React.useRef(0);

  const showFailure = React.useCallback(
    (reason: NonNullable<MicrophoneTestSnapshot["reason"]>) => {
      activeTestIdRef.current = null;
      setFailureReason(reason);
      setPhase("failure");
    },
    [],
  );

  const cancelActiveTest = React.useCallback(async () => {
    const testId = activeTestIdRef.current;
    activeTestIdRef.current = null;
    if (!testId) return;
    setTeardownPending(true);
    try {
      await api.cancelMicrophoneTest(testId);
    } catch {
      // Closing is an explicit cancellation path and never presents a result.
    } finally {
      setTeardownPending(false);
    }
  }, [api]);

  const resetMeterPresentation = React.useCallback(() => {
    meterEnvelopeRef.current = {
      value: 0,
      releaseStart: 0,
      releaseElapsedMs: 0,
    };
    meterPresentationUpdatedAtMsRef.current = null;
    maximumRmsRef.current = 0;
    displayedMaximumDbfsRef.current = null;
    maximumPublishedAtMsRef.current = 0;
    setMeterPercentage(0);
    setDisplayedMaximumDbfs(null);
  }, []);

  const applyRunningSnapshot = React.useCallback(
    (snapshot: MicrophoneTestSnapshot) => {
      const now = performance.now();
      const lastUpdatedAt = meterPresentationUpdatedAtMsRef.current;
      meterPresentationUpdatedAtMsRef.current = now;
      const target = normalizedRmsToMeterPercentage(snapshot.normalizedRMS);
      const envelope = applyMicrophoneMeterEnvelope(
        meterEnvelopeRef.current,
        target,
        lastUpdatedAt === null ? 0 : now - lastUpdatedAt,
      );
      meterEnvelopeRef.current = envelope;
      setMeterPercentage(envelope.value);

      maximumRmsRef.current = Math.max(
        maximumRmsRef.current,
        boundedNormalizedRms(snapshot.normalizedRMS),
      );
      if (!snapshot.observedSound) return;
      const nextMaximumDbfs = normalizedRmsToRoundedDbfs(maximumRmsRef.current);
      const displayed = displayedMaximumDbfsRef.current;
      if (
        displayed === null ||
        (nextMaximumDbfs > displayed &&
          snapshot.elapsedMs - maximumPublishedAtMsRef.current >=
            MICROPHONE_MAXIMUM_REFRESH_MS)
      ) {
        displayedMaximumDbfsRef.current = nextMaximumDbfs;
        maximumPublishedAtMsRef.current = snapshot.elapsedMs;
        setDisplayedMaximumDbfs(nextMaximumDbfs);
      }
    },
    [],
  );

  const close = React.useCallback(() => {
    generationRef.current += 1;
    if (phase === "starting") setTeardownPending(true);
    setPhase("closed");
    setFailureReason(null);
    setSettingsManualPathVisible(false);
    resetMeterPresentation();
    void cancelActiveTest();
  }, [cancelActiveTest, phase, resetMeterPresentation]);

  const finish = React.useCallback(async () => {
    const testId = activeTestIdRef.current;
    if (!testId || finishPending) return;
    const generation = generationRef.current;
    setFinishPending(true);
    try {
      const finished = await api.finishMicrophoneTest(testId);
      if (generation !== generationRef.current) return;
      activeTestIdRef.current = null;
      if (finished.reason === "detected" || finished.observedSound) {
        setPhase("closed");
        setFailureReason(null);
      } else {
        showFailure(finished.reason ?? "snapshot-failed");
      }
    } catch {
      if (generation === generationRef.current) {
        showFailure("native-helper-failed");
      }
    } finally {
      setFinishPending(false);
    }
  }, [api, finishPending, showFailure]);

  const start = React.useCallback(async () => {
    if (startPendingRef.current || activeTestIdRef.current) return;
    startPendingRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPhase("starting");
    setFailureReason(null);
    setSettingsManualPathVisible(false);
    resetMeterPresentation();
    try {
      const next = await refreshCapturePreflight(true);
      if (generation !== generationRef.current) return;
      const preferred = resolveRecordingMicrophone(
        next.microphones,
        preferredMicrophoneDeviceId,
      );
      if (next.microphonePermission !== "granted") {
        showFailure("permission-denied");
        return;
      }
      if (!preferred) {
        showFailure("device-unavailable");
        return;
      }
      const started = await api.startMicrophoneTest({
        microphoneDeviceId: preferred.id,
      });
      if (generation !== generationRef.current) {
        await api.cancelMicrophoneTest(started.testId);
        return;
      }
      activeTestIdRef.current = started.testId;
      if (started.state === "running") {
        applyRunningSnapshot(started);
        setPhase("testing");
      } else if (started.state === "failed") {
        showFailure(started.reason ?? "native-helper-failed");
      }
    } catch {
      if (generation === generationRef.current) {
        showFailure("native-helper-failed");
      }
    } finally {
      startPendingRef.current = false;
      if (generation !== generationRef.current) {
        setTeardownPending(false);
      }
    }
  }, [
    api,
    applyRunningSnapshot,
    preferredMicrophoneDeviceId,
    refreshCapturePreflight,
    resetMeterPresentation,
    showFailure,
  ]);

  React.useEffect(() => {
    const testId = activeTestIdRef.current;
    if (phase !== "testing" || !testId) return;
    let active = true;
    const generation = generationRef.current;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await api.getMicrophoneTestSnapshot(testId);
        if (!active || generation !== generationRef.current) return;
        if (next.state === "running") {
          applyRunningSnapshot(next);
          timer = window.setTimeout(
            () => void poll(),
            MICROPHONE_METER_POLL_INTERVAL_MS,
          );
        } else if (next.state === "failed") {
          activeTestIdRef.current = null;
          showFailure(next.reason ?? "snapshot-failed");
        }
      } catch {
        if (!active || generation !== generationRef.current) return;
        activeTestIdRef.current = null;
        showFailure("snapshot-failed");
      }
    };
    timer = window.setTimeout(
      () => void poll(),
      MICROPHONE_METER_POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [api, applyRunningSnapshot, phase, showFailure]);

  React.useEffect(() => {
    return () => {
      generationRef.current += 1;
      void cancelActiveTest();
    };
  }, [cancelActiveTest]);

  const openMicrophoneSettings = React.useCallback(async () => {
    try {
      const result = await api.openMicrophoneSettings();
      setSettingsManualPathVisible(result.state === "failed");
    } catch {
      setSettingsManualPathVisible(true);
    }
  }, [api]);

  let description = microphoneFailureDescription(failureReason);
  if (phase === "starting") {
    description = "正在连接麦克风…";
  } else if (phase === "testing") {
    description =
      displayedMaximumDbfs === null
        ? "请对着麦克风说话。"
        : `已收到声音 · 最高输入电平 ${formatDbfs(displayedMaximumDbfs)} dBFS`;
  }

  return {
    phase,
    failureReason,
    finishPending,
    teardownPending,
    settingsManualPathVisible,
    meterPercentage,
    busy: phase === "starting" || phase === "testing",
    description,
    start,
    close,
    finish,
    openMicrophoneSettings,
  };
}

export function MicrophoneTestDialog({
  controller,
}: {
  controller: MicrophoneTestController;
}) {
  return (
    <Dialog
      open={controller.phase !== "closed"}
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
    >
      <DialogContent
        showCloseButton={
          controller.phase !== "failure" ||
          controller.failureReason !== "native-helper-failed"
        }
      >
        <DialogHeader>
          <DialogTitle>
            {controller.phase === "starting" || controller.phase === "testing"
              ? "测试麦克风"
              : microphoneFailureTitle(controller.failureReason)}
          </DialogTitle>
          <DialogDescription>{controller.description}</DialogDescription>
        </DialogHeader>
        {controller.phase === "starting" ? (
          <div className="flex justify-end pt-2">
            <Button type="button" variant="outline" onClick={controller.close}>
              取消
            </Button>
          </div>
        ) : controller.phase === "testing" ? (
          <div className="space-y-4 pt-2">
            <div
              role="meter"
              aria-label="麦克风输入音量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(controller.meterPercentage)}
              aria-valuetext={`${Math.round(controller.meterPercentage)}%`}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-75 ease-out motion-reduce:transition-none"
                style={{ width: `${controller.meterPercentage}%` }}
              />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                autoFocus
                disabled={controller.finishPending}
                onClick={() => void controller.finish()}
              >
                结束测试
              </Button>
            </div>
          </div>
        ) : controller.phase === "failure" ? (
          <div className="space-y-3 pt-2">
            {controller.settingsManualPathVisible ? (
              <p role="alert" className="text-sm text-muted-foreground">
                请手动前往：系统设置 → 隐私与安全 → 麦克风
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              {controller.failureReason !== "native-helper-failed" ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void controller.openMicrophoneSettings()}
                >
                  前往麦克风设置
                </Button>
              ) : null}
              <Button type="button" onClick={controller.close}>
                知道了
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function boundedNormalizedRms(normalizedRms: number): number {
  if (!Number.isFinite(normalizedRms)) return 0;
  return Math.max(0, Math.min(1, normalizedRms));
}

function normalizedRmsToMeterPercentage(normalizedRms: number): number {
  const rms = boundedNormalizedRms(normalizedRms);
  if (rms === 0) return 0;
  const dbfs = Math.max(MICROPHONE_METER_DB_FLOOR, 20 * Math.log10(rms));
  return Math.min(
    100,
    ((dbfs - MICROPHONE_METER_DB_FLOOR) / -MICROPHONE_METER_DB_FLOOR) * 100,
  );
}

function normalizedRmsToRoundedDbfs(normalizedRms: number): number {
  const rms = boundedNormalizedRms(normalizedRms);
  if (rms === 0) return MICROPHONE_METER_DB_FLOOR;
  return Math.max(
    MICROPHONE_METER_DB_FLOOR,
    Math.min(0, Math.round(20 * Math.log10(rms))),
  );
}

function applyMicrophoneMeterEnvelope(
  current: MicrophoneMeterEnvelope,
  target: number,
  elapsedMs: number,
): MicrophoneMeterEnvelope {
  if (target >= current.value) {
    return { value: target, releaseStart: target, releaseElapsedMs: 0 };
  }
  const releaseStart =
    current.releaseElapsedMs === 0 ? current.value : current.releaseStart;
  const releaseElapsedMs = Math.min(
    MICROPHONE_METER_RELEASE_MS,
    current.releaseElapsedMs + Math.max(0, elapsedMs),
  );
  const value = Math.max(
    target,
    releaseStart * (1 - releaseElapsedMs / MICROPHONE_METER_RELEASE_MS),
  );
  return { value, releaseStart, releaseElapsedMs };
}

function formatDbfs(dbfs: number): string {
  return dbfs < 0 ? `−${Math.abs(dbfs)}` : "0";
}

function microphoneFailureTitle(
  reason: MicrophoneTestSnapshot["reason"] | null,
): string {
  return reason === "no-audio-frames" || reason === "no-sound-observed"
    ? "未检测到麦克风输入"
    : reason === "device-unavailable"
      ? "麦克风不可用"
      : "麦克风测试失败";
}

function microphoneFailureDescription(
  reason: MicrophoneTestSnapshot["reason"] | null,
): string {
  switch (reason) {
    case "no-audio-frames":
    case "no-sound-observed":
      return "未检测到麦克风输入";
    case "permission-denied":
      return "没有麦克风权限，请在系统设置中允许访问。";
    case "device-unavailable":
      return "麦克风不可用，请检查设备连接。";
    case "device-open-failed":
      return "无法打开麦克风，请检查设备是否被其他应用占用。";
    case "unsupported-format":
      return "当前麦克风格式不受支持，请选择其他设备。";
    case "native-helper-failed":
      return "麦克风测试暂不可用，请重启应用。";
    case "snapshot-failed":
    default:
      return "麦克风测试出现问题，请重新测试";
  }
}
