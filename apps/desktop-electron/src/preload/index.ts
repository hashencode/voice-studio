import { contextBridge, ipcRenderer } from "electron";

import { createDesktopApi } from "./api";

const subscriptionWrappers = new Map<
  (payload: unknown) => void,
  (event: Electron.IpcRendererEvent, payload: unknown) => void
>();
const api = createDesktopApi({
  invoke: async (channel, payload) =>
    await ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapper = (_event: Electron.IpcRendererEvent, payload: unknown) =>
      listener(payload);
    subscriptionWrappers.set(listener, wrapper);
    ipcRenderer.on(channel, wrapper);
  },
  off: (channel, listener) => {
    const wrapper = subscriptionWrappers.get(listener);
    if (!wrapper) return;
    subscriptionWrappers.delete(listener);
    ipcRenderer.removeListener(channel, wrapper);
  },
});

contextBridge.exposeInMainWorld("voice2text", api);
