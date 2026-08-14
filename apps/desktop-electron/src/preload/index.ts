import { contextBridge, ipcRenderer } from "electron";

import {
  desktopProtocolVersion,
  ipcChannels,
  workerHealthResponseSchema,
  type Voice2TextDesktopApi,
} from "../shared/contracts";

const api: Voice2TextDesktopApi = Object.freeze({
  async workerHealth() {
    const response: unknown = await ipcRenderer.invoke(
      ipcChannels.workerHealth,
      {
        expectedProtocolVersion: desktopProtocolVersion,
      },
    );
    return workerHealthResponseSchema.parse(response);
  },
});

contextBridge.exposeInMainWorld("voice2text", api);
