import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";

import { ipcChannels } from "../../shared/contracts";
import {
  createDesktopIpcHandlers,
  IpcContractError,
  type DesktopIpcHandlers,
  type DesktopIpcServices,
  type IpcInvocationContext,
  type IpcTrustPolicy,
} from "./desktop_ipc";

export const desktopIpcInvokeChannels = [
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
  ipcChannels.audioAiPrepare,
  ipcChannels.audioAiSnapshotGet,
  ipcChannels.audioAiGenerate,
  ipcChannels.audioAiRetry,
  ipcChannels.applicationSnapshot,
  ipcChannels.applicationNavigate,
  ipcChannels.applicationBootstrapAction,
  ipcChannels.applicationActivityAcknowledge,
  ipcChannels.workerHealth,
  ipcChannels.cancelProcessing,
  ipcChannels.retryProcessing,
  ipcChannels.processingTasks,
  ipcChannels.importAudio,
  ipcChannels.capturePreflight,
  ipcChannels.captureStart,
  ipcChannels.captureControl,
  ipcChannels.captureRecoveryList,
  ipcChannels.captureRecoveryAction,
  ipcChannels.floatingCaptureSnapshotGet,
  ipcChannels.floatingCaptureControl,
  ipcChannels.floatingCaptureWindowAction,
  ipcChannels.floatingCapturePreferenceGet,
  ipcChannels.floatingCapturePreferenceSet,
  ipcChannels.captionSnapshotGet,
  ipcChannels.captionFormalRetry,
  ipcChannels.audioList,
  ipcChannels.audioOpen,
  ipcChannels.audioSearch,
  ipcChannels.audioEditSegment,
  ipcChannels.audioUndo,
  ipcChannels.audioRedo,
  ipcChannels.audioRenameSpeaker,
  ipcChannels.audioMergeSpeakers,
  ipcChannels.audioAssignSpeaker,
  ipcChannels.audioPlayback,
  ipcChannels.audioExport,
] as const;

type DesktopIpcInvokeChannel = (typeof desktopIpcInvokeChannels)[number];
type DesktopIpcEventChannel =
  | typeof ipcChannels.applicationSnapshotEvent
  | typeof ipcChannels.operationEvent
  | typeof ipcChannels.captionSnapshotEvent
  | typeof ipcChannels.audioAiSnapshotEvent
  | typeof ipcChannels.companionSnapshotEvent
  | typeof ipcChannels.floatingCaptureSnapshotEvent;

export type DesktopIpcWindowCapability = "main" | "floating-capture";

export interface DesktopIpcWindowRegistrationOptions {
  capability: DesktopIpcWindowCapability;
  origins?: ReadonlySet<string>;
  fileUrls?: ReadonlySet<string>;
}

export interface DesktopIpcRegistry {
  registerWindow(
    window: BrowserWindow,
    options: DesktopIpcWindowRegistrationOptions,
  ): () => void;
  dispose(): void;
}

type IpcMainRegistrar = Pick<IpcMain, "handle" | "removeHandler">;

interface RegisteredWindow {
  readonly window: BrowserWindow;
  readonly frameId: number;
  readonly trust: IpcTrustPolicy;
  readonly invokeChannels: ReadonlySet<DesktopIpcInvokeChannel>;
  readonly eventChannels: ReadonlySet<DesktopIpcEventChannel>;
  unregister(): void;
}

const activeRegistries = new WeakSet<object>();
let compatibilityRegistry: DesktopIpcRegistry | null = null;
const floatingInvokeChannels = new Set<DesktopIpcInvokeChannel>([
  ipcChannels.floatingCaptureSnapshotGet,
  ipcChannels.floatingCaptureControl,
  ipcChannels.floatingCaptureWindowAction,
]);
const mainInvokeChannels = new Set<DesktopIpcInvokeChannel>(
  desktopIpcInvokeChannels.filter(
    (channel) => !floatingInvokeChannels.has(channel),
  ),
);
const mainEventChannels = new Set<DesktopIpcEventChannel>([
  ipcChannels.applicationSnapshotEvent,
  ipcChannels.operationEvent,
  ipcChannels.captionSnapshotEvent,
  ipcChannels.audioAiSnapshotEvent,
  ipcChannels.companionSnapshotEvent,
]);
const floatingEventChannels = new Set<DesktopIpcEventChannel>([
  ipcChannels.floatingCaptureSnapshotEvent,
]);

/**
 * Owns Electron's process-wide invoke handlers and routes each invocation to a
 * registered, trusted main frame with a capability-specific channel set.
 */
export function createDesktopIpcRegistry(
  services: DesktopIpcServices,
  ipc: IpcMainRegistrar = ipcMain,
): DesktopIpcRegistry {
  if (activeRegistries.has(ipc)) {
    throw new Error("desktop IPC handlers are already registered");
  }
  activeRegistries.add(ipc);

  const windows = new Map<number, RegisteredWindow>();
  const handlers: DesktopIpcHandlers = createDesktopIpcHandlers({ services });
  let disposed = false;
  const installedChannels: DesktopIpcInvokeChannel[] = [];

  try {
    for (const channel of desktopIpcInvokeChannels) {
      ipc.handle(channel, async (event, payload: unknown) => {
        const registered = windows.get(event.sender.id);
        if (!registered || registered.window.webContents !== event.sender) {
          throw untrustedSender("IPC sender is not registered");
        }
        if (!registered.invokeChannels.has(channel)) {
          throw untrustedSender("IPC channel is not allowed for this window");
        }
        return await handlers.invokeWithTrust(
          channel,
          invocationContext(event, registered.window, registered.frameId),
          payload,
          registered.trust,
        );
      });
      installedChannels.push(channel);
    }
  } catch (error) {
    for (const channel of installedChannels) ipc.removeHandler(channel);
    activeRegistries.delete(ipc);
    throw error;
  }

  const unsubscribers = [
    subscribe(services.onApplicationSnapshot, (snapshot) => {
      fanOut(ipcChannels.applicationSnapshotEvent, snapshot);
    }),
    subscribe(services.onOperationEvent, (event) => {
      fanOut(ipcChannels.operationEvent, event);
    }),
    subscribe(services.onCaptionSnapshot, (snapshot) => {
      fanOut(ipcChannels.captionSnapshotEvent, snapshot);
    }),
    subscribe(services.onAudioAiSnapshot, (snapshot) => {
      fanOut(ipcChannels.audioAiSnapshotEvent, snapshot);
    }),
    subscribe(services.onCompanionSnapshot, (snapshot) => {
      fanOut(ipcChannels.companionSnapshotEvent, snapshot);
    }),
    subscribe(services.onFloatingCaptureSnapshot, (snapshot) => {
      fanOut(ipcChannels.floatingCaptureSnapshotEvent, snapshot);
    }),
  ];

  function fanOut(channel: DesktopIpcEventChannel, payload: unknown): void {
    for (const registered of windows.values()) {
      if (
        registered.eventChannels.has(channel) &&
        !registered.window.isDestroyed()
      ) {
        registered.window.webContents.send(channel, payload);
      }
    }
  }

  function registerWindow(
    window: BrowserWindow,
    options: DesktopIpcWindowRegistrationOptions,
  ): () => void {
    if (disposed) throw new Error("desktop IPC registry is disposed");
    const senderId = window.webContents.id;
    if (windows.has(senderId)) {
      throw new Error(`desktop IPC sender ${senderId} is already registered`);
    }

    const frameId = window.webContents.mainFrame.routingId;
    const capability = capabilityProfile(options.capability);
    let unregistered = false;
    const unregister = () => {
      if (unregistered) return;
      unregistered = true;
      if (windows.get(senderId) === registered) windows.delete(senderId);
      window.off("closed", unregister);
      window.webContents.off("destroyed", unregister);
    };
    const registered: RegisteredWindow = {
      window,
      frameId,
      trust: {
        senderId,
        frameId,
        origins: new Set(options.origins ?? []),
        fileUrls: new Set(options.fileUrls ?? []),
      },
      invokeChannels: capability.invokeChannels,
      eventChannels: capability.eventChannels,
      unregister,
    };
    windows.set(senderId, registered);
    window.on("closed", unregister);
    window.webContents.on("destroyed", unregister);
    return unregister;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const registered of windows.values()) registered.unregister();
    for (const unsubscribe of unsubscribers) unsubscribe?.();
    for (const channel of installedChannels) ipc.removeHandler(channel);
    activeRegistries.delete(ipc);
  }

  return { registerWindow, dispose };
}

/** Compatibility adapter for the single-main-window bootstrap. */
export function registerDesktopIpc(
  window: BrowserWindow,
  services: DesktopIpcServices,
): () => void {
  const registry = createDesktopIpcRegistry(services);
  compatibilityRegistry = registry;
  let unregisterWindow: () => void;
  try {
    unregisterWindow = registry.registerWindow(window, {
      capability: "main",
      ...mainWindowLocations(),
    });
  } catch (error) {
    registry.dispose();
    throw error;
  }
  return () => {
    unregisterWindow();
    registry.dispose();
    if (compatibilityRegistry === registry) compatibilityRegistry = null;
  };
}

export function registerAdditionalDesktopIpcWindow(
  window: BrowserWindow,
  options: DesktopIpcWindowRegistrationOptions,
): () => void {
  if (!compatibilityRegistry) {
    throw new Error("desktop IPC registry is not initialized");
  }
  return compatibilityRegistry.registerWindow(window, options);
}

function capabilityProfile(capability: DesktopIpcWindowCapability): {
  invokeChannels: ReadonlySet<DesktopIpcInvokeChannel>;
  eventChannels: ReadonlySet<DesktopIpcEventChannel>;
} {
  if (capability === "main") {
    return {
      invokeChannels: mainInvokeChannels,
      eventChannels: mainEventChannels,
    };
  }
  return {
    invokeChannels: floatingInvokeChannels,
    eventChannels: floatingEventChannels,
  };
}

function mainWindowLocations(): Pick<
  DesktopIpcWindowRegistrationOptions,
  "origins" | "fileUrls"
> {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    return {
      origins: new Set([new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin]),
    };
  }
  return {
    fileUrls: new Set([
      pathToFileURL(
        path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      ).href,
    ]),
  };
}

function subscribe<T>(
  source: ((listener: (value: T) => void) => () => void) | undefined,
  listener: (value: T) => void,
): (() => void) | undefined {
  return source?.(listener);
}

function untrustedSender(message: string): IpcContractError {
  return new IpcContractError("UNTRUSTED_SENDER", message);
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
