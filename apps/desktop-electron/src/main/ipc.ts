import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";

import { ipcChannels, workerHealthRequestSchema } from "../shared/contracts";
import type { WorkerHealthSupervisor } from "./worker_health";

export function registerDesktopIpc(
  window: BrowserWindow,
  workerSupervisor: WorkerHealthSupervisor,
): () => void {
  ipcMain.handle(ipcChannels.workerHealth, async (event, payload: unknown) => {
    assertTrustedSender(event, window);
    workerHealthRequestSchema.parse(payload);
    return await workerSupervisor.check();
  });

  return () => ipcMain.removeHandler(ipcChannels.workerHealth);
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
): void {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("IPC sender is not the main Voice2Text frame");
  }
  const url = new URL(event.senderFrame.url);
  const allowedDevelopmentUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : null;
  const trusted = allowedDevelopmentUrl
    ? url.origin === allowedDevelopmentUrl.origin
    : url.protocol === "file:";
  if (!trusted) throw new Error("IPC sender origin is not trusted");
}
