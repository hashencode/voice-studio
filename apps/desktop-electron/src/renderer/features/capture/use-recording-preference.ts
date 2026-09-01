import * as React from "react";

export const RECORDING_PREFERENCE_STORAGE_KEY =
  "voice2text.capture.recording-preference.v1";
export const SYSTEM_DEFAULT_MICROPHONE = "system-default";

const RECORDING_PREFERENCE_CHANGED_EVENT =
  "voice2text:recording-preference-changed";

export type RecordingPreferenceError = "read-failed" | "write-failed";

type StoredRecordingPreference = {
  version: 1;
  microphoneDeviceId: string;
  microphoneName: string | null;
};

type RecordingPreferenceState = {
  microphoneDeviceId: string;
  microphoneName: string | null;
  error: RecordingPreferenceError | null;
};

const DEFAULT_RECORDING_PREFERENCE: RecordingPreferenceState = {
  microphoneDeviceId: SYSTEM_DEFAULT_MICROPHONE,
  microphoneName: null,
  error: null,
};

export function useRecordingPreference() {
  const [state, setState] = React.useState(readRecordingPreference);

  React.useEffect(() => {
    const handlePreferenceChange = (event: Event) => {
      const next = (event as CustomEvent<RecordingPreferenceState>).detail;
      setState(next);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === RECORDING_PREFERENCE_STORAGE_KEY) {
        setState(readRecordingPreference());
      }
    };
    window.addEventListener(
      RECORDING_PREFERENCE_CHANGED_EVENT,
      handlePreferenceChange,
    );
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        RECORDING_PREFERENCE_CHANGED_EVENT,
        handlePreferenceChange,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const setMicrophone = React.useCallback(
    (microphoneDeviceId: string, microphoneName: string | null = null) => {
      const next: RecordingPreferenceState = {
        microphoneDeviceId: microphoneDeviceId || SYSTEM_DEFAULT_MICROPHONE,
        microphoneName:
          microphoneDeviceId === SYSTEM_DEFAULT_MICROPHONE
            ? null
            : microphoneName,
        error: null,
      };
      try {
        const stored: StoredRecordingPreference = {
          version: 1,
          microphoneDeviceId: next.microphoneDeviceId,
          microphoneName: next.microphoneName,
        };
        window.localStorage.setItem(
          RECORDING_PREFERENCE_STORAGE_KEY,
          JSON.stringify(stored),
        );
      } catch {
        next.error = "write-failed";
      }
      setState(next);
      window.dispatchEvent(
        new CustomEvent<RecordingPreferenceState>(
          RECORDING_PREFERENCE_CHANGED_EVENT,
          { detail: next },
        ),
      );
    },
    [],
  );

  return { ...state, setMicrophone };
}

export function resolveRecordingMicrophone<
  T extends { id: string; isDefault: boolean },
>(
  microphones: readonly T[],
  preferredDeviceId: string | null | undefined,
): T | undefined {
  const preferred =
    preferredDeviceId && preferredDeviceId !== SYSTEM_DEFAULT_MICROPHONE
      ? microphones.find((device) => device.id === preferredDeviceId)
      : undefined;
  return (
    preferred ??
    microphones.find((device) => device.isDefault) ??
    microphones[0]
  );
}

function readRecordingPreference(): RecordingPreferenceState {
  try {
    const stored = window.localStorage.getItem(
      RECORDING_PREFERENCE_STORAGE_KEY,
    );
    if (!stored) return DEFAULT_RECORDING_PREFERENCE;
    const value: unknown = JSON.parse(stored);
    if (!isStoredRecordingPreference(value)) {
      return { ...DEFAULT_RECORDING_PREFERENCE, error: "read-failed" };
    }
    return {
      microphoneDeviceId: value.microphoneDeviceId,
      microphoneName: value.microphoneName,
      error: null,
    };
  } catch {
    return { ...DEFAULT_RECORDING_PREFERENCE, error: "read-failed" };
  }
}

function isStoredRecordingPreference(
  value: unknown,
): value is StoredRecordingPreference {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredRecordingPreference>;
  return (
    candidate.version === 1 &&
    typeof candidate.microphoneDeviceId === "string" &&
    candidate.microphoneDeviceId.length > 0 &&
    (candidate.microphoneName === null ||
      typeof candidate.microphoneName === "string")
  );
}
