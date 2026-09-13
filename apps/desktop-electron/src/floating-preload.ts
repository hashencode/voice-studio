import { contextBridge, ipcRenderer } from "electron";

import {
  floatingCaptureControlRequestSchema,
  floatingCapturePreferenceRequestSchema,
  floatingCaptureSnapshotSchema,
  floatingCaptureWindowActionRequestSchema,
  ipcChannels,
  type FloatingCaptureSnapshot,
  type FloatingCaptureControlRequest,
  type FloatingCaptureWindowAction,
  type Voice2TextFloatingApi,
  desktopTransportFailure,
  unwrapDesktopIpcEnvelope,
} from "./shared/contracts";

async function invoke(channel: string, payload: unknown): Promise<unknown> {
  let response: unknown;
  try {
    response = await ipcRenderer.invoke(channel, payload);
  } catch {
    throw desktopTransportFailure("IPC_DISCONNECTED");
  }
  return unwrapDesktopIpcEnvelope(response, floatingCaptureSnapshotSchema);
}

const api: Voice2TextFloatingApi = Object.freeze({
  async getSnapshot() {
    return floatingCaptureSnapshotSchema.parse(
      await invoke(
        ipcChannels.floatingCaptureSnapshotGet,
        floatingCapturePreferenceRequestSchema.parse({}),
      ),
    );
  },
  async control(options: FloatingCaptureControlRequest) {
    return floatingCaptureSnapshotSchema.parse(
      await invoke(
        ipcChannels.floatingCaptureControl,
        floatingCaptureControlRequestSchema.parse(options),
      ),
    );
  },
  async windowAction(action: FloatingCaptureWindowAction) {
    return floatingCaptureSnapshotSchema.parse(
      await invoke(
        ipcChannels.floatingCaptureWindowAction,
        floatingCaptureWindowActionRequestSchema.parse({ action }),
      ),
    );
  },
  onSnapshot(listener: (snapshot: FloatingCaptureSnapshot) => void) {
    const wrapper = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      listener(floatingCaptureSnapshotSchema.parse(payload));
    ipcRenderer.on(ipcChannels.floatingCaptureSnapshotEvent, wrapper);
    return () =>
      ipcRenderer.removeListener(
        ipcChannels.floatingCaptureSnapshotEvent,
        wrapper,
      );
  },
});

contextBridge.exposeInMainWorld("voice2textFloating", api);
