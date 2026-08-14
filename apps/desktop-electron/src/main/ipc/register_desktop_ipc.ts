import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";

import { ipcChannels } from "../../shared/contracts";
import {
  createDesktopIpcHandlers,
  type DesktopIpcServices,
  type IpcInvocationContext,
} from "./desktop_ipc";

export function registerDesktopIpc(
  window: BrowserWindow,
  services: DesktopIpcServices,
): () => void {
  const frameId = window.webContents.mainFrame.routingId;
  const origins = new Set<string>();
  const fileUrls = new Set<string>();
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    origins.add(new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin);
  } else {
    fileUrls.add(
      pathToFileURL(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      ).href,
    );
  }
  const handlers = createDesktopIpcHandlers({
    trust: { senderId: window.webContents.id, frameId, origins, fileUrls },
    services,
  });
  const channels = [
    ipcChannels.applicationSnapshot,
    ipcChannels.applicationNavigate,
    ipcChannels.applicationBootstrapAction,
    ipcChannels.workerHealth,
    ipcChannels.cancelProcessing,
    ipcChannels.retryProcessing,
    ipcChannels.processingTasks,
    ipcChannels.importMeeting,
  ] as const;
  for (const channel of channels) {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      return await handlers.invoke(
        channel,
        invocationContext(event, window, frameId),
        payload,
      );
    });
  }
  const unsubscribeSnapshot = services.onApplicationSnapshot?.((snapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(ipcChannels.applicationSnapshotEvent, snapshot);
    }
  });
  const unsubscribeOperation = services.onOperationEvent?.((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(ipcChannels.operationEvent, event);
    }
  });
  return () => {
    unsubscribeSnapshot?.();
    unsubscribeOperation?.();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function invocationContext(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  trustedFrameId: number,
): IpcInvocationContext {
  const frame = event.senderFrame;
  return {
    senderId: event.sender === window.webContents ? event.sender.id : -1,
    frameId: frame === window.webContents.mainFrame ? trustedFrameId : -1,
    origin: frame?.url ?? "invalid:",
  };
}
