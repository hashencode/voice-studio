import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FloatingCapturePreferenceSetting } from "@/features/capture/capture-workspace";
import {
  MicrophoneTestDialog,
  useMicrophoneTestController,
} from "@/features/capture/microphone-test-dialog";
import {
  SYSTEM_DEFAULT_MICROPHONE,
  useRecordingPreference,
} from "@/features/capture/use-recording-preference";
import { SettingsListBlock } from "@/features/settings/settings-page-section";
import type { CapturePreflight, Voice2TextDesktopApi } from "@shared/contracts";

export function RecordingSettingsFeature({
  api = window.voice2text,
}: {
  api?: Voice2TextDesktopApi;
}) {
  const preference = useRecordingPreference();
  const [preflight, setPreflight] = React.useState<CapturePreflight | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [deviceError, setDeviceError] = React.useState(false);

  const loadDevices = React.useCallback(async () => {
    setLoading(true);
    setDeviceError(false);
    try {
      const next = await api.preflightCapture({
        requestPermissions: false,
        captionEnabled: true,
      });
      setPreflight(next);
      return next;
    } catch {
      setDeviceError(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [api]);

  React.useEffect(() => {
    let active = true;
    void api
      .preflightCapture({ requestPermissions: false, captionEnabled: true })
      .then((next) => {
        if (active) setPreflight(next);
      })
      .catch(() => {
        if (active) setDeviceError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const refreshCapturePreflight = React.useCallback(
    async (requestPermissions: boolean) => {
      const next = await api.preflightCapture({
        requestPermissions,
        captionEnabled: true,
      });
      if (!requestPermissions) setPreflight(next);
      return next;
    },
    [api],
  );
  const microphoneTest = useMicrophoneTestController({
    api,
    preferredMicrophoneDeviceId: preference.microphoneDeviceId,
    refreshCapturePreflight,
  });
  const savedMicrophoneLabel =
    preference.microphoneDeviceId === SYSTEM_DEFAULT_MICROPHONE
      ? "跟随系统默认"
      : (preference.microphoneName ?? preference.microphoneDeviceId);

  return (
    <>
      <SettingsListBlock>
        <Field orientation="horizontal" className="items-center! p-4">
          <FieldContent>
            <FieldLabel id="default-microphone-label">默认麦克风</FieldLabel>
            <FieldDescription>录制和测试时优先使用</FieldDescription>
            {deviceError ? (
              <div className="flex flex-wrap items-center gap-2">
                <FieldError>无法读取麦克风，请重试。</FieldError>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => void loadDevices()}
                >
                  重新载入设备
                </Button>
              </div>
            ) : null}
            {preference.error === "read-failed" ? (
              <FieldError>无法读取已保存的麦克风，已跟随系统默认。</FieldError>
            ) : preference.error === "write-failed" ? (
              <FieldError>无法保存默认麦克风，请重试。</FieldError>
            ) : null}
          </FieldContent>
          <Select
            value={preference.microphoneDeviceId}
            disabled={loading || deviceError}
            onValueChange={(value) => {
              const device = preflight?.microphones.find(
                (candidate) => candidate.id === value,
              );
              preference.setMicrophone(value, device?.name ?? null);
            }}
          >
            <SelectTrigger
              aria-labelledby="default-microphone-label"
              className="max-w-56"
            >
              <SelectValue>{savedMicrophoneLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SYSTEM_DEFAULT_MICROPHONE}>
                跟随系统默认
              </SelectItem>
              {preflight?.microphones.map((device) => (
                <SelectItem key={device.id} value={device.id}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field orientation="horizontal" className="items-center! border-t p-4">
          <FieldContent>
            <FieldLabel>测试麦克风</FieldLabel>
            <FieldDescription>确认输入音量是否正常</FieldDescription>
          </FieldContent>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={microphoneTest.busy || microphoneTest.teardownPending}
            onClick={() => void microphoneTest.start()}
          >
            测试麦克风
          </Button>
        </Field>
        <FloatingCapturePreferenceSetting api={api} className="border-t p-4" />
      </SettingsListBlock>
      <MicrophoneTestDialog controller={microphoneTest} />
    </>
  );
}
