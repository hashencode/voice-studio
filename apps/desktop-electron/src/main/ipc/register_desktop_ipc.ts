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
    ipcChannels.companionSnapshotGet,
    ipcChannels.companionOptInSet,
    ipcChannels.companionPairingInviteCreate,
    ipcChannels.companionPeerRevoke,
    ipcChannels.companionTransferCancel,
    ipcChannels.companionTransferRetry,
    ipcChannels.aiSettingsGet,
    ipcChannels.aiSettingsSave,
    ipcChannels.aiSecretReplace,
    ipcChannels.aiSecretDelete,
    ipcChannels.meetingAiPrepare,
    ipcChannels.meetingAiSnapshotGet,
    ipcChannels.meetingAiGenerate,
    ipcChannels.meetingAiRetry,
    ipcChannels.applicationSnapshot,
    ipcChannels.applicationNavigate,
    ipcChannels.applicationBootstrapAction,
    ipcChannels.workerHealth,
    ipcChannels.cancelProcessing,
    ipcChannels.retryProcessing,
    ipcChannels.processingTasks,
    ipcChannels.importMeeting,
    ipcChannels.capturePreflight,
    ipcChannels.captureStart,
    ipcChannels.captureControl,
    ipcChannels.captureRecoveryList,
    ipcChannels.captureRecoveryAction,
    ipcChannels.captionSnapshotGet,
    ipcChannels.captionFormalRetry,
    ipcChannels.meetingList,
    ipcChannels.meetingOpen,
    ipcChannels.meetingSearch,
    ipcChannels.meetingEditSegment,
    ipcChannels.meetingUndo,
    ipcChannels.meetingRedo,
    ipcChannels.meetingRenameSpeaker,
    ipcChannels.meetingMergeSpeakers,
    ipcChannels.meetingAssignSpeaker,
    ipcChannels.meetingPlayback,
    ipcChannels.meetingExport,
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
  const unsubscribeCaption = services.onCaptionSnapshot?.((snapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(ipcChannels.captionSnapshotEvent, snapshot);
    }
  });
  const unsubscribeMeetingAi = services.onMeetingAiSnapshot?.((snapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(ipcChannels.meetingAiSnapshotEvent, snapshot);
    }
  });
  const unsubscribeCompanion = services.onCompanionSnapshot?.((snapshot) => {
    if (!window.isDestroyed()) {
      window.webContents.send(ipcChannels.companionSnapshotEvent, snapshot);
    }
  });
  return () => {
    unsubscribeSnapshot?.();
    unsubscribeOperation?.();
    unsubscribeCaption?.();
    unsubscribeMeetingAi?.();
    unsubscribeCompanion?.();
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

function invocationContext(
  event: IpcMainInvokeEvent,
  window: BrowserWindow,
  trustedFrameId: number,
): IpcInvocationContext {
  const frame = event.senderFrame;
  const currentMainFrame = window.webContents.mainFrame;
  const isCurrentMainFrame =
    frame != null &&
    frame.routingId === currentMainFrame.routingId &&
    frame.processId === currentMainFrame.processId &&
    frame.parent === null &&
    frame.url === window.webContents.getURL();
  if (process.env.VOICE2TEXT_PROCESSING_SMOKE_OUTPUT && !isCurrentMainFrame) {
    console.error(
      JSON.stringify({
        event: "electron-ipc-main-frame-mismatch",
        senderMatches: event.sender === window.webContents,
        routingMatches: frame?.routingId === currentMainFrame.routingId,
        processMatches: frame?.processId === currentMainFrame.processId,
        parentIsNull: frame?.parent === null,
        urlMatches: frame?.url === window.webContents.getURL(),
        frameUrl: packagedUrlSuffix(frame?.url),
        currentUrl: packagedUrlSuffix(window.webContents.getURL()),
      }),
    );
  }
  return {
    senderId: event.sender === window.webContents ? event.sender.id : -1,
    frameId: isCurrentMainFrame ? trustedFrameId : -1,
    origin: frame?.url ?? "invalid:",
  };
}

function packagedUrlSuffix(value: string | undefined): string {
  if (!value) return "missing";
  const marker = "app.asar/";
  const index = value.indexOf(marker);
  return index < 0 ? "outside-app-asar" : value.slice(index + marker.length);
}
