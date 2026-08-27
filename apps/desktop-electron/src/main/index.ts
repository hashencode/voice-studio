import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";

import {
  desktopProtocolVersion,
  ipcChannels,
  type BootstrapAction,
  type ImportAudioResponse,
  type OperationEvent,
  type CaptureSnapshot,
  type CaptionSnapshot,
  type AudioAiSnapshot,
  type CompanionSnapshot,
  type FloatingCaptureSnapshot,
  type FloatingCaptureWindowAction,
} from "../shared/contracts";
import { DesktopApplicationState } from "./application/application_state";
import { configureRuntimeIdentity } from "./application/runtime_identity";
import {
  deriveFloatingCaptureSnapshot,
  hasSameFloatingCapturePresentation,
} from "./application/floating_capture_projection";
import {
  buildProcessingSmokeEvidence,
  parseProcessingSmokeReferenceBindings,
  type ProcessingSmokeReferenceBindings,
} from "./application/processing_smoke_evidence";
import { runPrimaryInstance } from "./application/single_instance";
import { registerAdditionalDesktopIpcWindow, registerDesktopIpc } from "./ipc";
import { canceledResponse, queuedResponse } from "./ipc/desktop_ipc";
import { DesktopDomainService } from "./domain/desktop_domain_service";
import { SecureImportDomainService } from "./domain/importing/secure_import_domain_service";
import {
  cleanupExpiredOrphanedImportedMedia,
  cleanupExpiredTemporaryWorkspaces,
} from "./domain/processing/temporary_workspace_cleanup";
import { resolveMacOSNativeHelper } from "./features/importing/helper_locator";
import {
  MacOSNativeHelperClient,
  type MacOSNativeHelperSession,
} from "./features/importing/macos_native_helper_client";
import { DesktopCaptureService } from "./domain/capture/desktop_capture_service";
import type { CaptureNativePort } from "./domain/capture/capture_native_port";
import { MacOSCaptureNativePort } from "./domain/capture/macos_capture_native_port";
import { MicrophoneTestService } from "./domain/capture/microphone_test_service";
import { openMicrophoneSettings } from "./domain/capture/microphone_settings";
import {
  activeCaptureQuitDialog,
  captureIsRunning,
  captureRequiresSnapshotPolling,
  captureRequiresQuitConfirmation,
} from "./domain/capture/capture_lifecycle_policy";
import {
  capturePreflightAllowsStart,
  hasVerifiedLiveCaptionCapability,
} from "./domain/capture/capture_capability";
import { requestMicrophonePermissionIfNeeded } from "./domain/capture/capture_permission";
import { listAvailableCaptureRecoveries } from "./domain/capture/capture_availability";
import { BrowserWindowPlaybackPort } from "./features/playback/browser_window_playback_port";
import { AudioPlaybackService } from "./features/playback/audio_playback_service";
import { AudioExportService } from "./domain/workspace/audio_export_service";
import { writeExportAtomically } from "./domain/workspace/atomic_export_writer";
import { AudioWorkspaceService } from "./domain/workspace/audio_workspace_service";
import {
  DurableProcessCoordinator,
  ProcessCanceledError,
} from "./processes/durable_process_coordinator";
import {
  adaptExistingAsrWorkerFrame,
  finalizeExistingSherpaResult,
} from "./processes/existing_asr_worker_adapter";
import {
  OwnedProcessSupervisor,
  ProcessDeadlineError,
  WorkerReportedError,
} from "./processes/owned_process_supervisor";
import { prepareProcessingAttempt } from "./processes/processing_attempt";
import { initializeAudioProfile } from "./profile/audio_profile";
import type { AudioProfilePaths } from "./profile/audio_profile";
import {
  assertAuthorizedResourceCommand,
  ResourceCatalog,
  requireProcessingPipelineIdentities,
  resolveResourceRoot,
} from "./resources/resource_catalog";
import { LocalModelService } from "./resources/local_model_service";
import { ModelLeaseCoordinator } from "./resources/model_lease_coordinator";
import { ModelStore } from "./resources/model_store";
import { ModelStorageAccess } from "./resources/model_storage_access";
import { secureWebPreferences } from "./security";
import { sha256File } from "./security/sha256_file";
import { DesktopRepository } from "./storage/desktop_repository";
import { AudioWorkspaceRepository } from "./storage/repositories/audio_workspace_repository";
import { CaptureRepository } from "./storage/repositories/capture_repository";
import { TranscriptRepository } from "./storage/repositories/transcript_repository";
import { LiveCaptionService } from "./domain/captions/live_caption_service";
import { CaptionWorkerSupervisor } from "./processes/caption_worker_supervisor";
import { FormalTranscriptHandoffService } from "./domain/captions/formal_transcript_handoff_service";
import { prepareFormalCaptureMedia } from "./domain/captions/formal_capture_media";
import { finalizeCommittedCaptureTranscript } from "./domain/captions/capture_formal_completion";
import { AudioAiService } from "./domain/audio-intelligence/audio_ai_service";
import { parseRemoteAiEndpoint } from "./domain/audio-intelligence/provider_security";
import { AiJobRepository } from "./storage/repositories/ai_job_repository";
import { MacOSHelperSecretStore } from "./features/secrets/macos_helper_secret_store";
import { UnavailableDesktopSecretStore } from "./features/secrets/secret_store_port";
import { CompanionService } from "./domain/companion/companion_service";
import { CompanionReceiver } from "./domain/companion/companion_receiver";
import { CompanionImportCoordinator } from "./domain/companion/companion_import_coordinator";
import { validatePinnedMediaAuthority } from "./security/pinned_media_authority";
import { MacOSCompanionNativeAdapter } from "./features/companion/macos_companion_native_adapter";
import { TransferRepository } from "./storage/repositories/transfer_repository";
import { WorkerHealthSupervisor } from "./worker_health";

let bootstrapSmokeRequest: BootstrapSmokeRequest | null = null;
let processingSmokeRequest: ProcessingSmokeRequest | null = null;
let captureSmokeRequest: CaptureSmokeRequest | null = null;
let captionFormalSmokeRequest: CaptionFormalSmokeRequest | null = null;
let aiBoundarySmokeRequest: AiBoundarySmokeRequest | null = null;
let companionSmokeRequest: CompanionSmokeRequest | null = null;
try {
  bootstrapSmokeRequest = readBootstrapSmokeRequest();
  processingSmokeRequest = readProcessingSmokeRequest();
  captureSmokeRequest = readCaptureSmokeRequest();
  captionFormalSmokeRequest = readCaptionFormalSmokeRequest();
  aiBoundarySmokeRequest = readAiBoundarySmokeRequest();
  companionSmokeRequest = readCompanionSmokeRequest();
} catch (error) {
  reportBootstrapFailure("request-parse", error);
  app.exit(78);
}
if (
  [
    bootstrapSmokeRequest,
    processingSmokeRequest,
    captureSmokeRequest,
    captionFormalSmokeRequest,
    aiBoundarySmokeRequest,
    companionSmokeRequest,
  ].filter(Boolean).length > 1
) {
  throw new Error("packaged smoke modes are mutually exclusive");
}
const smokeAppDataPath =
  bootstrapSmokeRequest?.appDataPath ??
  processingSmokeRequest?.appDataPath ??
  captureSmokeRequest?.appDataPath ??
  captionFormalSmokeRequest?.appDataPath ??
  aiBoundarySmokeRequest?.appDataPath ??
  companionSmokeRequest?.appDataPath;
if (smokeAppDataPath) {
  const smokeUserData = path.join(smokeAppDataPath, "electron-user-data");
  mkdirSync(smokeUserData, { recursive: true, mode: 0o700 });
  app.setPath("appData", smokeAppDataPath);
  app.setPath("userData", smokeUserData);
}
configureRuntimeIdentity(app);
const isPrimaryInstance = runPrimaryInstance(app, () => app.enableSandbox());

interface BootstrapSmokeRequest {
  appDataPath: string;
  outputPath: string;
}

interface ProcessingSmokeRequest {
  appDataPath: string;
  outputPath: string;
  sourcePath: string;
  referenceBindings: ProcessingSmokeReferenceBindings;
  workstationOutputPath: string | null;
}

interface CaptureSmokeRequest {
  appDataPath: string;
  outputPath: string;
  phase: "initialize" | "crash" | "verify";
}

interface CaptionFormalSmokeRequest {
  appDataPath: string;
  outputPath: string;
  sourcePath: string;
  phase: "run" | "verify";
}

interface AiBoundarySmokeRequest {
  appDataPath: string;
  outputPath: string;
}

interface CompanionSmokeRequest {
  appDataPath: string;
  outputPath: string;
  readyPath: string;
  credentialStorePath: string;
  phase: "pair-checkpoint" | "run" | "verify";
  identitySeed: Buffer;
  expectedTransferId: string;
  expectedSourceSha256: string;
}

let captionFormalSmokeAuthority: {
  sessionId: string;
  recordingSha256: string;
  journalSha256: string;
} | null = null;

let mainWindow: BrowserWindow | null = null;
let unregisterIpc: (() => void) | null = null;
let floatingCaptureWindow: BrowserWindow | null = null;
let unregisterFloatingIpc: (() => void) | null = null;
let floatingCaptureEnabled = false;
let floatingSuppressedSessionId: string | null = null;
let floatingLoadFailedSessionId: string | null = null;
let lastFloatingCapturePresentation: FloatingCaptureSnapshot | null = null;
let floatingPresentedSessionId: string | null = null;
let floatingPreferenceMutation: Promise<void> = Promise.resolve();
let captureControlMutation: Promise<void> = Promise.resolve();
let workerSupervisor: WorkerHealthSupervisor | null = null;
let processCoordinator: DurableProcessCoordinator | null = null;
let profileDatabase: DatabaseSync | null = null;
let profilePaths: AudioProfilePaths | null = null;
let domainService: DesktopDomainService | null = null;
let desktopRepository: DesktopRepository | null = null;
let transcriptRepository: TranscriptRepository | null = null;
let liveCaptionService: LiveCaptionService | null = null;
let formalTranscriptHandoff: FormalTranscriptHandoffService | null = null;
let audioWorkspaceService: AudioWorkspaceService | null = null;
let audioExportService: AudioExportService | null = null;
let audioPlaybackService: AudioPlaybackService | null = null;
let audioAiService: AudioAiService | null = null;
let companionService: CompanionService | null = null;
let companionNativeAdapter: MacOSCompanionNativeAdapter | null = null;
let unsubscribeCompanion: (() => void) | null = null;
let resourceCatalog: ResourceCatalog | null = null;
let localModelService: LocalModelService | null = null;
let modelLeaseCoordinator: ModelLeaseCoordinator | null = null;
let modelStorageAccess: ModelStorageAccess | null = null;
let captureService: DesktopCaptureService | null = null;
let captureNativeSession: MacOSNativeHelperSession | null = null;
let microphoneTestService: MicrophoneTestService | null = null;
let captureTray: Tray | null = null;
let activeCaptureTitle = "音频录制";
let captureLifecycleBound = false;
let capturePollTimer: ReturnType<typeof setInterval> | null = null;
let capturePollInFlight = false;
let captureSmokeQuitChoices: number[] = [];
let captureSmokeQuitEvidence: Record<string, unknown> | null = null;
let captureSmokeBeforeQuitAttempts = 0;
let captureSmokeContinueObserved = false;
let captureSmokeStopCalls = 0;
let teardownStarted = false;
let teardownPromise: Promise<void> | null = null;
let teardownComplete = false;
let bootstrapPromise: Promise<void> | null = null;
let processingLoop: Promise<void> | null = null;
const packagedProgressObservationTimeoutMs = 30_000;
const applicationState = new DesktopApplicationState();
const operationListeners = new Set<(event: OperationEvent) => void>();
const captionListeners = new Set<(snapshot: CaptionSnapshot) => void>();
const audioAiListeners = new Set<(snapshot: AudioAiSnapshot) => void>();
const companionListeners = new Set<(snapshot: CompanionSnapshot) => void>();
const localModelListeners = new Set<
  (snapshot: import("../shared/contracts").LocalModelSnapshot) => void
>();
const floatingCaptureListeners = new Set<
  (snapshot: FloatingCaptureSnapshot) => void
>();

applicationState.subscribe((snapshot) => {
  const floating = deriveFloatingCaptureSnapshot(snapshot);
  if (
    floating.sessionId === null ||
    floating.sessionId !== floatingSuppressedSessionId
  ) {
    floatingSuppressedSessionId = null;
  }
  if (
    floating.sessionId === null ||
    floating.sessionId !== floatingLoadFailedSessionId
  ) {
    floatingLoadFailedSessionId = null;
  }
  if (
    hasSameFloatingCapturePresentation(
      lastFloatingCapturePresentation,
      floating,
    )
  ) {
    return;
  }
  lastFloatingCapturePresentation = floating;
  reconcileFloatingCapturePresentation(floating);
  if (floatingCaptureWindow?.isVisible()) {
    for (const listener of floatingCaptureListeners) listener(floating);
  }
});

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: "Voice2Text",
    webPreferences: secureWebPreferences(path.join(__dirname, "preload.js")),
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && !isTrustedNavigation(currentUrl, targetUrl)) {
      event.preventDefault();
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("focus", () => floatingCaptureWindow?.hide());
  window.on("blur", () =>
    reconcileFloatingCapturePresentation(
      deriveFloatingCaptureSnapshot(applicationState.snapshot()),
    ),
  );
  window.on("minimize", () =>
    reconcileFloatingCapturePresentation(
      deriveFloatingCaptureSnapshot(applicationState.snapshot()),
    ),
  );
  window.on("hide", () =>
    reconcileFloatingCapturePresentation(
      deriveFloatingCaptureSnapshot(applicationState.snapshot()),
    ),
  );
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    if (process.platform !== "darwin" && !teardownComplete) app.quit();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  return window;
}

function createFloatingCaptureWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 320,
    height: 96,
    minWidth: 320,
    maxWidth: 320,
    minHeight: 72,
    maxHeight: 112,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    fullscreenable: false,
    title: "Voice2Text 录制控制",
    webPreferences: secureWebPreferences(
      path.join(__dirname, "floating-preload.js"),
    ),
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl && !isTrustedNavigation(currentUrl, targetUrl)) {
      event.preventDefault();
    }
  });
  window.on("close", (event) => {
    if (teardownStarted) return;
    event.preventDefault();
    floatingSuppressedSessionId = deriveFloatingCaptureSnapshot(
      applicationState.snapshot(),
    ).sessionId;
    window.hide();
  });
  window.on("closed", () => {
    unregisterFloatingIpc?.();
    unregisterFloatingIpc = null;
    if (floatingCaptureWindow === window) floatingCaptureWindow = null;
  });

  let loadPromise: Promise<void>;
  if (FLOATING_CAPTURE_WINDOW_VITE_DEV_SERVER_URL) {
    const url = FLOATING_CAPTURE_WINDOW_VITE_DEV_SERVER_URL;
    loadPromise = window.loadURL(url);
  } else {
    const filePath = path.join(
      __dirname,
      `../renderer/${FLOATING_CAPTURE_WINDOW_VITE_NAME}/floating.html`,
    );
    loadPromise = window.loadFile(filePath);
  }
  unregisterFloatingIpc = registerFloatingCaptureIpc(window);
  void loadPromise.catch(() => {
    console.error("Floating capture controller failed to load");
    floatingLoadFailedSessionId = deriveFloatingCaptureSnapshot(
      applicationState.snapshot(),
    ).sessionId;
    if (!window.isDestroyed()) window.destroy();
  });
  return window;
}

function registerFloatingCaptureIpc(window: BrowserWindow): () => void {
  if (FLOATING_CAPTURE_WINDOW_VITE_DEV_SERVER_URL) {
    return registerAdditionalDesktopIpcWindow(window, {
      capability: "floating-capture",
      origins: new Set([
        new URL(FLOATING_CAPTURE_WINDOW_VITE_DEV_SERVER_URL).origin,
      ]),
    });
  }
  const filePath = path.join(
    __dirname,
    `../renderer/${FLOATING_CAPTURE_WINDOW_VITE_NAME}/floating.html`,
  );
  return registerAdditionalDesktopIpcWindow(window, {
    capability: "floating-capture",
    fileUrls: new Set([pathToFileURL(filePath).href]),
  });
}

function reconcileFloatingCapturePresentation(
  snapshot: FloatingCaptureSnapshot,
  forcePosition = false,
): void {
  if (!app.isReady()) return;
  const active = snapshot.phase !== "idle";
  const mainProminent = Boolean(
    mainWindow?.isVisible() &&
    !mainWindow.isMinimized() &&
    mainWindow.isFocused(),
  );
  if (
    !floatingCaptureEnabled ||
    !active ||
    mainProminent ||
    snapshot.sessionId === floatingSuppressedSessionId
  ) {
    if (floatingCaptureWindow?.isVisible()) floatingCaptureWindow.hide();
    floatingPresentedSessionId = null;
    return;
  }
  if (snapshot.sessionId === floatingLoadFailedSessionId) return;
  floatingCaptureWindow ??= createFloatingCaptureWindow();
  const visible = floatingCaptureWindow.isVisible();
  if (
    !forcePosition &&
    visible &&
    floatingPresentedSessionId === snapshot.sessionId
  ) {
    return;
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = floatingCaptureWindow.getBounds();
  const x = display.workArea.x + display.workArea.width - bounds.width - 16;
  const y = display.workArea.y + 16;
  if (bounds.x !== x || bounds.y !== y) {
    floatingCaptureWindow.setPosition(x, y, false);
  }
  if (!visible) floatingCaptureWindow.showInactive();
  floatingPresentedSessionId = snapshot.sessionId;
}

function setFloatingCapturePreference(enabled: boolean): Promise<{
  enabled: boolean;
}> {
  const operation = floatingPreferenceMutation.then(async () => {
    const preferencePath = path.join(
      app.getPath("userData"),
      "floating-capture-preference.json",
    );
    const temporaryPath = `${preferencePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ enabled })}\n`, {
        mode: 0o600,
      });
      await rename(temporaryPath, preferencePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    floatingCaptureEnabled = enabled;
    floatingSuppressedSessionId = null;
    floatingLoadFailedSessionId = null;
    if (!enabled) {
      floatingCaptureWindow?.hide();
    } else {
      reconcileFloatingCapturePresentation(
        deriveFloatingCaptureSnapshot(applicationState.snapshot()),
      );
    }
    return { enabled };
  });
  floatingPreferenceMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function loadFloatingCapturePreference(): void {
  const preferencePath = path.join(
    app.getPath("userData"),
    "floating-capture-preference.json",
  );
  try {
    floatingCaptureEnabled =
      JSON.parse(readFileSync(preferencePath, "utf8")).enabled === true;
  } catch {
    floatingCaptureEnabled = false;
  }
}

async function handleFloatingWindowAction(
  action: FloatingCaptureWindowAction,
): Promise<FloatingCaptureSnapshot> {
  const snapshot = deriveFloatingCaptureSnapshot(applicationState.snapshot());
  if (action === "hide") {
    floatingSuppressedSessionId = snapshot.sessionId;
    floatingCaptureWindow?.hide();
  } else if (action === "turn-off") {
    await setFloatingCapturePreference(false);
  } else {
    floatingCaptureWindow?.hide();
    showMainWindow({ openCaptureDetails: true });
  }
  return snapshot;
}

function showMainWindow({
  openCaptureDetails = false,
}: {
  openCaptureDetails?: boolean;
} = {}): BrowserWindow {
  const created = !mainWindow || mainWindow.isDestroyed();
  if (created) {
    mainWindow = createMainWindow();
    bindDesktopIpc(mainWindow);
  }
  const window = mainWindow;
  if (!window) throw new Error("main window could not be created");
  const reveal = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (openCaptureDetails) {
      window.webContents.send(ipcChannels.captureDetailsRequestedEvent);
    }
  };
  if (created || window.webContents.isLoadingMainFrame()) {
    window.webContents.once("did-finish-load", reveal);
  } else {
    reveal();
  }
  return window;
}

function isTrustedNavigation(current: string, target: string): boolean {
  const currentUrl = new URL(current);
  const targetUrl = new URL(target);
  if (currentUrl.protocol === "file:" || targetUrl.protocol === "file:") {
    return currentUrl.href === targetUrl.href;
  }
  return currentUrl.origin === targetUrl.origin;
}

function configureSessionSecurity(): void {
  const currentSession = session.defaultSession;
  currentSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    const connectSource = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? ` 'self' ${new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin} ws://localhost:*`
      : " 'self'";
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' file:; connect-src${connectSource}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });
}

async function runBootstrapSmokeIfRequested(): Promise<void> {
  const request = bootstrapSmokeRequest;
  if (!request) return;
  if (!workerSupervisor) {
    throw new Error("packaged bootstrap smoke worker is unavailable");
  }
  const worker = await workerSupervisor.check();
  const receipt = {
    schemaVersion: 1,
    appVersion: app.getVersion(),
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    worker,
  };
  const temporaryPath = `${request.outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, request.outputPath);
  app.quit();
}

function readBootstrapSmokeRequest(): BootstrapSmokeRequest | null {
  const values = [
    process.env.VOICE2TEXT_BOOTSTRAP_SMOKE_APP_DATA,
    process.env.VOICE2TEXT_BOOTSTRAP_SMOKE_OUTPUT,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (!app.isPackaged || values.some((value) => !value)) {
    throw new Error(
      "packaged bootstrap smoke requires a complete packaged-only request",
    );
  }
  const [appDataRaw, outputRaw] = values as [string, string];
  const temporaryRoot = realpathSync(tmpdir());
  const appDataPath = realpathSync(path.resolve(appDataRaw));
  const outputPath = path.resolve(outputRaw);
  const outputParent = realpathSync(path.dirname(outputPath));
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent)
  ) {
    throw new Error("packaged bootstrap smoke paths are not private");
  }
  return { appDataPath, outputPath };
}

function readProcessingSmokeRequest(): ProcessingSmokeRequest | null {
  const values = [
    process.env.VOICE2TEXT_PROCESSING_SMOKE_APP_DATA,
    process.env.VOICE2TEXT_PROCESSING_SMOKE_OUTPUT,
    process.env.VOICE2TEXT_PROCESSING_SMOKE_SOURCE,
    process.env.VOICE2TEXT_PROCESSING_SMOKE_REFERENCE_BINDINGS,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (!app.isPackaged || values.some((value) => !value)) {
    throw new Error(
      "packaged processing smoke requires a complete packaged-only request",
    );
  }
  const [appDataRaw, outputRaw, sourceRaw, bindingsRaw] = values as [
    string,
    string,
    string,
    string,
  ];
  const temporaryRoot = realpathSync(tmpdir());
  const appDataPath = realpathSync(path.resolve(appDataRaw));
  const outputPath = path.resolve(outputRaw);
  const outputParent = realpathSync(path.dirname(outputPath));
  const sourcePath = realpathSync(path.resolve(sourceRaw));
  const workstationOutputRaw = process.env.VOICE2TEXT_WORKSTATION_SMOKE_OUTPUT;
  const workstationOutputPath = workstationOutputRaw
    ? path.resolve(workstationOutputRaw)
    : null;
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    lstatSync(sourcePath).isSymbolicLink() ||
    !lstatSync(sourcePath).isFile() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent) ||
    (workstationOutputPath !== null &&
      !isPathInside(
        temporaryRoot,
        realpathSync(path.dirname(workstationOutputPath)),
      ))
  ) {
    throw new Error("packaged processing smoke paths are not private");
  }
  return {
    appDataPath,
    outputPath,
    sourcePath,
    referenceBindings: parseProcessingSmokeReferenceBindings(bindingsRaw),
    workstationOutputPath,
  };
}

function readCaptureSmokeRequest(): CaptureSmokeRequest | null {
  const values = [
    process.env.VOICE2TEXT_CAPTURE_SMOKE_APP_DATA,
    process.env.VOICE2TEXT_CAPTURE_SMOKE_OUTPUT,
    process.env.VOICE2TEXT_CAPTURE_SMOKE_PHASE,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (!app.isPackaged || values.some((value) => !value)) {
    throw new Error(
      "packaged capture smoke requires a complete packaged-only request",
    );
  }
  const [appDataRaw, outputRaw, phaseRaw] = values as [string, string, string];
  if (
    phaseRaw !== "initialize" &&
    phaseRaw !== "crash" &&
    phaseRaw !== "verify"
  ) {
    throw new Error("packaged capture smoke phase is invalid");
  }
  const temporaryRoot = realpathSync(tmpdir());
  const appDataPath = realpathSync(path.resolve(appDataRaw));
  const outputPath = path.resolve(outputRaw);
  const outputParent = realpathSync(path.dirname(outputPath));
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent)
  ) {
    throw new Error("packaged capture smoke paths are not private");
  }
  return { appDataPath, outputPath, phase: phaseRaw };
}

function readCaptionFormalSmokeRequest(): CaptionFormalSmokeRequest | null {
  const values = [
    process.env.VOICE2TEXT_CAPTION_FORMAL_SMOKE_APP_DATA,
    process.env.VOICE2TEXT_CAPTION_FORMAL_SMOKE_OUTPUT,
    process.env.VOICE2TEXT_CAPTION_FORMAL_SMOKE_SOURCE,
    process.env.VOICE2TEXT_CAPTION_FORMAL_SMOKE_PHASE,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (!app.isPackaged || values.some((value) => !value)) {
    throw new Error(
      "packaged caption formal smoke requires a complete packaged-only request",
    );
  }
  const [appDataRaw, outputRaw, sourceRaw, phaseRaw] = values as [
    string,
    string,
    string,
    string,
  ];
  if (phaseRaw !== "run" && phaseRaw !== "verify") {
    throw new Error("packaged caption formal smoke phase is invalid");
  }
  const temporaryRoot = realpathSync(tmpdir());
  const appDataPath = realpathSync(path.resolve(appDataRaw));
  const outputPath = path.resolve(outputRaw);
  const outputParent = realpathSync(path.dirname(outputPath));
  const sourcePath = realpathSync(path.resolve(sourceRaw));
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    lstatSync(sourcePath).isSymbolicLink() ||
    !lstatSync(sourcePath).isFile() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent) ||
    !isPathInside(temporaryRoot, sourcePath)
  ) {
    throw new Error("packaged caption formal smoke paths are not private");
  }
  return { appDataPath, outputPath, sourcePath, phase: phaseRaw };
}

function readAiBoundarySmokeRequest(): AiBoundarySmokeRequest | null {
  const values = [
    process.env.VOICE2TEXT_AI_BOUNDARY_SMOKE_APP_DATA,
    process.env.VOICE2TEXT_AI_BOUNDARY_SMOKE_OUTPUT,
  ];
  if (values.every((value) => value === undefined)) return null;
  if (!app.isPackaged || values.some((value) => !value)) {
    throw new Error(
      "packaged AI boundary smoke requires a complete packaged-only request",
    );
  }
  const [appDataRaw, outputRaw] = values as [string, string];
  const temporaryRoot = realpathSync(tmpdir());
  const appDataPath = realpathSync(path.resolve(appDataRaw));
  const outputPath = path.resolve(outputRaw);
  const outputParent = realpathSync(path.dirname(outputPath));
  if (
    lstatSync(appDataPath).isSymbolicLink() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent)
  ) {
    throw new Error("packaged AI boundary smoke paths are not private");
  }
  return { appDataPath, outputPath };
}

function readCompanionSmokeRequest(): CompanionSmokeRequest | null {
  const requestRaw = process.env.VOICE2TEXT_COMPANION_SMOKE_REQUEST;
  if (requestRaw === undefined) return null;
  if (!app.isPackaged || requestRaw.length < 1) {
    throw new Error(
      "packaged companion smoke requires a packaged-only request file",
    );
  }
  const temporaryRoot = realpathSync(tmpdir());
  const requestedPath = path.resolve(requestRaw);
  const requestedStat = lstatSync(requestedPath);
  const requestPath = realpathSync(requestedPath);
  const parentPath = realpathSync(path.dirname(requestPath));
  const parentStat = lstatSync(parentPath);
  if (
    requestedStat.isSymbolicLink() ||
    !requestedStat.isFile() ||
    requestedStat.nlink !== 1 ||
    (requestedStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" &&
      requestedStat.uid !== process.getuid()) ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o077) !== 0 ||
    !isPathInside(temporaryRoot, requestPath)
  ) {
    throw new Error("packaged companion smoke request is not private");
  }
  let raw: Buffer;
  try {
    raw = readFileSync(requestPath);
  } finally {
    unlinkSync(requestPath);
  }
  if (raw.length < 2 || raw.length > 16 * 1024) {
    raw.fill(0);
    throw new Error("packaged companion smoke request size is invalid");
  }
  let decoded: Record<string, unknown>;
  try {
    const candidate = JSON.parse(raw.toString("utf8")) as unknown;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("invalid request");
    }
    decoded = candidate as Record<string, unknown>;
  } finally {
    raw.fill(0);
  }
  const appDataPath = realpathSync(path.resolve(String(decoded.appDataPath)));
  const outputPath = path.resolve(String(decoded.outputPath));
  const readyPath = path.resolve(String(decoded.readyPath));
  const requestedCredentialStorePath = path.resolve(
    String(decoded.credentialStorePath),
  );
  const outputParent = realpathSync(path.dirname(outputPath));
  const readyParent = realpathSync(path.dirname(readyPath));
  const credentialStoreParent = realpathSync(
    path.dirname(requestedCredentialStorePath),
  );
  const credentialStorePath = path.join(
    credentialStoreParent,
    path.basename(requestedCredentialStorePath),
  );
  const phase = decoded.phase;
  const expectedTransferId = decoded.expectedTransferId;
  const expectedSourceSha256 = decoded.expectedSourceSha256;
  if (
    decoded.schemaVersion !== 1 ||
    (phase !== "pair-checkpoint" && phase !== "run" && phase !== "verify") ||
    lstatSync(appDataPath).isSymbolicLink() ||
    !isPathInside(temporaryRoot, appDataPath) ||
    !isPathInside(temporaryRoot, outputParent) ||
    !isPathInside(temporaryRoot, readyParent) ||
    !isPathInside(temporaryRoot, credentialStoreParent) ||
    (lstatSync(credentialStoreParent).mode & 0o077) !== 0 ||
    typeof expectedTransferId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(expectedTransferId) ||
    typeof expectedSourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(expectedSourceSha256)
  ) {
    throw new Error("packaged companion smoke request fields are invalid");
  }
  if (existsSync(credentialStorePath)) {
    const storeStat = lstatSync(credentialStorePath);
    if (
      storeStat.isSymbolicLink() ||
      !storeStat.isFile() ||
      storeStat.nlink !== 1 ||
      storeStat.size !== 32 ||
      (storeStat.mode & 0o077) !== 0 ||
      realpathSync(credentialStorePath) !== credentialStorePath ||
      (typeof process.getuid === "function" &&
        storeStat.uid !== process.getuid())
    ) {
      throw new Error("packaged companion smoke credential store is unsafe");
    }
  }
  return {
    appDataPath,
    outputPath,
    readyPath,
    credentialStorePath,
    phase,
    identitySeed: decodeCompanionSmokeSecret(decoded.identitySeedBase64),
    expectedTransferId,
    expectedSourceSha256,
  };
}

function decodeCompanionSmokeSecret(value: unknown): Buffer {
  if (typeof value !== "string" || value.length !== 44) {
    throw new Error("packaged companion smoke credential is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error("packaged companion smoke credential is invalid");
  }
  return decoded;
}

async function runProcessingSmokeIfRequested(): Promise<void> {
  const request = processingSmokeRequest;
  if (!request) return;
  if (
    !profileDatabase ||
    !desktopRepository ||
    !domainService ||
    !resourceCatalog
  ) {
    throw new Error("packaged processing smoke authority is unavailable");
  }
  const sourceSha256 = await sha256File(request.sourcePath);
  if (sourceSha256 !== request.referenceBindings.fixtureSha256) {
    throw new Error("packaged processing smoke fixture hash mismatch");
  }
  if (request.workstationOutputPath) await preparePackagedRendererTelemetry();
  const imported = await importAudioFromSource(request.sourcePath, {
    minimumFreeBytes: 0,
    destinationId: "audio-packaged-smoke",
  });
  const pipeline = requireProcessingPipelineIdentities(resourceCatalog);
  const queued = domainService.enqueueProcessingJob({
    audioId: imported.audioId,
    idempotencyKey: `packaged-processing-smoke:${imported.audioId}`,
    operationId: "asr",
    resourceIdentity: pipeline.asr.resourceIdentity,
    phase: "asr",
    protocolIdentity: pipeline.asr.protocolIdentity,
    sourceSha256: imported.mediaSha256,
    modelSha256: pipeline.asr.modelSha256,
    runtimeSha256: pipeline.asr.runtimeSha256,
  });
  scheduleProcessing();
  const workstationProgress = request.workstationOutputPath
    ? observePackagedRendererProgress(queued.value.id, imported.audioId)
    : null;
  if (!imported.inserted || !queued.inserted || queued.value.attempt !== 0) {
    throw new Error("packaged processing smoke profile was not independent");
  }
  const activeLoop = processingLoop;
  if (!activeLoop) {
    throw new Error("packaged processing smoke queue did not start");
  }
  await activeLoop;
  const initialProgressObserved = workstationProgress
    ? await workstationProgress
    : false;
  const task = desktopRepository
    .listProcessingTasks()
    .find((candidate) => candidate.id === queued.value.id);
  if (!task || task.state !== "completed") {
    throw new Error(
      `packaged processing smoke did not complete: ${task?.state ?? "missing"}`,
    );
  }
  const audio = profileDatabase
    .prepare(
      `SELECT audio_items.display_name, audio_items.duration_ms,
        media_authorities.normalized_path, media_authorities.source_sha256,
        media_authorities.content_sha256, media_authorities.size_bytes
      FROM audio_items
      JOIN media_authorities ON media_authorities.id = audio_items.media_authority_id
      WHERE audio_items.id = ?`,
    )
    .get(imported.audioId);
  const job = profileDatabase
    .prepare(
      `SELECT operation_id, resource_identity, state, attempt, error_code,
        phase, protocol_identity, source_sha256, model_sha256, runtime_sha256,
        progress_fraction
      FROM processing_jobs WHERE id = ?`,
    )
    .get(queued.value.id);
  const publication = profileDatabase
    .prepare(
      `SELECT operation_id, attempt, payload_json, phase, protocol_identity,
        source_sha256, model_sha256, runtime_sha256
      FROM result_publications WHERE job_id = ?`,
    )
    .get(queued.value.id);
  if (!audio || !job || !publication) {
    throw new Error("packaged processing smoke durable projection is missing");
  }
  const resultPayload = JSON.parse(String(publication.payload_json)) as unknown;
  if (!resultPayload || typeof resultPayload !== "object") {
    throw new Error("packaged processing smoke result payload is invalid");
  }
  if (String(job.resource_identity) !== resourceCatalog.identity) {
    throw new Error("packaged processing smoke resource identity changed");
  }
  const normalizedSha256 = await sha256File(String(audio.normalized_path));
  if (normalizedSha256 !== String(audio.content_sha256)) {
    throw new Error("packaged processing smoke normalized media changed");
  }
  const evidence = buildProcessingSmokeEvidence({
    referenceBindings: request.referenceBindings,
    resource: {
      manifestSha256: resourceCatalog.identity,
      modelSha256: pipeline.diarization.modelSha256,
      runtimeSha256: pipeline.diarization.runtimeSha256,
    },
    media: {
      sourceSha256: String(audio.source_sha256),
      normalizedSha256,
      normalizedSizeBytes: Number(audio.size_bytes),
      durationMs: Number(audio.duration_ms),
    },
    databaseProjection: {
      audio: {
        displayName: String(audio.display_name),
        durationMs: Number(audio.duration_ms),
      },
      job: {
        operationId: String(job.operation_id),
        state: String(job.state),
        attempt: Number(job.attempt),
        errorCode: job.error_code === null ? null : String(job.error_code),
        phase: String(job.phase),
        protocolIdentity: String(job.protocol_identity),
        sourceSha256: String(job.source_sha256),
        modelSha256: String(job.model_sha256),
        runtimeSha256: String(job.runtime_sha256),
        progressFraction: Number(job.progress_fraction),
      },
      publication: {
        operationId: String(publication.operation_id),
        attempt: Number(publication.attempt),
        phase: String(publication.phase),
        protocolIdentity: String(publication.protocol_identity),
        sourceSha256: String(publication.source_sha256),
        modelSha256: String(publication.model_sha256),
        runtimeSha256: String(publication.runtime_sha256),
      },
    },
    resultPayload: resultPayload as Record<string, unknown>,
    state: task.state,
    phase: task.phase,
    attempt: task.attempt,
    progressFraction: task.progressFraction,
  });
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new Error("packaged processing smoke evidence is too large");
  }
  const temporaryPath = `${request.outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, request.outputPath);
  if (request.workstationOutputPath) {
    await runPackagedWorkstationSmoke({
      audioId: imported.audioId,
      outputPath: request.workstationOutputPath,
      pipeline,
      sourceSha256: String(job.source_sha256),
      initialProgressObserved,
    });
  }
  app.quit();
}

async function runCaptionFormalSmokeIfRequested(): Promise<void> {
  const request = captionFormalSmokeRequest;
  if (!request) return;
  if (
    !profileDatabase ||
    !profilePaths ||
    !resourceCatalog ||
    !transcriptRepository ||
    !formalTranscriptHandoff
  ) {
    throw new Error("packaged caption formal smoke authority is unavailable");
  }
  const sessionId = "session-caption-formal-smoke-123456";
  if (request.phase === "verify") {
    const snapshot = transcriptRepository.getSnapshot(sessionId);
    if (!snapshot || snapshot.formal.state !== "completed") {
      throw new Error("packaged caption formal restart state is unavailable");
    }
    const renderer = await inspectPackagedCaptionPreload(sessionId);
    const prior = JSON.parse(
      (await readFile(request.outputPath, "utf8")).slice(0, 32_769),
    ) as Record<string, unknown>;
    await writeCaptionFormalSmokeReceipt(request.outputPath, {
      ...prior,
      restart: {
        formalState: snapshot.formal.state,
        generationId: snapshot.formal.generationId,
        snapshotVisibleThroughPreload: renderer.snapshotVisibleThroughPreload,
      },
    });
    app.quit();
    return;
  }
  if (!liveCaptionService) {
    throw new Error("packaged live-caption runtime is unavailable");
  }
  const source = await readFile(request.sourcePath);
  const pcm = extractBoundedMonoPcm16Wav(source);
  const sessionRoot = path.join(profilePaths.captureDirectory, sessionId);
  const captionRoot = path.join(sessionRoot, "caption");
  mkdirSync(captionRoot, { recursive: true, mode: 0o700 });
  const spoolPath = path.join(captionRoot, "live-caption.pcmspool");
  await writeFile(spoolPath, pcm, { mode: 0o600, flag: "wx" });
  const spoolSha256 = createHash("sha256").update(pcm).digest("hex");
  const durationMs = pcm.byteLength / 32;
  const journal = Buffer.from(
    JSON.stringify({
      schema: "desktop-capture-session/v1",
      sessionId,
      state: "completed",
      captureMode: "microphone_only",
      captureTimelineMs: durationMs,
      tracks: [
        {
          kind: "microphone",
          healthy: true,
          sampleRate: 16_000,
          channels: 1,
          format: "s16le",
        },
      ],
      chunks: [],
      events: [],
      spool: {
        relativePath: "caption/live-caption.pcmspool",
        format: "s16le",
        sampleRate: 16_000,
        channels: 1,
        frameDurationMs: 100,
        disposable: true,
        complete: true,
        formalEligible: true,
        bytes: pcm.byteLength,
        sha256: spoolSha256,
        durationMs,
        captureTimelineMs: durationMs,
        gapCount: 0,
      },
    }),
  );
  await writeFile(path.join(sessionRoot, "journal.json"), journal, {
    mode: 0o600,
    flag: "wx",
  });
  const journalSha256 = createHash("sha256").update(journal).digest("hex");
  const recordingSha256 = journalSha256;
  const nowMs = Date.now();
  profileDatabase
    .prepare(
      `INSERT INTO capture_sessions (
        session_id, title, workspace_path, state, capture_mode,
        capture_timeline_ms, system_audio_healthy, microphone_healthy,
        partial_capture, finalized_chunk_count, event_count, gap_count,
        recording_sha256, journal_sha256, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'completed', 'microphone_only', ?, 0, 1, 0, 1, 0, 0, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      "Packaged caption formal smoke",
      sessionRoot,
      durationMs,
      recordingSha256,
      journalSha256,
      nowMs,
      nowMs,
    );
  captionFormalSmokeAuthority = {
    sessionId,
    recordingSha256,
    journalSha256,
  };
  const liveIdentity = resourceCatalog.processingIdentity("live-caption");
  if (!liveIdentity) {
    throw new Error("packaged live-caption resource identity is unavailable");
  }
  const started = await liveCaptionService.start({
    sessionId,
    sessionRoot,
    ...liveIdentity,
  });
  if (!started.draft || started.draft.state === "degraded") {
    throw new Error("packaged live-caption worker did not start");
  }
  const pipeline = requireProcessingPipelineIdentities(resourceCatalog);
  const queued = await formalTranscriptHandoff.finalize({
    sessionId,
    displayName: "Packaged caption formal smoke",
    processing: { operationId: "asr", ...pipeline.asr },
  });
  publishCaption(queued);
  await waitForProcessingLoop();
  await processingLoop;
  const snapshot = transcriptRepository.getSnapshot(sessionId);
  const handoff = profileDatabase
    .prepare(
      `SELECT audio_id, processing_job_id, normalized_sha256,
        normalized_size_bytes FROM caption_formal_handoffs WHERE session_id = ?`,
    )
    .get(sessionId);
  const jobDiagnostic = handoff?.processing_job_id
    ? profileDatabase
        .prepare(
          `SELECT attempt, state, phase, operation_id, error_code
           FROM processing_jobs WHERE id = ?`,
        )
        .get(handoff.processing_job_id)
    : null;
  if (
    !snapshot ||
    snapshot.draft?.state !== "flushed" ||
    snapshot.formal.state !== "completed" ||
    snapshot.formal.attempt !== 1 ||
    snapshot.formal.generationId == null
  ) {
    throw new Error(
      `packaged caption formal processing did not complete: ${JSON.stringify({
        draftState: snapshot?.draft?.state ?? "missing",
        draftErrorCode: snapshot?.draft?.errorCode ?? null,
        formalState: snapshot?.formal.state ?? "missing",
        formalErrorCode: snapshot?.formal.errorCode ?? null,
        formalAttempt: snapshot?.formal.attempt ?? -1,
        job: jobDiagnostic
          ? {
              state: String(jobDiagnostic.state),
              phase: String(jobDiagnostic.phase),
              operationId: String(jobDiagnostic.operation_id),
              attempt: Number(jobDiagnostic.attempt),
              errorCode:
                jobDiagnostic.error_code == null
                  ? null
                  : String(jobDiagnostic.error_code),
            }
          : null,
      })}`,
    );
  }
  if (!handoff?.processing_job_id || !handoff.audio_id) {
    throw new Error("packaged caption formal durable handoff is missing");
  }
  const counts = profileDatabase
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM processing_jobs WHERE audio_id = ?) AS jobs,
        (SELECT COUNT(*) FROM result_publications WHERE job_id = ?) AS publications,
        (SELECT COUNT(*) FROM caption_formal_attempts WHERE session_id = ?) AS attempts`,
    )
    .get(handoff.audio_id, handoff.processing_job_id, sessionId);
  const job = profileDatabase
    .prepare("SELECT attempt, state FROM processing_jobs WHERE id = ?")
    .get(handoff.processing_job_id);
  const renderer = await inspectPackagedCaptionPreload(sessionId);
  const utteranceCount = Number(
    profileDatabase
      .prepare(
        `SELECT COUNT(*) AS count FROM caption_utterances AS utterances
         JOIN caption_sessions AS sessions ON sessions.id = utterances.caption_session_id
         WHERE sessions.session_id = ?`,
      )
      .get(sessionId)?.count ?? 0,
  );
  if (utteranceCount < 1 || job?.state !== "completed") {
    throw new Error("packaged caption worker produced no durable draft");
  }
  await writeCaptionFormalSmokeReceipt(request.outputPath, {
    schemaVersion: 1,
    packaged: app.isPackaged,
    sessionIdentitySha256: createHash("sha256").update(sessionId).digest("hex"),
    draft: {
      state: snapshot.draft!.state,
      utteranceCount,
      backlogBytes: snapshot.draft!.backlogBytes,
    },
    formal: snapshot.formal,
    database: {
      processingJobCount: Number(counts?.jobs ?? -1),
      publicationCount: Number(counts?.publications ?? -1),
      formalAttemptCount: Number(counts?.attempts ?? -1),
      processingAttempt: Number(job?.attempt ?? -1),
    },
    media: {
      sourceSha256: recordingSha256,
      outputSha256: String(handoff.normalized_sha256),
      outputBytes: Number(handoff.normalized_size_bytes),
    },
    resource: {
      manifestSha256: resourceCatalog.identity,
      liveCaptionModelSha256: liveIdentity.modelSha256,
      liveCaptionRuntimeSha256: liveIdentity.runtimeSha256,
      formalModelSha256: pipeline.diarization.modelSha256,
      formalRuntimeSha256: pipeline.diarization.runtimeSha256,
    },
    renderer,
  });
  app.quit();
}

function extractBoundedMonoPcm16Wav(source: Buffer): Buffer {
  if (
    source.byteLength < 44 ||
    source.byteLength > 512 * 1024 * 1024 ||
    source.toString("ascii", 0, 4) !== "RIFF" ||
    source.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("caption formal smoke WAV is invalid");
  }
  let formatValid = false;
  let pcm: Buffer | null = null;
  for (let offset = 12; offset + 8 <= source.byteLength;) {
    const chunkId = source.toString("ascii", offset, offset + 4);
    const chunkBytes = source.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkBytes;
    if (end > source.byteLength)
      throw new Error("caption formal smoke WAV is truncated");
    if (chunkId === "fmt " && chunkBytes >= 16) {
      formatValid =
        source.readUInt16LE(start) === 1 &&
        source.readUInt16LE(start + 2) === 1 &&
        source.readUInt32LE(start + 4) === 16_000 &&
        source.readUInt16LE(start + 14) === 16;
    } else if (chunkId === "data") {
      const alignedBytes = chunkBytes - (chunkBytes % 3_200);
      if (alignedBytes > 0) pcm = source.subarray(start, start + alignedBytes);
    }
    offset = end + (chunkBytes % 2);
  }
  if (!formatValid || !pcm) {
    throw new Error("caption formal smoke WAV is not 16 kHz mono PCM16");
  }
  return pcm;
}

async function inspectPackagedCaptionPreload(sessionId: string): Promise<{
  snapshotVisibleThroughPreload: boolean;
  retryMethodVisibleThroughPreload: boolean;
}> {
  await waitForPackagedRenderer();
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const api = window.voice2text;
      const snapshot = await api.getCaptionSnapshot({ sessionId: ${JSON.stringify(sessionId)} });
      return {
        snapshotVisibleThroughPreload: snapshot?.sessionId === ${JSON.stringify(sessionId)},
        retryMethodVisibleThroughPreload: typeof api.retryFormalTranscript === "function"
      };
    })()`,
    true,
  )) as {
    snapshotVisibleThroughPreload: boolean;
    retryMethodVisibleThroughPreload: boolean;
  };
}

async function writeCaptionFormalSmokeReceipt(
  outputPath: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new Error(
      "packaged caption formal receipt exceeded its privacy bound",
    );
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
}

async function runPackagedWorkstationSmoke(input: {
  audioId: number;
  outputPath: string;
  pipeline: ReturnType<typeof requireProcessingPipelineIdentities>;
  sourceSha256: string;
  initialProgressObserved: boolean;
}): Promise<void> {
  if (
    !audioWorkspaceService ||
    !audioPlaybackService ||
    !domainService ||
    !desktopRepository ||
    !profilePaths
  ) {
    throw new Error("packaged workstation smoke authority is unavailable");
  }
  const rendererReview = await runPackagedRendererReview(input.audioId);
  const retryJob = domainService.enqueueProcessingJob({
    audioId: input.audioId,
    idempotencyKey: `packaged-workstation-retry:${input.audioId}`,
    operationId: "asr",
    resourceIdentity: input.pipeline.asr.resourceIdentity,
    phase: "asr",
    protocolIdentity: input.pipeline.asr.protocolIdentity,
    sourceSha256: input.sourceSha256,
    modelSha256: input.pipeline.asr.modelSha256,
    runtimeSha256: input.pipeline.asr.runtimeSha256,
  });
  const retrySourcePath = desktopRepository.sourcePathForJob(retryJob.value.id);
  if (!retrySourcePath)
    throw new Error("packaged workstation retry source is unavailable");
  const authoritativeMedia = await readFile(retrySourcePath);
  const changedMedia = Buffer.from(authoritativeMedia);
  changedMedia[0] = (changedMedia[0] ?? 0) ^ 0xff;
  await writeFile(retrySourcePath, changedMedia, { mode: 0o600 });
  scheduleProcessing();
  if (!processingLoop)
    throw new Error("packaged workstation retry queue did not start");
  await processingLoop.finally(async () => {
    await writeFile(retrySourcePath, authoritativeMedia, { mode: 0o600 });
  });
  const interruptedRetry = domainService
    .listProcessingTasks()
    .find((task) => task.id === retryJob.value.id);
  if (interruptedRetry?.state !== "interrupted")
    throw new Error("packaged workstation retry fixture did not interrupt");
  await clickPackagedTaskAction("重试");
  await waitForProcessingLoop();
  if (!processingLoop)
    throw new Error("packaged workstation production retry did not start");
  await processingLoop;
  const retryTask = domainService
    .listProcessingTasks()
    .find((task) => task.id === retryJob.value.id);
  if (retryTask?.state !== "completed" || retryTask.attempt < 2)
    throw new Error("packaged workstation production retry did not complete");
  const workspace = audioWorkspaceService.openAudio(input.audioId);
  if (workspace?.segments[0]?.text !== rendererReview.reviewedText) {
    throw new Error("packaged workstation retry overwrote manual authority");
  }
  const cancelJob = domainService.enqueueProcessingJob({
    audioId: input.audioId,
    idempotencyKey: `packaged-workstation-cancel:${input.audioId}`,
    operationId: "asr",
    resourceIdentity: input.pipeline.asr.resourceIdentity,
    phase: "asr",
    protocolIdentity: input.pipeline.asr.protocolIdentity,
    sourceSha256: input.sourceSha256,
    modelSha256: input.pipeline.asr.modelSha256,
    runtimeSha256: input.pipeline.asr.runtimeSha256,
  });
  scheduleProcessing();
  const cancelDeadline = Date.now() + 30_000;
  while (
    Date.now() < cancelDeadline &&
    domainService
      .listProcessingTasks()
      .find((task) => task.id === cancelJob.value.id)?.state !== "running"
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let cancelCompleted = false;
  while (Date.now() < cancelDeadline) {
    try {
      await clickPackagedTaskAction("取消");
      cancelCompleted = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!cancelCompleted)
    throw new Error("packaged workstation production cancel did not execute");
  await processingLoop;
  const canceledTask = domainService
    .listProcessingTasks()
    .find((task) => task.id === cancelJob.value.id);
  if (canceledTask?.state !== "canceled")
    throw new Error("packaged workstation cancel was not durable");
  const rendererEvidence = await runPackagedRendererAssertions(input.audioId);
  const evidence = {
    schemaVersion: 1,
    protocol: "voice2text-u7-packaged-workstation/v1",
    packaged: app.isPackaged,
    audioId: input.audioId,
    generationId: workspace.summary.generationId,
    segmentCount: workspace.segments.length,
    manualRevisionSurvivedRetry: true,
    productionRetryCompleted: true,
    productionCancelCompleted: true,
    retryTerminal: { state: retryTask.state, attempt: retryTask.attempt },
    cancelTerminal: {
      state: canceledTask.state,
      attempt: canceledTask.attempt,
    },
    searchResultCount: rendererEvidence.searchResultCount,
    playback: rendererEvidence.playback,
    exported: rendererEvidence.exported,
    rendererBoundary: "typed-preload-opaque-identifiers-only",
    rendererDomReady: rendererReview.domReady,
    rendererPreloadDriven: true,
    audioProcessingOwned: rendererEvidence.audioProcessingOwned,
    importProgressObserved:
      input.initialProgressObserved && rendererEvidence.importProgressObserved,
    operationStates: rendererEvidence.operationStates,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 32_768) {
    throw new Error("packaged workstation smoke evidence is too large");
  }
  const temporaryPath = `${input.outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, serialized, { mode: 0o600 });
  await rename(temporaryPath, input.outputPath);
}

async function runPackagedRendererReview(audioId: number): Promise<{
  reviewedText: string;
  domReady: boolean;
}> {
  await waitForPackagedRenderer();
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const waitFor = async (find, label) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const value = find();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("DOM timeout: " + label);
      };
      const buttonWithText = (text) => [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().includes(text));
      const rail = await waitFor(
        () => document.querySelector('[aria-label="工作站主导航"]'),
        "workstation rail"
      );
      const railLabels = [...rail.querySelectorAll("button")]
        .map((button) => button.getAttribute("aria-label"));
      if (JSON.stringify(railLabels) !== JSON.stringify(["音频", "互联", "设置"])) {
        throw new Error("Audio workstation rail is not canonical");
      }
      rail.querySelector('[aria-label="音频"]').click();
      document.querySelector('[aria-label="打开音频上下文面板"]')?.click();
      const summary = (await window.voice2text.listAudios())
        .find((candidate) => candidate.audioId === ${audioId});
      if (!summary) throw new Error("smoke Audio summary unavailable");
      const audio = await waitFor(
        () => [...document.querySelectorAll("button")]
          .find((button) => button.getAttribute("aria-label") === "打开 " + summary.displayName),
        "audio card"
      );
      audio.click();
      const edit = await waitFor(() => buttonWithText("编辑片段 1"), "edit segment");
      edit.click();
      const textarea = await waitFor(
        () => {
          const label = [...document.querySelectorAll("label")]
            .find((candidate) => candidate.textContent?.trim() === "片段 1 文本");
          return label?.control instanceof HTMLTextAreaElement
            ? label.control
            : null;
        },
        "segment editor"
      );
      const reviewedText = "已复核：" + textarea.value;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
        .set.call(textarea, reviewedText);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      buttonWithText("保存")?.click();
      const undo = await waitFor(
        () => [...document.querySelectorAll("button")]
          .find((button) => button.getAttribute("aria-label") === "撤销" && !button.disabled),
        "undo enabled"
      );
      undo.click();
      const redo = await waitFor(
        () => [...document.querySelectorAll("button")]
          .find((button) => button.getAttribute("aria-label") === "重做" && !button.disabled),
        "redo enabled"
      );
      redo.click();
      await waitFor(
        () => document.body.textContent?.includes("已重做文本修改"),
        "redo status"
      );
      return { reviewedText, domReady: document.readyState === "complete" };
    })()`,
    true,
  )) as { reviewedText: string; domReady: boolean };
}

async function runPackagedRendererAssertions(audioId: number): Promise<{
  searchResultCount: number;
  playback: {
    initialized: boolean;
    positionMs: number;
    speed: number;
    pathRedacted: true;
  };
  exported: Array<{ format: string; fileName: string; bytes: number }>;
  audioProcessingOwned: boolean;
  importProgressObserved: boolean;
  operationStates: string[];
}> {
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const api = window.voice2text;
      const waitFor = async (find, label) => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const value = find();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error("DOM timeout: " + label);
      };
      const buttonWithText = (text) => [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim().includes(text));
      const rail = await waitFor(
        () => document.querySelector('[aria-label="工作站主导航"]'),
        "workstation rail after retry"
      );
      const railLabels = [...rail.querySelectorAll("button")]
        .map((button) => button.getAttribute("aria-label"));
      if (JSON.stringify(railLabels) !== JSON.stringify(["音频", "互联", "设置"])) {
        throw new Error("Audio workstation rail is not canonical");
      }
      rail.querySelector('[aria-label="音频"]').click();
      document.querySelector('[aria-label="打开音频上下文面板"]')?.click();
      const summary = (await api.listAudios())
        .find((candidate) => candidate.audioId === ${audioId});
      if (!summary) throw new Error("smoke Audio summary unavailable after retry");
      const audio = await waitFor(
        () => [...document.querySelectorAll("button")]
          .find((button) => button.getAttribute("aria-label") === "打开 " + summary.displayName),
        "audio card after retry"
      );
      audio.click();
      const searchInput = await waitFor(
        () => document.querySelector('[aria-label="搜索音频转写"]'),
        "transcript search"
      );
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        .set.call(searchInput, "已复核");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.closest("form").requestSubmit();
      await waitFor(
        () => document.querySelector('[aria-label="搜索结果导航"]'),
        "search result navigation"
      );
      const play = await waitFor(
        () => document.querySelector('[aria-label="播放音频"]'),
        "play button"
      );
      play.click();
      const pause = await waitFor(
        () => document.querySelector('[aria-label="暂停音频"]'),
        "pause button"
      );
      pause.click();
      await waitFor(
        () => document.querySelector('[aria-label="播放音频"]'),
        "paused playback"
      );
      const exportTrigger = await waitFor(
        () => document.querySelector('[data-slot="dropdown-menu-trigger"]'),
        "export trigger"
      );
      exportTrigger.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse"
      }));
      const txtExport = await waitFor(
        () => [...document.querySelectorAll('[data-slot="dropdown-menu-item"][role="menuitem"]')]
          .find((item) => item.textContent?.trim() === "TXT"),
        "TXT export option"
      );
      txtExport.click();
      await waitFor(
        () => document.body.textContent?.includes("已导出 renderer-"),
        "DOM export status"
      );
      const playback = await api.controlAudioPlayback(${audioId}, { action: "seek", positionMs: 500 });
      const sped = await api.controlAudioPlayback(${audioId}, { action: "speed", speed: 1.5 });
      const exported = [{ format: "txt", fileName: "renderer-dom.txt", bytes: 1 }];
      for (const format of ["md", "vtt", "srt", "json"]) {
        const result = await api.exportAudio(${audioId}, format);
        if (result.state !== "saved") throw new Error("Renderer export failed");
        exported.push({ format, fileName: result.fileName, bytes: 1 });
      }
      const telemetry = window.__voice2textPackagedTelemetry;
      telemetry?.unsubscribe?.();
      const events = telemetry?.events ?? [];
      return {
        searchResultCount: Number(document.querySelector('[aria-label="搜索结果导航"]') !== null),
        playback: {
          initialized: sped.initialized,
          positionMs: playback.positionMs,
          speed: sped.speed,
          pathRedacted: JSON.stringify(sped).includes("/private/") === false
        },
        exported,
        audioProcessingOwned:
          telemetry?.section === "audio" &&
          telemetry?.liveRegion === "音频处理进度公告" &&
          JSON.stringify(telemetry?.railLabels) === JSON.stringify(["音频", "互联", "设置"]),
        importProgressObserved:
          telemetry?.importProgressObserved === true &&
          events.some((event) =>
            event.jobId === telemetry?.importJobId &&
            event.state === "running"
          ),
        operationStates: [...new Set(events.map((event) => event.state))].sort()
      };
    })()`,
    true,
  )) as {
    searchResultCount: number;
    playback: {
      initialized: boolean;
      positionMs: number;
      speed: number;
      pathRedacted: true;
    };
    exported: Array<{ format: string; fileName: string; bytes: number }>;
    audioProcessingOwned: boolean;
    importProgressObserved: boolean;
    operationStates: string[];
  };
}

async function preparePackagedRendererTelemetry(): Promise<void> {
  await waitForPackagedRenderer();
  await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const api = window.voice2text;
      const events = [];
      const unsubscribe = api.onOperationEvent((event) => {
        if (events.length < 256) events.push({
          jobId: event.jobId,
          state: event.state,
          attempt: event.attempt,
          phase: event.phase,
          progressFraction: event.progressFraction
        });
      });
      const rail = document.querySelector('[aria-label="工作站主导航"]');
      if (!rail) throw new Error("Audio workstation rail unavailable");
      const railLabels = [...rail.querySelectorAll("button")]
        .map((button) => button.getAttribute("aria-label"));
      if (JSON.stringify(railLabels) !== JSON.stringify(["音频", "互联", "设置"])) {
        throw new Error("Audio workstation rail is not canonical");
      }
      rail.querySelector('[aria-label="音频"]').click();
      const deadline = Date.now() + 15000;
      while (!document.querySelector('[aria-label="音频处理进度公告"]')) {
        if (Date.now() >= deadline) throw new Error("Audio processing DOM did not render");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const telemetry = {
        events,
        unsubscribe,
        section: "audio",
        railLabels,
        liveRegion: "音频处理进度公告",
        importJobId: null,
        importProgressObserved: false
      };
      window.__voice2textPackagedTelemetry = telemetry;
    })()`,
    true,
  );
}

async function observePackagedRendererProgress(
  jobId: number,
  audioId: number,
): Promise<boolean> {
  const audioSelector = `[data-audio-id="${audioId}"]`;
  const progressSelector = `[data-processing-job-id="${jobId}"]`;
  return (await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const jobId = ${jobId};
      const telemetry = window.__voice2textPackagedTelemetry;
      if (!telemetry) return false;
      telemetry.importJobId = jobId;
      const deadline = Date.now() + ${packagedProgressObservationTimeoutMs};
      let selectionRequested = false;
      while (Date.now() < deadline) {
        const runningObserved = telemetry.events.some((event) =>
          event.jobId === jobId &&
          event.state === "running"
        );
        const audio = document.querySelector(${JSON.stringify(audioSelector)});
        if (audio && !selectionRequested) {
          selectionRequested = true;
          audio.click();
        }
        const progress = document.querySelector(${JSON.stringify(progressSelector)});
        const progressMax = Number(progress?.getAttribute("aria-valuemax"));
        const progressValue = Number(progress?.getAttribute("aria-valuenow"));
        if (
          runningObserved &&
          progress?.getAttribute("role") === "progressbar" &&
          progressMax === 1 &&
          progressValue >= 0 &&
          progressValue < 1
        ) {
          telemetry.importProgressObserved = true;
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    })()`,
    true,
  )) as boolean;
}

async function clickPackagedTaskAction(action: "重试" | "取消"): Promise<void> {
  await mainWindow!.webContents.executeJavaScript(
    `(async () => {
      const audio = document.querySelector('[aria-label="工作站主导航"] [aria-label="音频"]');
      if (!audio) throw new Error("Audio rail control unavailable");
      audio.click();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const button = [...document.querySelectorAll("button")]
          .find((candidate) => candidate.getAttribute("aria-label")?.startsWith("${action} "));
        if (button && !button.disabled) {
          button.click();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("DOM ${action} action timed out");
    })()`,
    true,
  );
}

async function waitForProcessingLoop(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!processingLoop && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!processingLoop) throw new Error("processing loop did not start");
}

async function waitForPackagedRenderer(): Promise<void> {
  if (!mainWindow) throw new Error("packaged Renderer window is unavailable");
  if (!mainWindow.webContents.isLoading()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("packaged Renderer load timed out")),
      15_000,
    );
    mainWindow!.webContents.once("did-finish-load", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

const minimumCaptureFreeBytes = 2 * 1024 * 1024 * 1024;

async function preflightCapture(options: {
  requestPermissions: boolean;
  captionEnabled: boolean;
}) {
  if (!captureService) throw new Error("macOS capture helper is unavailable");
  if (options.requestPermissions) {
    await requestMicrophonePermissionIfNeeded(systemPreferences);
  }
  return await captureService.preflight({
    minimumFreeBytes: minimumCaptureFreeBytes,
    captionModelAvailable:
      !options.captionEnabled ||
      hasVerifiedLiveCaptionCapability(resourceCatalog),
    // TCC permission prompts must be owned by the foreground app bundle. The
    // headless native helper only observes the resulting authorization state.
    requestPermissions: false,
  });
}

async function startCapture(options: {
  title: string;
  microphoneDeviceId?: string;
  captionEnabled: boolean;
  idempotencyKey: string;
}): Promise<CaptureSnapshot> {
  if (!captureService) throw new Error("macOS capture helper is unavailable");
  await microphoneTestService?.stopBeforeFormalCapture();
  const preflight = await preflightCapture({
    requestPermissions: false,
    captionEnabled: options.captionEnabled,
  });
  if (!capturePreflightAllowsStart(preflight, options.captionEnabled)) {
    throw new Error(
      `capture preflight failed: ${preflight.blockingReasons.join(",")}`,
    );
  }
  const result = await captureService.start({
    sessionId: `session-${randomUUID()}`,
    title: options.title,
    idempotencyKey: options.idempotencyKey,
    minimumFreeBytes: minimumCaptureFreeBytes,
    microphoneDeviceId: options.microphoneDeviceId,
    captionEnabled: options.captionEnabled,
  });
  if (options.captionEnabled && preflight.captionModelAvailable) {
    const identity = resourceCatalog?.processingIdentity("live-caption");
    if (!identity || !liveCaptionService || !profilePaths) {
      throw new Error("verified live-caption runtime is unavailable");
    }
    await liveCaptionService.start({
      sessionId: result.sessionId,
      sessionRoot: path.join(profilePaths.captureDirectory, result.sessionId),
      ...identity,
    });
  }
  activeCaptureTitle = options.title;
  publishCapture(result);
  return result;
}

async function controlCapture(options: {
  action: "pause" | "resume" | "stop";
  sessionId: string;
  idempotencyKey: string;
}): Promise<CaptureSnapshot> {
  const operation = captureControlMutation.then(
    async () => await performCaptureControl(options),
  );
  captureControlMutation = operation.then(
    () => undefined,
    () => undefined,
  );
  return await operation;
}

async function performCaptureControl(options: {
  action: "pause" | "resume" | "stop";
  sessionId: string;
  idempotencyKey: string;
}): Promise<CaptureSnapshot> {
  if (!captureService) throw new Error("macOS capture helper is unavailable");
  const result = await captureService.control(options);
  if (options.action === "pause") {
    await liveCaptionService?.pause(options.sessionId);
  } else if (options.action === "resume") {
    await liveCaptionService?.resume(options.sessionId);
  } else {
    // The native capture commit is already durable at this point. Surface it
    // before the separately retryable formal projection is attempted.
    publishCapture(result);
    await finalizeCommittedCaptureTranscript({
      handoff: formalTranscriptHandoff,
      sessionId: options.sessionId,
      displayName: activeCaptureTitle,
      processing: null,
      publish: publishCaption,
      reportFailure: () =>
        console.error("Voice2Text formal transcript handoff failed"),
    });
  }
  publishCapture(result);
  return result;
}

function publishCapture(snapshot: CaptureSnapshot | null): void {
  applicationState.setCapture(snapshot, activeCaptureTitle);
  updateCaptureTray(snapshot);
}

function setupCaptureLifecycle(): void {
  if (captureLifecycleBound) return;
  captureLifecycleBound = true;
  if (process.platform === "darwin") {
    const image = nativeImage.createFromNamedImage("NSStatusAvailable");
    image.setTemplateImage(true);
    captureTray = new Tray(image);
    captureTray.setToolTip("Voice2Text 音频录制");
    updateCaptureTray(captureService?.snapshot() ?? null);
  }
  powerMonitor.on("suspend", () => {
    void applyCaptureLifecycle("system-sleep");
  });
  powerMonitor.on("resume", () => {
    void applyCaptureLifecycle("system-wake");
  });
  capturePollTimer = setInterval(() => void pollCaptureSnapshot(), 500);
}

async function pollCaptureSnapshot(): Promise<void> {
  const current = captureService?.snapshot();
  if (
    !captureService ||
    !current ||
    capturePollInFlight ||
    !captureRequiresSnapshotPolling(current)
  ) {
    return;
  }
  capturePollInFlight = true;
  try {
    const refreshed = await captureService.refresh(current.sessionId);
    publishCapture(refreshed);
    if (refreshed.state === "recording") {
      await liveCaptionService?.poll(refreshed.sessionId);
    }
  } catch (error) {
    console.error("Capture snapshot refresh failed", error);
  } finally {
    capturePollInFlight = false;
  }
}

async function applyCaptureLifecycle(
  action: "system-sleep" | "system-wake",
): Promise<void> {
  const current = captureService?.snapshot();
  if (!captureService || !current) return;
  if (action === "system-sleep" && !captureIsRunning(current)) return;
  if (
    action === "system-wake" &&
    (current.state !== "paused" ||
      current.interruptionReason !== "system_sleep")
  ) {
    return;
  }
  try {
    publishCapture(
      await captureService.lifecycle(
        action,
        current.sessionId,
        captureService.nextLifecycleIdempotencyKey(action, current.sessionId),
      ),
    );
  } catch (error) {
    console.error("Capture lifecycle transition failed", error);
  }
}

function updateCaptureTray(snapshot: CaptureSnapshot | null): void {
  if (!captureTray) return;
  const running = snapshot ? captureIsRunning(snapshot) : false;
  const paused = snapshot?.state === "paused";
  captureTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: running ? `正在录制 · ${activeCaptureTitle}` : "当前没有录制",
        enabled: false,
      },
      { type: "separator" },
      {
        label: paused ? "继续录制" : "暂停录制",
        enabled: Boolean(snapshot && (running || paused)),
        click: () => {
          if (!snapshot) return;
          void controlCapture({
            action: paused ? "resume" : "pause",
            sessionId: snapshot.sessionId,
            idempotencyKey: `${paused ? "resume" : "pause"}-menu-${randomUUID()}`,
          }).catch((error: unknown) =>
            console.error("Capture menu action failed", error),
          );
        },
      },
      {
        label: "停止并保存",
        enabled: Boolean(snapshot && (running || paused)),
        click: () => {
          if (!snapshot) return;
          void controlCapture({
            action: "stop",
            sessionId: snapshot.sessionId,
            idempotencyKey: `stop-menu-${randomUUID()}`,
          }).catch((error: unknown) =>
            console.error("Capture menu stop failed", error),
          );
        },
      },
      { type: "separator" },
      {
        label: "打开 Voice2Text",
        click: () => showMainWindow(),
      },
      { type: "separator" },
      {
        label: "退出 Voice2Text",
        click: () => app.quit(),
      },
    ]),
  );
}

async function prepareCaptureForQuit(): Promise<boolean> {
  const current = captureService?.snapshot();
  const requiresConfirmation = captureRequiresQuitConfirmation(current ?? null);
  if (!current || !requiresConfirmation) return true;
  captureSmokeBeforeQuitAttempts += captureSmokeQuitEvidence ? 1 : 0;
  const injectedChoice = captureSmokeQuitEvidence
    ? captureSmokeQuitChoices.shift()
    : undefined;
  const choice =
    injectedChoice === undefined
      ? mainWindow
        ? await dialog.showMessageBox(mainWindow, activeCaptureQuitDialog)
        : await dialog.showMessageBox(activeCaptureQuitDialog)
      : { response: injectedChoice };
  if (choice.response === 0) {
    if (captureSmokeQuitEvidence) {
      captureSmokeContinueObserved =
        !teardownStarted &&
        profileDatabase !== null &&
        captureIsRunning(current);
      setTimeout(() => app.quit(), 25);
    }
    return false;
  }
  try {
    await controlCapture({
      action: "stop",
      sessionId: current.sessionId,
      idempotencyKey: `stop-quit-${current.sessionId}`,
    });
    if (captureSmokeQuitEvidence && captureSmokeRequest) {
      const durableStop = profileDatabase
        ?.prepare(
          "SELECT COUNT(*) AS count FROM capture_command_receipts WHERE session_id = ? AND action = 'stop'",
        )
        .get(current.sessionId);
      await writeCaptureSmokeReceipt(captureSmokeRequest.outputPath, {
        ...captureSmokeQuitEvidence,
        quitLifecycle: {
          beforeQuitAttempts: captureSmokeBeforeQuitAttempts,
          continueCanceledTeardown: captureSmokeContinueObserved,
          stopCalls: captureSmokeStopCalls,
          stopReceiptObservedBeforeTeardown:
            Number(durableStop?.count ?? 0) === 1 && !teardownStarted,
          databaseOpenBeforeTeardown: profileDatabase !== null,
        },
      });
    }
    return true;
  } catch (error) {
    console.error("Capture could not be committed; quit was stopped", error);
    return false;
  }
}

function bindDesktopIpc(window: BrowserWindow): void {
  unregisterIpc?.();
  unregisterIpc = registerDesktopIpc(window, {
    getLocalModelSnapshot: async () => {
      if (!localModelService) throw new Error("本地模型服务暂不可用");
      synchronizeModelProcessingTasks();
      return await modelStorageAccess!.withStoreAccess(
        localModelService.activeStoreId,
        async () => await localModelService!.snapshot(),
      );
    },
    sendLocalModelIntent: async (options) => {
      if (!localModelService) throw new Error("本地模型服务暂不可用");
      synchronizeModelProcessingTasks();
      const snapshot = await modelStorageAccess!.withStoreAccess(
        localModelService.activeStoreId,
        async () => await localModelService!.intent(options),
      );
      await refreshResourceModelAuthorities();
      return snapshot;
    },
    changeLocalModelRoot: async ({ expectedRevision }) => {
      if (!localModelService || !modelStorageAccess) {
        throw new Error("本地模型服务暂不可用");
      }
      synchronizeModelProcessingTasks();
      const selection = await modelStorageAccess.chooseRoot(window);
      if (!selection) return await localModelService.snapshot();
      const current = await localModelService.snapshot();
      if (current.storage.usedBytes > 0) {
        const confirmation = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["取消", "迁移模型"],
          defaultId: 0,
          cancelId: 0,
          title: "迁移本地模型",
          message: "要把全部本地模型迁移到新位置吗？",
          detail: `迁移约 ${Math.ceil(current.storage.usedBytes / 1024 ** 2)} MB。完成复制、校验和加载探测前，原位置不会被删除。`,
        });
        if (confirmation.response !== 1) return current;
      }
      const snapshot = await modelStorageAccess.withStoreAccess(
        localModelService.activeStoreId,
        async () =>
          await modelStorageAccess!.withSelectedAccess(
            selection.securityScopedBookmark,
            async () =>
              await localModelService!.changeRoot(
                selection.path,
                expectedRevision,
              ),
          ),
      );
      modelStorageAccess.remember(
        snapshot.storage.storeId,
        selection.securityScopedBookmark,
      );
      await refreshResourceModelAuthorities();
      return snapshot;
    },
    openLocalModelRoot: async () => {
      if (!localModelService || !modelStorageAccess) {
        throw new Error("本地模型服务暂不可用");
      }
      const failure = await modelStorageAccess.withStoreAccess(
        localModelService.activeStoreId,
        async () => await shell.openPath(localModelService!.rootPath()),
      );
      if (failure) throw new Error(`无法打开本地模型位置：${failure}`);
    },
    onLocalModelSnapshot: (listener) => {
      localModelListeners.add(listener);
      return () => localModelListeners.delete(listener);
    },
    getCompanionSnapshot: async () => {
      return requireCompanionService().snapshot();
    },
    setCompanionOptIn: async (options) => {
      return await requireCompanionService().setOptIn(
        options.enabled,
        options.idempotencyKey,
      );
    },
    createCompanionPairingInvite: async (options) => {
      return requireCompanionService().createPairingInvite(
        options.idempotencyKey,
      );
    },
    revokeCompanionPeer: async (options) => {
      return await requireCompanionService().revokePeer(
        options.deviceId,
        options.idempotencyKey,
      );
    },
    cancelCompanionTransfer: async (options) => {
      return requireCompanionService().cancelTransfer(
        options.transferId,
        options.expectedRevision,
        options.idempotencyKey,
      );
    },
    retryCompanionTransfer: async (options) => {
      return requireCompanionService().retryTransfer(
        options.transferId,
        options.expectedRevision,
        options.idempotencyKey,
      );
    },
    onCompanionSnapshot: (listener) => {
      companionListeners.add(listener);
      return () => companionListeners.delete(listener);
    },
    getAiSettings: async () => {
      if (!audioAiService) throw new Error("audio AI settings are unavailable");
      return await audioAiService.getSettings();
    },
    createAiProviderProfile: async (options) => {
      if (!audioAiService) throw new Error("audio AI settings are unavailable");
      return await audioAiService.createProfile(options);
    },
    updateAiProviderProfile: async (options) => {
      if (!audioAiService)
        throw new Error("secure secret storage is unavailable");
      return await audioAiService.updateProfile(options);
    },
    selectAiProviderProfile: async (options) => {
      if (!audioAiService) throw new Error("audio AI settings are unavailable");
      return await audioAiService.selectProfile(options);
    },
    deleteAiProviderProfile: async (options) => {
      if (!audioAiService)
        throw new Error("secure secret storage is unavailable");
      return await audioAiService.deleteProfile(options);
    },
    prepareAudioAi: async (options) => {
      if (!audioAiService) throw new Error("audio AI is unavailable");
      return audioAiService.prepare(options);
    },
    getAudioAiSnapshot: async ({ audioId }) =>
      audioAiService?.snapshot(audioId) ?? null,
    generateAudioAi: async (options) => {
      if (!audioAiService) throw new Error("audio AI is unavailable");
      return await audioAiService.generate(options);
    },
    retryAudioAi: async (options) => {
      if (!audioAiService) throw new Error("audio AI is unavailable");
      return await audioAiService.retry(options);
    },
    onAudioAiSnapshot: (listener) => {
      audioAiListeners.add(listener);
      return () => audioAiListeners.delete(listener);
    },
    applicationSnapshot: () => applicationState.snapshot(),
    navigate: (section) => applicationState.navigate(section),
    requestBootstrapAction: async (action) =>
      await requestBootstrapAction(action),
    markActivityRead: (activityId) =>
      applicationState.markActivityRead(activityId),
    markAllActivityRead: () => applicationState.markAllActivityRead(),
    onApplicationSnapshot: (listener) => applicationState.subscribe(listener),
    onOperationEvent: (listener) => {
      operationListeners.add(listener);
      return () => operationListeners.delete(listener);
    },
    onCaptionSnapshot: (listener) => {
      captionListeners.add(listener);
      return () => captionListeners.delete(listener);
    },
    workerHealth: async () => {
      if (!workerSupervisor)
        throw new Error("worker capability is unavailable");
      return await workerSupervisor.check();
    },
    cancelProcessing: async (jobId) => {
      if (!processCoordinator || !(await processCoordinator.cancel(jobId))) {
        throw new Error("processing job is not running or canceling");
      }
      const canceled = domainService
        ?.listProcessingTasks()
        .find((task) => task.id === jobId && task.state === "canceled");
      if (!canceled) {
        throw new Error("durable canceled processing state is unavailable");
      }
      emitOperation({ jobId, state: "canceled", attempt: canceled.attempt });
      return canceledResponse(jobId);
    },
    retryProcessing: async (jobId, expectedAttempt) => {
      if (!localModelService) throw new Error("本地转写服务暂不可用");
      const releaseAdmission = modelLeaseCoordinator?.beginProcessingTask();
      try {
        const capability = await localModelService.capability(
          "formal-transcription",
        );
        if (!capability.available) {
          throw new Error(`本地转写不可用：${capability.reason}`);
        }
        const pipeline = resourceCatalog?.processingPipelineIdentities();
        if (
          !pipeline ||
          !domainService?.retryInterruptedJob(jobId, expectedAttempt, {
            operationId: "asr",
            phase: "asr",
            ...pipeline.asr,
          })
        ) {
          throw new Error(
            "processing resources are incomplete or the job is not interrupted at the expected attempt",
          );
        }
        const queued = domainService
          .listProcessingTasks()
          .find((task) => task.id === jobId && task.state === "queued");
        if (!queued) {
          throw new Error("durable queued processing state is unavailable");
        }
        synchronizeModelProcessingTasks();
        emitOperation({ jobId, state: "queued", attempt: queued.attempt });
        scheduleProcessing();
        return queuedResponse(jobId);
      } finally {
        releaseAdmission?.();
      }
    },
    startTranscription: async (audioId) => {
      if (!localModelService || !domainService || !desktopRepository) {
        throw new Error("本地转写服务暂不可用");
      }
      const releaseAdmission = modelLeaseCoordinator?.beginProcessingTask();
      try {
        const capability = await localModelService.capability(
          "formal-transcription",
        );
        if (!capability.available) {
          throw new Error(`本地转写不可用：${capability.reason}`);
        }
        const pipeline = resourceCatalog?.processingPipelineIdentities();
        const media = desktopRepository.mediaAuthorityForAudio(audioId);
        if (!pipeline || !media) throw new Error("音频或本地转写资源不可用");
        const queued = domainService.enqueueProcessingJob({
          audioId,
          idempotencyKey: `manual-transcription:${audioId}:${randomBytes(16).toString("hex")}`,
          operationId: "asr",
          phase: "asr",
          resourceIdentity: pipeline.asr.resourceIdentity,
          protocolIdentity: pipeline.asr.protocolIdentity,
          sourceSha256: media.contentSha256,
          modelSha256: pipeline.asr.modelSha256,
          runtimeSha256: pipeline.asr.runtimeSha256,
        });
        synchronizeModelProcessingTasks();
        emitOperation({
          jobId: queued.value.id,
          state: "queued",
          attempt: queued.value.attempt,
        });
        scheduleProcessing();
        return queuedResponse(queued.value.id);
      } finally {
        releaseAdmission?.();
      }
    },
    listProcessingTasks: async () => domainService?.listProcessingTasks() ?? [],
    importAudio: async () => await chooseAndImportAudio(),
    preflightCapture: async (options) => await preflightCapture(options),
    startCapture: async (options) => await startCapture(options),
    controlCapture: async (options) => await controlCapture(options),
    startMicrophoneTest: async (options) => {
      if (!microphoneTestService) {
        throw new Error("麦克风测试暂不可用");
      }
      return await microphoneTestService.start(options);
    },
    getMicrophoneTestSnapshot: async (options) => {
      if (!microphoneTestService) {
        throw new Error("麦克风测试暂不可用");
      }
      return await microphoneTestService.snapshot(options);
    },
    finishMicrophoneTest: async (options) => {
      if (!microphoneTestService) {
        throw new Error("麦克风测试暂不可用");
      }
      return await microphoneTestService.finish(options);
    },
    cancelMicrophoneTest: async (options) => {
      if (!microphoneTestService) {
        throw new Error("麦克风测试暂不可用");
      }
      return await microphoneTestService.cancel(options);
    },
    openMicrophoneSettings: async () =>
      await openMicrophoneSettings((uri) => shell.openExternal(uri)),
    stopMicrophoneTestForOwner: async (ownerId) => {
      await microphoneTestService?.stopForOwner(ownerId);
    },
    floatingCaptureSnapshot: () =>
      deriveFloatingCaptureSnapshot(applicationState.snapshot()),
    controlFloatingCapture: async (options) => {
      await controlCapture(options);
      return deriveFloatingCaptureSnapshot(applicationState.snapshot());
    },
    floatingCaptureWindowAction: (action) => handleFloatingWindowAction(action),
    getFloatingCapturePreference: () => ({
      enabled: floatingCaptureEnabled,
    }),
    setFloatingCapturePreference: (enabled) =>
      setFloatingCapturePreference(enabled),
    onFloatingCaptureSnapshot: (listener) => {
      floatingCaptureListeners.add(listener);
      return () => floatingCaptureListeners.delete(listener);
    },
    listCaptureRecoveries: async () => {
      return listAvailableCaptureRecoveries(captureService);
    },
    actOnCaptureRecovery: async (options) => {
      if (!captureService) throw new Error("capture recovery is unavailable");
      if (options.action === "discard") {
        await captureService.discardRecovered(
          options.sessionId,
          options.idempotencyKey,
        );
        const next = captureService.listRecoveries()[0] ?? null;
        publishCapture(next);
        return next;
      }
      const kept = captureService.keepRecovered(
        options.sessionId,
        options.idempotencyKey,
      );
      publishCapture(kept);
      await finalizeCommittedCaptureTranscript({
        handoff: formalTranscriptHandoff,
        sessionId: kept.sessionId,
        displayName: activeCaptureTitle,
        processing: null,
        publish: publishCaption,
        reportFailure: () =>
          console.error("Voice2Text recovered formal handoff failed"),
      });
      return kept;
    },
    getCaptionSnapshot: async ({ sessionId }) =>
      transcriptRepository?.getSnapshot(sessionId) ?? null,
    retryFormalTranscript: async (command) => {
      if (!formalTranscriptHandoff || !localModelService) {
        throw new Error("formal transcript retry is unavailable");
      }
      const releaseAdmission = modelLeaseCoordinator?.beginProcessingTask();
      try {
        const capability = await localModelService.capability(
          "formal-transcription",
        );
        const pipeline = resourceCatalog?.processingPipelineIdentities();
        if (!capability.available || !pipeline) {
          throw new Error(
            `本地转写不可用：${capability.available ? "model-not-installed" : capability.reason}`,
          );
        }
        const snapshot = await formalTranscriptHandoff.retry(command, {
          operationId: "asr",
          ...pipeline.asr,
        });
        synchronizeModelProcessingTasks();
        publishCaption(snapshot);
        return snapshot;
      } finally {
        releaseAdmission?.();
      }
    },
    listAudios: async (options) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.listAudios(options);
    },
    openAudio: async (audioId) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.openAudio(audioId);
    },
    searchTranscript: async (options) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.searchTranscript(options);
    },
    editAudioSegment: async (command) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.editSegment(command);
    },
    undoAudioEdit: async (audioId, generationId, expectedRevision) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.undo(
        audioId,
        generationId,
        expectedRevision,
      );
    },
    redoAudioEdit: async (audioId, generationId, expectedRevision) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.redo(
        audioId,
        generationId,
        expectedRevision,
      );
    },
    renameAudioSpeaker: async (command) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.renameSpeaker(command);
    },
    mergeAudioSpeakers: async (command) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.mergeSpeakers(command);
    },
    assignAudioSpeaker: async (command) => {
      if (!audioWorkspaceService)
        throw new Error("audio workspace is unavailable");
      return audioWorkspaceService.assignSpeaker(command);
    },
    controlAudioPlayback: async (audioId, command) => {
      if (!audioPlaybackService)
        throw new Error("audio playback is unavailable");
      return await audioPlaybackService.command({ audioId, ...command });
    },
    exportAudio: async (audioId, format) => {
      if (!audioExportService) throw new Error("audio export is unavailable");
      return await audioExportService.exportAudio(audioId, format);
    },
  });
  if (floatingCaptureWindow && !floatingCaptureWindow.isDestroyed()) {
    unregisterFloatingIpc?.();
    unregisterFloatingIpc = registerFloatingCaptureIpc(floatingCaptureWindow);
  }
}

function requireCompanionService(): CompanionService {
  if (!companionService) {
    throw new Error("companion receiver is unavailable");
  }
  return companionService;
}

async function chooseAndImportAudio(): Promise<ImportAudioResponse> {
  if (!mainWindow || !profilePaths || !domainService || !desktopRepository) {
    throw new Error("Electron profile is not ready for import");
  }
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "安全导入音频",
    properties: ["openFile"],
    filters: [
      {
        name: "可归一化的音频与视频",
        extensions: [
          "wav",
          "aiff",
          "aif",
          "caf",
          "mp3",
          "aac",
          "m4a",
          "mov",
          "mp4",
        ],
      },
    ],
  });
  if (selection.canceled || selection.filePaths.length !== 1) {
    return { protocolVersion: desktopProtocolVersion, state: "canceled" };
  }
  const result = await importAudioFromSource(selection.filePaths[0]!, {
    minimumFreeBytes: 2 * 1024 * 1024 * 1024,
  });
  return {
    protocolVersion: desktopProtocolVersion,
    state: "imported",
    audioId: result.audioId,
    mediaSha256: result.mediaSha256,
    inserted: result.inserted,
  };
}

async function importAudioFromSource(
  sourcePath: string,
  options: {
    minimumFreeBytes: number;
    destinationId?: string;
    expectedSourceSha256?: string;
    discardExistingPublished?: boolean;
  },
) {
  if (!profilePaths || !domainService || !desktopRepository) {
    throw new Error("Electron profile is not ready for import");
  }
  if (options.expectedSourceSha256) {
    const existing = desktopRepository.committedImportForSourceSha256(
      options.expectedSourceSha256,
    );
    if (existing) {
      const result = {
        audioId: existing.audio.id,
        recordingId: existing.mediaAuthorityId,
        mediaSha256: existing.contentSha256,
        inserted: false,
        sourceSha256: options.expectedSourceSha256,
      };
      applicationState.setLibraryCount(desktopRepository.countAudios());
      return result;
    }
  }
  const destinationRoot = profilePaths.mediaDirectory;
  const helperPath = resolveMacOSNativeHelper({
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(helperPath)) {
    throw new Error("macOS 安全导入 helper 不可用");
  }
  const destinationId =
    options.destinationId ??
    `audio-${Date.now()}-${randomBytes(12).toString("hex")}`;
  const helper = new MacOSNativeHelperClient(helperPath);
  const nativeSession = await helper.openSession({
    exactSourcePaths: [sourcePath],
    destinationRoots: [destinationRoot],
  });
  try {
    const expectedPublishedPath = path.join(
      destinationRoot,
      "complete",
      `${destinationId}.wav`,
    );
    if (existsSync(expectedPublishedPath) && options.expectedSourceSha256) {
      if (!options.discardExistingPublished) {
        throw new Error("secure import destination already exists");
      }
      await nativeSession.discard(expectedPublishedPath, destinationRoot);
    }
    const receipt = await nativeSession.secureImport({
      sourcePath,
      destinationRoot,
      destinationId,
      expectedSourceSha256: options.expectedSourceSha256,
      maxSourceBytes: 4 * 1024 * 1024 * 1024,
      minimumFreeBytes: options.minimumFreeBytes,
      temporaryStorageMultiplier: 3,
      maxDurationMs: 4 * 60 * 60 * 1_000,
    });
    const importing = new SecureImportDomainService(domainService, {
      discard: async (committedPath) =>
        await nativeSession.discard(committedPath, destinationRoot),
    });
    const result = await importing.commitValidatedImport({
      displayName: path.basename(sourcePath),
      receipt,
    });
    applicationState.setLibraryCount(desktopRepository.countAudios());
    return { ...result, sourceSha256: receipt.sourceSha256 };
  } finally {
    await nativeSession.close();
  }
}

async function requestBootstrapAction(_action: BootstrapAction) {
  await bootstrapApplication();
  return applicationState.snapshot();
}

async function bootstrapApplication(): Promise<void> {
  if (bootstrapPromise) return await bootstrapPromise;
  if (profileDatabase) return;
  bootstrapPromise = initializeApplication();
  try {
    await bootstrapPromise;
  } finally {
    bootstrapPromise = null;
  }
}

async function initializeApplication(): Promise<void> {
  traceCaptureSmoke("initialize-start");
  applicationState.beginBootstrap();
  const profile = initializeAudioProfile(
    smokeAppDataPath ?? app.getPath("appData"),
  );
  if (profile.status === "blocked") {
    applicationState.completeBootstrap(profile);
    console.error(
      JSON.stringify({
        event: "electron-profile-initialization-blocked",
        code: profile.code,
        message: profile.message,
        repairable: profile.repairable,
      }),
    );
    if (
      bootstrapSmokeRequest ||
      processingSmokeRequest ||
      captureSmokeRequest ||
      captionFormalSmokeRequest ||
      aiBoundarySmokeRequest ||
      companionSmokeRequest
    )
      throw new Error(`Electron smoke profile blocked: ${profile.code}`);
    return;
  }
  profileDatabase = profile.database;
  traceCaptureSmoke("profile-ready");
  profilePaths = profile.profile;
  desktopRepository = new DesktopRepository(profile.database, profile.profile);
  transcriptRepository = new TranscriptRepository(
    profile.database,
    profile.profile,
  );
  domainService = new DesktopDomainService(desktopRepository);
  domainService.reconcileStartup();
  transcriptRepository.reconcileFormalProcessingAttempts(Date.now());
  try {
    await initializeCompanion(profile.database, profile.profile);
  } catch (error) {
    console.error("macOS companion initialization failed", error);
    unsubscribeCompanion?.();
    unsubscribeCompanion = null;
    await companionService?.close().catch(() => undefined);
    companionService = null;
    await companionNativeAdapter?.close().catch(() => undefined);
    companionNativeAdapter = null;
  }
  try {
    await initializeCapture(profile.database, profile.profile);
    traceCaptureSmoke("capture-ready");
  } catch (error) {
    console.error("macOS capture initialization failed", error);
    await microphoneTestService?.stopBeforeFormalCapture();
    microphoneTestService = null;
    await captureNativeSession?.close().catch(() => undefined);
    captureNativeSession = null;
    captureService = null;
  }
  const secretStore = captureNativeSession
    ? new MacOSHelperSecretStore(captureNativeSession)
    : new UnavailableDesktopSecretStore();
  audioAiService = new AudioAiService(
    new AiJobRepository(profile.database),
    secretStore,
  );
  audioAiService.reconcileInterrupted();
  void audioAiService.reconcileSecretCleanup().catch(() => undefined);
  audioAiService.subscribe(publishAudioAi);
  setupCaptureLifecycle();
  const workspaceRepository = new AudioWorkspaceRepository(
    profile.database,
    profile.profile,
  );
  audioWorkspaceService = new AudioWorkspaceService(workspaceRepository);
  audioPlaybackService = new AudioPlaybackService(
    workspaceRepository,
    new BrowserWindowPlaybackPort(
      app.isPackaged
        ? path.join(process.resourcesPath, "playback", "player.html")
        : path.resolve("resources/playback/player.html"),
    ),
  );
  audioExportService = new AudioExportService(
    audioWorkspaceService,
    async (request) => {
      try {
        if (processingSmokeRequest?.workstationOutputPath) {
          const destination = path.join(
            path.dirname(processingSmokeRequest.workstationOutputPath),
            `renderer-${request.suggestedName}`,
          );
          await writeExportAtomically(destination, request.contents);
          return {
            state: "saved",
            fileName: path.basename(destination),
          } as const;
        }
        if (!mainWindow) throw new Error("audio export window is unavailable");
        const selection = await dialog.showSaveDialog(mainWindow, {
          title: "导出音频",
          defaultPath: request.suggestedName,
          filters: [
            {
              name: request.extension.toUpperCase(),
              extensions: [request.extension],
            },
          ],
        });
        if (selection.canceled || !selection.filePath)
          return { state: "canceled" } as const;
        await writeExportAtomically(selection.filePath, request.contents);
        return {
          state: "saved",
          fileName: path.basename(selection.filePath),
        } as const;
      } catch {
        return {
          state: "failed",
          code: "export-write-failed",
          message: "音频导出失败，请重试。",
        } as const;
      }
    },
  );
  const attemptsRoot = path.join(
    profile.profile.workspaceDirectory,
    "attempts",
  );
  mkdirSync(attemptsRoot, { recursive: true, mode: 0o700 });
  cleanupExpiredTemporaryWorkspaces(attemptsRoot);
  const processSupervisor = new OwnedProcessSupervisor({
    workspaceRoot: profile.profile.workspaceDirectory,
  });
  processCoordinator = new DurableProcessCoordinator(processSupervisor, {
    requestCancellation: async (jobId) =>
      domainService!.requestProcessingCancellation(jobId),
    completeCancellation: async (intent) => {
      if (!domainService!.completeProcessingCancellation(intent)) {
        throw new Error(
          "durable cancellation completion lost its attempt fence",
        );
      }
    },
    publishResult: async (intent, payload) => {
      domainService!.publishProcessingResult({
        ...intent,
        complete: true,
        payload,
      });
    },
    recordProgress: async (intent, progress) => {
      domainService!.recordProcessingProgress(intent, {
        phase: progress.phase,
        fraction: progress.fraction,
      });
      emitOperation({
        jobId: intent.jobId,
        state: "running",
        attempt: intent.attempt,
        phase: progress.phase,
        progressFraction: progress.fraction,
      });
    },
  });
  try {
    traceCaptureSmoke("catalog-start");
    resourceCatalog = await ResourceCatalog.load(
      resolveResourceRoot({
        appRoot: app.getAppPath(),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    );
    await initializeLocalModels(true);
    const liveCaptionIdentity =
      resourceCatalog.processingIdentity("live-caption");
    if (liveCaptionIdentity && transcriptRepository) {
      liveCaptionService = new LiveCaptionService(
        transcriptRepository,
        {
          launch: async (options) => {
            if (!localModelService || !modelLeaseCoordinator) {
              throw new Error("实时字幕模型服务不可用");
            }
            const capability =
              await localModelService.capability("live-caption");
            if (!capability.available) {
              throw new Error(`实时字幕不可用：${capability.reason}`);
            }
            const lease = modelLeaseCoordinator.acquire(
              "live-caption",
              capability.generation,
            );
            const releaseStorageAccess = modelStorageAccess?.acquire(
              capability.storeId,
            );
            try {
              const worker = await CaptionWorkerSupervisor.launch({
                ...options,
                workspaceRoot: profile.profile.captureDirectory,
                command: resourceCatalog!.command("live-caption", {
                  attemptOutput: options.sessionRoot,
                }),
              });
              return {
                poll: async () => await worker.poll(),
                flush: async () => await worker.flush(),
                close: async () => {
                  try {
                    await worker.close();
                  } finally {
                    lease.release();
                    releaseStorageAccess?.();
                  }
                },
              };
            } catch (error) {
              lease.release();
              releaseStorageAccess?.();
              throw error;
            }
          },
        },
        publishCaption,
      );
      liveCaptionService.reconcileStartup();
    }
    if (transcriptRepository) {
      formalTranscriptHandoff = new FormalTranscriptHandoffService({
        repository: transcriptRepository,
        profile: profile.profile,
        flushDraft: async (sessionId) =>
          await liveCaptionService?.flush(sessionId),
        prepareMedia: async (sessionId) => {
          const snapshot = captureService?.snapshot();
          const durableCapture = profile.database
            .prepare(
              `SELECT state, recording_sha256, journal_sha256
               FROM capture_sessions WHERE session_id = ?`,
            )
            .get(sessionId);
          const smokeAuthority =
            captionFormalSmokeAuthority?.sessionId === sessionId
              ? captionFormalSmokeAuthority
              : null;
          if (
            (!snapshot ||
              snapshot.sessionId !== sessionId ||
              !snapshot.recordingSha256 ||
              !snapshot.journalSha256) &&
            (!durableCapture ||
              !["completed", "partial_capture"].includes(
                String(durableCapture.state),
              ) ||
              !durableCapture.recording_sha256 ||
              !durableCapture.journal_sha256) &&
            !smokeAuthority
          ) {
            throw new Error("finalized capture authority is unavailable");
          }
          return await prepareFormalCaptureMedia({
            profile: profile.profile,
            sessionId,
            recordingSha256:
              smokeAuthority?.recordingSha256 ??
              (snapshot?.sessionId === sessionId
                ? snapshot.recordingSha256!
                : String(durableCapture!.recording_sha256)),
            journalSha256:
              smokeAuthority?.journalSha256 ??
              (snapshot?.sessionId === sessionId
                ? snapshot.journalSha256!
                : String(durableCapture!.journal_sha256)),
          });
        },
        commitMedia: (media) => {
          domainService!.commitValidatedImport({
            displayName: media.displayName,
            normalizedPath: media.normalizedPath,
            normalizedSha256: media.normalizedSha256,
            sourceSha256: media.sourceSha256,
            normalizedSizeBytes: media.normalizedSizeBytes,
            durationMs: media.durationMs,
            receipt: media.receipt,
          });
          applicationState.setLibraryCount(desktopRepository!.countAudios());
        },
        scheduleProcessing: () => scheduleProcessing(),
      });
    }
    workerSupervisor = new WorkerHealthSupervisor(
      resourceCatalog.command("worker-health"),
    );
    applicationState.setProcessingCapability(
      resourceCatalog.processingPipelineIdentities()
        ? undefined
        : "本地 ASR 模型资源尚未安装，无法创建处理任务",
    );
    await cleanupNativeImportArtifacts(profile.profile, desktopRepository);
    if (processingSmokeRequest) {
      await runProcessingSmokeIfRequested();
    } else if (captionFormalSmokeRequest) {
      await runCaptionFormalSmokeIfRequested();
    }
    traceCaptureSmoke("catalog-ready");
  } catch (error) {
    await initializeLocalModels(false);
    applicationState.setProcessingCapability(
      error instanceof Error ? error.message : "本地处理运行时不可用",
    );
    if (
      bootstrapSmokeRequest ||
      processingSmokeRequest ||
      captionFormalSmokeRequest ||
      companionSmokeRequest
    )
      throw error;
  }
  applicationState.completeBootstrap(profile);
  applicationState.setLibraryCount(desktopRepository.countAudios());
  if (captureSmokeRequest) {
    traceCaptureSmoke("capture-smoke-start");
    await runCaptureSmokeIfRequested();
  }
  if (aiBoundarySmokeRequest) {
    await runAiBoundarySmokeIfRequested();
  }
  if (companionSmokeRequest) {
    await runCompanionSmokeIfRequested();
  }
  if (
    !processingSmokeRequest &&
    !captionFormalSmokeRequest &&
    !aiBoundarySmokeRequest &&
    !companionSmokeRequest
  )
    await runBootstrapSmokeIfRequested();
}

async function initializeLocalModels(runtimeReady: boolean): Promise<void> {
  if (localModelService) return;
  modelLeaseCoordinator = new ModelLeaseCoordinator();
  modelStorageAccess = new ModelStorageAccess(
    dialog,
    app,
    path.join(app.getPath("userData"), "local-models"),
  );
  localModelService = new LocalModelService({
    store: new ModelStore(app.getPath("userData")),
    gate: modelLeaseCoordinator,
    runtime: {
      state: runtimeReady ? "ready" : "damaged",
      message: runtimeReady
        ? "Worker Runtime 正常"
        : "应用运行组件损坏，请重新安装或修复应用",
      identity: runtimeReady ? (resourceCatalog?.identity ?? null) : null,
    },
    probeStore: async () => {
      await probeCurrentModelAuthorities();
    },
    probeBundle: async () => await probeCurrentModelAuthorities(),
    acquireStorageAccess: (storeId) => modelStorageAccess!.acquire(storeId),
  });
  localModelService.subscribe((snapshot) => {
    for (const listener of localModelListeners) listener(snapshot);
  });
  await modelStorageAccess.withAllStoredAccess(
    async () => await localModelService!.initialize(),
  );
  await refreshResourceModelAuthorities();
}

function synchronizeModelProcessingTasks(): void {
  modelLeaseCoordinator?.synchronizeProcessingTasks(
    domainService
      ? domainService
          .listProcessingTasks()
          .filter((task) =>
            ["queued", "running", "canceling"].includes(task.state),
          ).length
      : 0,
  );
}

async function refreshResourceModelAuthorities(): Promise<void> {
  if (!resourceCatalog || !localModelService) return;
  for (const bundleId of ["formal-transcription", "live-caption"] as const) {
    resourceCatalog.removeModelAuthority(bundleId);
    const authority = await localModelService.resourceAuthority(bundleId);
    if (authority) resourceCatalog.installModelAuthority(authority);
  }
  applicationState.setProcessingCapability(
    resourceCatalog.processingPipelineIdentities()
      ? undefined
      : "本地转写模型尚未安装",
  );
}

async function probeCurrentModelAuthorities(): Promise<void> {
  await refreshResourceModelAuthorities();
  if (!resourceCatalog) throw new Error("Worker Runtime 不可用");
  for (const operation of ["asr", "diarization", "live-caption"]) {
    try {
      await assertAuthorizedResourceCommand(
        resourceCatalog.command(operation, {
          attemptOutput:
            profilePaths?.workspaceDirectory ?? resourceCatalog.root,
        }),
      );
    } catch (error) {
      const bundle =
        operation === "live-caption" ? "live-caption" : "formal-transcription";
      if (await localModelService?.resourceAuthority(bundle)) throw error;
    }
  }
}

async function runAiBoundarySmokeIfRequested(): Promise<void> {
  const request = aiBoundarySmokeRequest;
  if (!request) return;
  if (!audioAiService || !profileDatabase || !captureNativeSession) {
    throw new Error("packaged AI boundary smoke services are unavailable");
  }
  const before = profileDatabase
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM ai_consents) AS consents,
        (SELECT COUNT(*) FROM ai_jobs) AS jobs,
        (SELECT COUNT(*) FROM ai_notes) AS notes`,
    )
    .get();
  const originalFetch = globalThis.fetch;
  let networkRequestCount = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    networkRequestCount += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  let settings;
  let invalidEndpointRejected = false;
  try {
    settings = await audioAiService.getSettings();
    try {
      parseRemoteAiEndpoint("http://untrusted.example.com");
    } catch {
      invalidEndpointRejected = true;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  if (!settings)
    throw new Error("packaged AI settings snapshot is unavailable");
  const selectedProfile = settings.profiles.find(
    (profile) => profile.profileId === settings.selectedProfileId,
  );
  const after = profileDatabase
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM ai_consents) AS consents,
        (SELECT COUNT(*) FROM ai_jobs) AS jobs,
        (SELECT COUNT(*) FROM ai_notes) AS notes`,
    )
    .get();
  const receipt = {
    schemaVersion: 1,
    phase: "packaged-ai-local-boundary",
    transport: captureNativeSession.transport,
    providerId:
      selectedProfile?.kind === "custom" ? selectedProfile.protocol : null,
    modelId:
      selectedProfile?.kind === "custom" ? selectedProfile.modelId : null,
    endpointIdentitySha256: createHash("sha256")
      .update(
        selectedProfile?.kind === "custom" ? selectedProfile.endpoint : "",
      )
      .digest("hex"),
    secretState:
      selectedProfile?.kind === "custom"
        ? selectedProfile.secretState
        : "missing",
    deviceSecurity: settings.deviceSecurity,
    invalidEndpointRejected,
    networkRequestCount,
    before,
    after,
    databaseUserVersion: Number(
      profileDatabase.prepare("PRAGMA user_version").get()?.user_version,
    ),
  };
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new Error(
      "AI boundary smoke receipt exceeded its privacy-safe bound",
    );
  }
  const temporaryPath = `${request.outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, encoded, { mode: 0o600 });
  await rename(temporaryPath, request.outputPath);
  app.quit();
}

async function runCompanionSmokeIfRequested(): Promise<void> {
  const request = companionSmokeRequest;
  if (
    !request ||
    !companionService ||
    !companionNativeAdapter ||
    !profileDatabase ||
    !resourceCatalog
  ) {
    if (request)
      throw new Error("packaged companion smoke services are unavailable");
    return;
  }
  let initial = companionService.snapshot();
  const port = initial.identity?.port;
  if (
    !initial.optIn ||
    initial.discovery.state !== "ready" ||
    !Number.isSafeInteger(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535
  ) {
    throw new Error("packaged companion receiver did not become ready");
  }
  if (request.phase === "pair-checkpoint") {
    initial = companionService.createPairingInvite(
      `packaged-pairing-${request.expectedTransferId}`,
    );
    if (!initial.pairingInvite) {
      throw new Error("packaged companion pairing invite is unavailable");
    }
  }
  const desktopPublicKey = await companionNativeAdapter.identityPublicKey();
  const desktopPublicKeyBase64 = desktopPublicKey.toString("base64");
  desktopPublicKey.fill(0);
  await writeCompanionSmokeJson(request.readyPath, {
    schemaVersion: 1,
    phase: request.phase,
    port,
    desktopDeviceId: initial.identity!.deviceId,
    desktopFingerprint: initial.identity!.fingerprint,
    desktopPublicKeyBase64,
    pairingInvite:
      request.phase === "pair-checkpoint" ? initial.pairingInvite : undefined,
  });
  const transfer =
    request.phase !== "verify"
      ? await waitForCompanionSmokeTransfer(
          companionService,
          request.expectedTransferId,
        )
      : companionService
          .snapshot()
          .transfers.find(
            (candidate) => candidate.transferId === request.expectedTransferId,
          );
  if (
    !transfer ||
    transfer.state !== "committed" ||
    !transfer.senderDeleteAllowed ||
    transfer.wholeFileSha256 !== request.expectedSourceSha256 ||
    !transfer.receipt
  ) {
    throw new Error("packaged companion transfer did not durably commit");
  }
  const durable = profileDatabase
    .prepare(
      `SELECT t.state, t.revision, t.audio_id, t.processing_job_id,
        t.recording_id, t.receipt_json, t.sender_delete_allowed,
        a.normalized_path, a.source_sha256, a.content_sha256, a.size_bytes
       FROM companion_transfers t
       JOIN audio_items m ON m.id = t.audio_id
       JOIN processing_jobs j ON j.id = t.processing_job_id AND j.audio_id = m.id
       JOIN media_authorities a ON a.id = t.recording_id AND a.id = m.media_authority_id
       WHERE t.transfer_id = ?`,
    )
    .get(request.expectedTransferId);
  if (
    !durable ||
    durable.state !== "committed" ||
    Number(durable.sender_delete_allowed) !== 1 ||
    durable.source_sha256 !== request.expectedSourceSha256 ||
    typeof durable.receipt_json !== "string"
  ) {
    throw new Error("packaged companion database authority is incomplete");
  }
  const normalizedSha256 = await sha256File(String(durable.normalized_path));
  if (normalizedSha256 !== durable.content_sha256) {
    throw new Error("packaged companion normalized media hash changed");
  }
  await writeCompanionSmokeJson(request.outputPath, {
    schemaVersion: 1,
    phase: request.phase === "verify" ? "restart-verified" : "committed",
    protocol: "companion-audio-transfer/v2",
    transferIdSha256: createHash("sha256")
      .update(request.expectedTransferId)
      .digest("hex"),
    sourceSha256: request.expectedSourceSha256,
    normalizedSha256,
    normalizedSizeBytes: Number(durable.size_bytes),
    receiptSha256: createHash("sha256")
      .update(String(durable.receipt_json))
      .digest("hex"),
    receiptSignatureSha256: createHash("sha256")
      .update(transfer.receipt.signature)
      .digest("hex"),
    audioId: Number(durable.audio_id),
    processingJobId:
      durable.processing_job_id == null
        ? null
        : Number(durable.processing_job_id),
    recordingId: Number(durable.recording_id),
    transferRevision: Number(durable.revision),
    senderDeleteAllowed: true,
    missingChunkCount: transfer.missingChunkCount,
    databaseUserVersion: Number(
      profileDatabase.prepare("PRAGMA user_version").get()?.user_version,
    ),
  });
  app.quit();
}

async function waitForCompanionSmokeTransfer(
  service: CompanionService,
  transferId: string,
): Promise<CompanionSnapshot["transfers"][number]> {
  const current = service
    .snapshot()
    .transfers.find((candidate) => candidate.transferId === transferId);
  if (current?.state === "committed") return current;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        unsubscribe();
        reject(new Error("packaged companion transfer timed out"));
      },
      10 * 60 * 1_000,
    );
    const unsubscribe = service.onSnapshot((snapshot) => {
      const transfer = snapshot.transfers.find(
        (candidate) => candidate.transferId === transferId,
      );
      if (!transfer) return;
      if (transfer.state === "committed") {
        clearTimeout(timer);
        unsubscribe();
        resolve(transfer);
      } else if (["failed", "canceled", "expired"].includes(transfer.state)) {
        clearTimeout(timer);
        unsubscribe();
        reject(
          new Error("packaged companion transfer reached a terminal failure"),
        );
      }
    });
  });
}

async function writeCompanionSmokeJson(
  outputPath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const encoded = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new Error("companion smoke receipt exceeded its privacy-safe bound");
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, encoded, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
}

async function initializeCapture(
  database: DatabaseSync,
  profile: AudioProfilePaths,
): Promise<void> {
  const helperPath = resolveMacOSNativeHelper({
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(helperPath))
    throw new Error("macOS capture helper is missing");
  const helper = new MacOSNativeHelperClient(helperPath, {
    handshakeTimeoutMs: 10_000,
    invokeTimeoutMs: 30_000,
  });
  captureNativeSession = await helper.openSession({
    exactSourcePaths: [],
    destinationRoots: [],
    captureSessionRoot: profile.captureDirectory,
  });
  const captureNativePort = new MacOSCaptureNativePort(captureNativeSession);
  microphoneTestService = new MicrophoneTestService(captureNativePort);
  captureService = new DesktopCaptureService(
    new CaptureRepository(database),
    captureNativePort,
    profile.captureDirectory,
  );
  const recoveries = await captureService.recover();
  activeCaptureTitle = recoveries.length > 0 ? "中断的音频录制" : "音频录制";
  publishCapture(recoveries[0] ?? captureService.snapshot());
}

async function initializeCompanion(
  database: DatabaseSync,
  profile: AudioProfilePaths,
): Promise<void> {
  const native = companionSmokeRequest
    ? createCompanionSmokeNativeAdapter(companionSmokeRequest)
    : new MacOSCompanionNativeAdapter(
        new MacOSNativeHelperClient(requireMacOSCompanionHelperPath(), {
          handshakeTimeoutMs: 10_000,
          invokeTimeoutMs: 30_000,
        }),
      );
  const repository = new TransferRepository(database);
  if (companionSmokeRequest) {
    repository.setReceiverEnabled(true, Date.now());
  }
  let service: CompanionService | null = null;
  const receiver = new CompanionReceiver({
    root: profile.transferDirectory,
    repository,
    security: native,
    identity: native,
    handlers: {
      resolveInvite: (input) => service?.resolveInvite(input) ?? null,
      confirmInvite: async (input) => {
        if (!service) throw new Error("companion service is unavailable");
        return await service.confirmInvite(input);
      },
      commitInvite: async (input) => {
        if (!service) throw new Error("companion service is unavailable");
        await service.commitInvite(input);
      },
      commit: async (manifest, stagedSourcePath) => {
        if (!service) throw new Error("companion service is unavailable");
        return await service.commitTransfer(manifest, stagedSourcePath);
      },
    },
    onTransferChanged: () => service?.notifyTransferChanged(),
    onSessionError: companionSmokeRequest
      ? (code) => process.stderr.write(`[companion-smoke] receiver=${code}\n`)
      : undefined,
  });
  const importCoordinator = new CompanionImportCoordinator({
    repository,
    lookupCommitted: (sourceSha256) => {
      const committed =
        desktopRepository?.committedImportForSourceSha256(sourceSha256);
      return committed
        ? {
            audioId: committed.audio.id,
            recordingId: committed.mediaAuthorityId,
            sourceSha256,
            normalizedPath: committed.normalizedPath,
            normalizedSha256: committed.contentSha256,
            normalizedSizeBytes: committed.normalizedSizeBytes,
          }
        : null;
    },
    validateCommitted: async (authority) =>
      await validatePinnedMediaAuthority({
        authorityPath: authority.normalizedPath,
        authorityDirectory: path.join(profile.mediaDirectory, "complete"),
        expectedBytes: authority.normalizedSizeBytes,
        expectedSha256: authority.normalizedSha256,
      }),
    publishedPath: (destinationIdentity) =>
      path.join(
        profile.mediaDirectory,
        "complete",
        `audio-companion-${destinationIdentity.slice(0, 32)}.wav`,
      ),
    publishedExists: existsSync,
    discardPublished: async (publishedPath) => {
      const helper = new MacOSNativeHelperClient(
        requireMacOSCompanionHelperPath(),
      );
      const session = await helper.openSession({
        exactSourcePaths: [],
        destinationRoots: [profile.mediaDirectory],
      });
      try {
        await session.discard(publishedPath, profile.mediaDirectory);
      } finally {
        await session.close();
      }
    },
    importFresh: async (stagedSourcePath, manifest, destinationIdentity) => {
      const imported = await importAudioFromSource(stagedSourcePath, {
        minimumFreeBytes: 2 * 1024 * 1024 * 1024,
        destinationId: `audio-companion-${destinationIdentity.slice(0, 32)}`,
        expectedSourceSha256: manifest.wholeFileSha256,
        discardExistingPublished: false,
      });
      const committed = desktopRepository?.committedImportForSourceSha256(
        imported.sourceSha256,
      );
      if (!committed) {
        throw new Error("companion secure import authority is unavailable");
      }
      return {
        audioId: committed.audio.id,
        recordingId: committed.mediaAuthorityId,
        sourceSha256: imported.sourceSha256,
        normalizedPath: committed.normalizedPath,
        normalizedSha256: committed.contentSha256,
        normalizedSizeBytes: committed.normalizedSizeBytes,
      };
    },
  });
  service = new CompanionService(
    repository,
    native,
    native,
    receiver,
    native,
    {
      commitVerifiedTransfer: (stagedSourcePath, manifest) =>
        importCoordinator.commitVerifiedTransfer(stagedSourcePath, manifest),
    },
    Date.now,
    undefined,
    companionSmokeRequest ? () => "127.0.0.1" : undefined,
  );
  companionNativeAdapter = native;
  companionService = service;
  unsubscribeCompanion = service.onSnapshot(publishCompanion);
  publishCompanion(await service.reconcileStartup());
}

function requireMacOSCompanionHelperPath(): string {
  const helperPath = resolveMacOSNativeHelper({
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(helperPath)) {
    throw new Error("macOS companion helper is missing");
  }
  return helperPath;
}

function createCompanionSmokeNativeAdapter(
  request: CompanionSmokeRequest,
): MacOSCompanionNativeAdapter {
  const invokeRaw = async (command: Record<string, unknown>) => {
    if (command.command === "companion-credential-read") {
      const credentialRequest = command.request as
        { kind?: unknown; peerDeviceId?: unknown } | undefined;
      const credential =
        credentialRequest?.kind === "identity-seed"
          ? request.identitySeed
          : credentialRequest?.kind === "peer-shared" &&
              typeof credentialRequest.peerDeviceId === "string"
            ? readCompanionSmokeCredentialStore(request.credentialStorePath)
            : null;
      return {
        companionCredential: credential
          ? {
              schemaVersion: 1,
              state: "available",
              credentialBase64: credential.toString("base64"),
            }
          : { schemaVersion: 1, state: "missing" },
      };
    }
    if (command.command === "companion-credential-replace") {
      const credentialRequest = command.request as
        | {
            kind?: unknown;
            peerDeviceId?: unknown;
            credentialBase64?: unknown;
          }
        | undefined;
      if (
        credentialRequest?.kind !== "peer-shared" ||
        typeof credentialRequest.peerDeviceId !== "string"
      ) {
        throw new Error("packaged companion credential target is invalid");
      }
      const credential = decodeCompanionSmokeSecret(
        credentialRequest.credentialBase64,
      );
      const temporaryPath = `${request.credentialStorePath}.tmp-${process.pid}`;
      try {
        await writeFile(temporaryPath, credential, { mode: 0o600, flag: "wx" });
        await rename(temporaryPath, request.credentialStorePath);
      } finally {
        credential.fill(0);
        await rm(temporaryPath, { force: true });
      }
      return {
        companionCredential: { schemaVersion: 1, state: "stored" },
      };
    }
    if (command.command === "companion-credential-delete") {
      const existed = existsSync(request.credentialStorePath);
      if (existed) unlinkSync(request.credentialStorePath);
      return {
        companionCredential: {
          schemaVersion: 1,
          state: existed ? "deleted" : "missing",
        },
      };
    }
    if (
      command.command === "companion-discovery-register" ||
      command.command === "companion-discovery-status"
    ) {
      const discoveryRequest = command.request as
        { port?: unknown } | undefined;
      const port =
        command.command === "companion-discovery-register"
          ? discoveryRequest?.port
          : companionService?.snapshot().identity?.port;
      return {
        companionDiscovery: {
          schemaVersion: 1,
          state: "registered",
          serviceType: "_voice2text-audio._tcp.",
          port,
          registeredName: "Voice2Text Packaged Smoke",
          manualFallbackAvailable: false,
        },
      };
    }
    if (command.command === "companion-discovery-unregister") {
      return {
        companionDiscovery: {
          schemaVersion: 1,
          state: "stopped",
          serviceType: "_voice2text-audio._tcp.",
          port: null,
          registeredName: null,
          manualFallbackAvailable: true,
        },
      };
    }
    throw new Error("packaged companion smoke native command is unavailable");
  };
  return new MacOSCompanionNativeAdapter({
    openSession: async (
      capabilities: Parameters<MacOSNativeHelperClient["openSession"]>[0],
    ) => {
      if (
        capabilities.companionDiscovery !== true ||
        capabilities.exactSourcePaths.length !== 0 ||
        capabilities.destinationRoots.length !== 0
      ) {
        throw new Error("packaged companion smoke capability mismatch");
      }
      return {
        invokeRaw,
        close: async () => undefined,
      } as unknown as MacOSNativeHelperSession;
    },
  } as unknown as MacOSNativeHelperClient);
}

function readCompanionSmokeCredentialStore(pathname: string): Buffer | null {
  if (!existsSync(pathname)) return null;
  const stat = lstatSync(pathname);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size !== 32 ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(pathname) !== pathname ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("packaged companion credential store is unsafe");
  }
  return readFileSync(pathname);
}

async function runCaptureSmokeIfRequested(): Promise<void> {
  const request = captureSmokeRequest;
  if (!request) return;
  if (!captureService || !captureNativeSession || !profileDatabase) {
    throw new Error("packaged capture smoke services are unavailable");
  }
  if (request.phase === "initialize") {
    await writeCaptureSmokeReceipt(request.outputPath, {
      schemaVersion: 1,
      phase: "profile-initialized",
      databaseUserVersion: Number(
        profileDatabase.prepare("PRAGMA user_version").get()?.user_version,
      ),
      transport: captureNativeSession.transport,
    });
    await exitInitializedCaptureSmoke(85);
    return;
  }
  const recoveries = captureService.listRecoveries();
  if (recoveries.length !== 1) {
    throw new Error("packaged capture smoke expected one recovery");
  }
  const recovery = recoveries[0]!;
  const recoveryReceiptCount = Number(
    profileDatabase
      .prepare(
        "SELECT COUNT(*) AS count FROM capture_command_receipts WHERE session_id = ? AND action = 'recover'",
      )
      .get(recovery.sessionId)?.count ?? -1,
  );
  if (recoveryReceiptCount !== 1) {
    throw new Error("packaged recovery receipt was not idempotent");
  }
  if (request.phase === "crash") {
    profileDatabase.exec("PRAGMA wal_checkpoint(FULL)");
    await writeCaptureSmokeReceipt(request.outputPath, {
      schemaVersion: 1,
      phase: "recovered-before-crash",
      recoveryReceiptCount,
      transport: captureNativeSession.transport,
      sessionIdentitySha256: createHash("sha256")
        .update(recovery.sessionId)
        .digest("hex"),
    });
    hardExitCaptureSmoke(86);
  }
  const kept = captureService.keepRecovered(
    recovery.sessionId,
    `keep-smoke-${recovery.sessionId}`,
  );
  const row = profileDatabase
    .prepare(
      `SELECT state, recording_sha256, journal_sha256, recovery_disposition
       FROM capture_sessions WHERE session_id = ?`,
    )
    .get(recovery.sessionId);
  const counts = profileDatabase
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM capture_tracks WHERE session_id = ?) AS tracks,
        (SELECT COUNT(*) FROM capture_chunks WHERE session_id = ?) AS chunks,
        (SELECT COUNT(*) FROM capture_events WHERE session_id = ?) AS events,
        (SELECT COUNT(*) FROM capture_command_receipts WHERE session_id = ?) AS receipts`,
    )
    .get(
      recovery.sessionId,
      recovery.sessionId,
      recovery.sessionId,
      recovery.sessionId,
    );
  const trackCount = Number(counts?.tracks ?? -1);
  const chunkCount = Number(counts?.chunks ?? -1);
  const eventCount = Number(counts?.events ?? -1);
  const receiptCount = Number(counts?.receipts ?? -1);
  if (
    row?.state !== "partial_capture" ||
    row.recovery_disposition !== "kept" ||
    row.recording_sha256 !== kept.recordingSha256 ||
    row.journal_sha256 !== kept.journalSha256 ||
    trackCount < 1 ||
    chunkCount < 1 ||
    receiptCount !== 2
  ) {
    throw new Error("packaged capture DB authority did not commit atomically");
  }
  captureSmokeQuitEvidence = {
    schemaVersion: 1,
    phase: "recovered-kept-after-restart",
    transport: captureNativeSession.transport,
    sessionIdentitySha256: createHash("sha256")
      .update(recovery.sessionId)
      .digest("hex"),
    recordingSha256: kept.recordingSha256,
    journalSha256: kept.journalSha256,
    recoveryReceiptCount,
    trackCount,
    chunkCount,
    eventCount,
    receiptCount,
    databaseUserVersion: Number(
      profileDatabase.prepare("PRAGMA user_version").get()?.user_version,
    ),
    quitPolicy: {
      defaultAction:
        activeCaptureQuitDialog.buttons[activeCaptureQuitDialog.defaultId],
      cancelAction:
        activeCaptureQuitDialog.buttons[activeCaptureQuitDialog.cancelId],
      offersDiscard: activeCaptureQuitDialog.buttons.some((button) =>
        /discard|丢弃/i.test(button),
      ),
    },
  };
  const smokeSessionId = "session-quit-lifecycle-123456";
  const smokeHash = createHash("sha256")
    .update("packaged-quit-lifecycle-authority")
    .digest("hex");
  const recording = (): CaptureSnapshot => ({
    sessionId: smokeSessionId,
    state: "recording",
    captureMode: "microphone_only",
    captureTimelineMs: 1,
    systemAudioHealthy: false,
    microphoneHealthy: true,
    partialCapture: false,
    finalizedChunkCount: 0,
    eventCount: 0,
    gapCount: 0,
    interruptionReason: null,
    recordingSha256: null,
    journalSha256: null,
  });
  const smokeNative: CaptureNativePort = {
    preflight: async () => {
      throw new Error("smoke preflight is unavailable");
    },
    start: async () => recording(),
    pause: async () => ({ ...recording(), state: "paused" }),
    resume: async () => recording(),
    stop: async () => {
      captureSmokeStopCalls += 1;
      return {
        ...recording(),
        state: "completed",
        microphoneHealthy: false,
        recordingSha256: smokeHash,
        journalSha256: smokeHash,
      };
    },
    systemSleep: async () => ({ ...recording(), state: "paused" }),
    systemWake: async () => ({ ...recording(), state: "paused" }),
    snapshot: async () => recording(),
    recover: async () => [],
    discard: async () => undefined,
    startMicrophoneTest: async (testId) => ({
      testId,
      state: "running",
      elapsedMs: 0,
      normalizedRMS: 0,
      normalizedPeak: 0,
      observedFrames: 0,
      observedSound: false,
    }),
    microphoneTestSnapshot: async (testId) => ({
      testId,
      state: "running",
      elapsedMs: 0,
      normalizedRMS: 0,
      normalizedPeak: 0,
      observedFrames: 0,
      observedSound: false,
    }),
    finishMicrophoneTest: async (testId) => ({
      testId,
      state: "finished",
      reason: "no-audio-frames",
      elapsedMs: 0,
      normalizedRMS: 0,
      normalizedPeak: 0,
      observedFrames: 0,
      observedSound: false,
    }),
    cancelMicrophoneTest: async (testId) => ({
      testId,
      state: "cancelled",
      elapsedMs: 0,
      normalizedRMS: 0,
      normalizedPeak: 0,
      observedFrames: 0,
      observedSound: false,
    }),
  };
  captureService = new DesktopCaptureService(
    new CaptureRepository(profileDatabase),
    smokeNative,
    profilePaths!.captureDirectory,
    Date.now,
    async () => ({
      schema: "desktop-capture-session/v1",
      sessionId: smokeSessionId,
      captureMode: "microphone_only",
      tracks: [
        {
          kind: "microphone",
          healthy: false,
          sampleRate: 48_000,
          channels: 1,
          format: "float32",
        },
      ],
      chunks: [],
      events: [],
    }),
  );
  publishCapture(
    await captureService.start({
      sessionId: smokeSessionId,
      title: "Packaged quit lifecycle",
      idempotencyKey: "start-quit-lifecycle-123456",
      minimumFreeBytes: 0,
      captionEnabled: false,
    }),
  );
  captureSmokeQuitChoices = [0, 1];
  app.quit();
}

async function writeCaptureSmokeReceipt(
  outputPath: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new Error("capture smoke receipt exceeded its privacy-safe bound");
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, encoded, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
}

async function exitInitializedCaptureSmoke(exitCode: number): Promise<void> {
  teardownPromise ??= teardownOwnedResources();
  await teardownPromise;
  teardownComplete = true;
  mainWindow?.destroy();
  mainWindow = null;
  hardExitCaptureSmoke(exitCode);
}

function hardExitCaptureSmoke(exitCode: number): never {
  const reallyExit = (
    process as NodeJS.Process & { reallyExit?: (code: number) => never }
  ).reallyExit;
  if (typeof reallyExit !== "function") {
    throw new Error("capture smoke hard-exit primitive is unavailable");
  }
  return reallyExit(exitCode);
}

function traceCaptureSmoke(stage: string): void {
  if (!captureSmokeRequest) return;
  appendFileSync(`${captureSmokeRequest.outputPath}.trace`, `${stage}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

if (isPrimaryInstance) {
  process.once("SIGTERM", () => app.quit());
  process.once("SIGINT", () => app.quit());
  void app
    .whenReady()
    .then(async () => {
      configureSessionSecurity();
      loadFloatingCapturePreference();
      const reconcileDisplays = () =>
        reconcileFloatingCapturePresentation(
          deriveFloatingCaptureSnapshot(applicationState.snapshot()),
          true,
        );
      screen.on("display-removed", reconcileDisplays);
      screen.on("display-metrics-changed", reconcileDisplays);
      mainWindow = createMainWindow();
      bindDesktopIpc(mainWindow);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await bootstrapApplication();
    })
    .catch(async (error: unknown) => {
      console.error("Voice2Text bootstrap failed", error);
      teardownPromise ??= teardownOwnedResources();
      await teardownPromise.catch(() => undefined);
      teardownComplete = true;
      app.exit(1);
    });

  app.on("second-instance", () => {
    showMainWindow();
  });

  app.on("activate", () => {
    if (teardownPromise) return;
    showMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", (event) => {
    if (
      captureSmokeRequest?.phase === "initialize" ||
      captureSmokeRequest?.phase === "crash"
    )
      return;
    if (teardownComplete) return;
    event.preventDefault();
    teardownPromise ??= prepareCaptureForQuit()
      .then(async (shouldQuit) => {
        if (!shouldQuit) {
          teardownPromise = null;
          return;
        }
        await teardownOwnedResources();
        teardownComplete = true;
        app.quit();
      })
      .catch((error: unknown) => {
        teardownPromise = null;
        console.error(
          "Voice2Text process teardown failed; quit was stopped",
          error,
        );
      });
  });
}

function reportBootstrapFailure(stage: string, error: unknown): void {
  if (
    !process.env.VOICE2TEXT_CAPTURE_SMOKE_PHASE &&
    !process.env.VOICE2TEXT_CAPTION_FORMAL_SMOKE_PHASE &&
    !process.env.VOICE2TEXT_COMPANION_SMOKE_REQUEST
  )
    return;
  const record = error instanceof Error ? error : new Error("unknown error");
  const candidateCode = (error as NodeJS.ErrnoException | undefined)?.code;
  const code = typeof candidateCode === "string" ? candidateCode : "none";
  const sanitize = (value: string): string =>
    value
      .replace(/(?:\/[^\s:]+)+/g, "<path>")
      .replace(/\b(?:nonce|secret|token)=[^\s]+/gi, "$1=<redacted>")
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 240);
  const receipt = JSON.stringify({
    stage: sanitize(stage),
    name: sanitize(record.name),
    code: sanitize(code),
    message: sanitize(record.message),
  });
  try {
    process.stderr.write(`[capture-bootstrap-error] ${receipt}\n`);
  } catch {
    // A diagnostic failure must not replace the original bootstrap failure.
  }
}

async function teardownOwnedResources(): Promise<void> {
  teardownStarted = true;
  await floatingPreferenceMutation;
  await captureControlMutation;
  unregisterIpc?.();
  unregisterIpc = null;
  await processCoordinator?.shutdown();
  await processingLoop?.catch(() => undefined);
  processingLoop = null;
  processCoordinator = null;
  await workerSupervisor?.shutdown();
  workerSupervisor = null;
  await audioPlaybackService?.close();
  audioPlaybackService = null;
  audioExportService = null;
  audioWorkspaceService = null;
  await audioAiService?.shutdown();
  audioAiService = null;
  unsubscribeCompanion?.();
  unsubscribeCompanion = null;
  await companionService?.close();
  companionService = null;
  await companionNativeAdapter?.close();
  companionNativeAdapter = null;
  companionSmokeRequest?.identitySeed.fill(0);
  if (capturePollTimer) clearInterval(capturePollTimer);
  capturePollTimer = null;
  await liveCaptionService?.shutdown();
  liveCaptionService = null;
  await microphoneTestService?.stopBeforeFormalCapture();
  microphoneTestService = null;
  await captureNativeSession?.close();
  captureNativeSession = null;
  captureService = null;
  formalTranscriptHandoff = null;
  captureTray?.destroy();
  captureTray = null;
  profileDatabase?.close();
  profileDatabase = null;
  profilePaths = null;
  domainService = null;
  desktopRepository = null;
  transcriptRepository = null;
  localModelService?.close();
  localModelService = null;
  modelLeaseCoordinator = null;
  modelStorageAccess = null;
  resourceCatalog = null;
}

function publishAudioAi(snapshot: AudioAiSnapshot): void {
  for (const listener of audioAiListeners) listener(snapshot);
}

function publishCompanion(snapshot: CompanionSnapshot): void {
  for (const listener of companionListeners) listener(snapshot);
}

function emitOperation(event: Omit<OperationEvent, "protocolVersion">): void {
  const value: OperationEvent = {
    protocolVersion: desktopProtocolVersion,
    ...event,
  };
  for (const listener of operationListeners) listener(value);
  try {
    const caption = transcriptRepository?.syncFormalForProcessingJob(
      event.jobId,
      Date.now(),
    );
    if (caption) publishCaption(caption);
  } catch {
    console.error("Voice2Text caption formal state sync failed");
  }
}

function publishCaption(snapshot: CaptionSnapshot): void {
  for (const listener of captionListeners) listener(snapshot);
}

function scheduleProcessing(): void {
  if (processingLoop) return;
  processingLoop = drainProcessingQueue()
    .catch((error: unknown) => {
      console.error("Voice2Text processing queue failed", error);
    })
    .finally(() => {
      processingLoop = null;
    });
}

async function drainProcessingQueue(): Promise<void> {
  while (
    !teardownPromise &&
    domainService &&
    desktopRepository &&
    profilePaths &&
    resourceCatalog &&
    processCoordinator &&
    resourceCatalog.processingPipelineIdentities()
  ) {
    const service = domainService;
    const repository = desktopRepository;
    const profile = profilePaths;
    const catalog = resourceCatalog;
    const coordinator = processCoordinator;
    const pipeline = catalog.processingPipelineIdentities();
    if (!pipeline) return;
    const intent = service.claimNextProcessingJob({
      sourceIdentity: `worker-${randomBytes(16).toString("hex")}`,
      deadlineAtMs: Date.now() + 29 * 60 * 1_000,
    });
    if (!intent) return;
    let activeIntent = intent;
    let releaseProcessingTask: (() => void) | null = null;
    let modelLease: ReturnType<ModelLeaseCoordinator["acquire"]> | null = null;
    let releaseModelStorageAccess: (() => void) | null = null;
    const sourcePath = repository.sourcePathForJob(intent.jobId);
    const attemptDirectory = path.join(
      profile.workspaceDirectory,
      "attempts",
      `${intent.jobId}-${intent.attempt}`,
    );
    if (
      !prepareProcessingAttempt({
        intent,
        attemptDirectory,
        interrupt: (claimedIntent, errorCode) =>
          service.interruptProcessingAttempt(claimedIntent, errorCode),
        emitInterrupted: () =>
          emitOperation({
            jobId: intent.jobId,
            state: "interrupted",
            attempt: intent.attempt,
            phase: intent.phase,
          }),
      })
    ) {
      continue;
    }
    emitOperation({
      jobId: intent.jobId,
      state: "running",
      attempt: intent.attempt,
      phase: intent.phase,
      progressFraction: 0,
    });
    try {
      if (!localModelService || !modelLeaseCoordinator) {
        throw new Error("本地转写模型服务不可用");
      }
      const capability = await localModelService.capability(
        "formal-transcription",
      );
      if (!capability.available) {
        throw new Error(`本地转写不可用：${capability.reason}`);
      }
      modelLease = modelLeaseCoordinator.acquire(
        "formal-transcription",
        capability.generation,
      );
      releaseModelStorageAccess =
        modelStorageAccess?.acquire(capability.storeId) ?? null;
      releaseProcessingTask = modelLeaseCoordinator.beginProcessingTask();
      if (!sourcePath)
        throw new Error("processing job has no authoritative media path");
      const startedAtMs = Date.now();
      const asrPayload = await coordinator.runPhase({
        intent,
        command: catalog.command("asr", {
          runtimeRoot: path.join(catalog.root, "runtime"),
          attemptOutput: attemptDirectory,
        }),
        attemptOutputDirectory: attemptDirectory,
        inputFrame: {
          schemaVersion: 1,
          sourcePath,
          sourceSha256: intent.sourceSha256,
        },
        frameAdapter: adaptExistingAsrWorkerFrame,
      });
      activeIntent = service.advanceProcessingPhase(intent, {
        operationId: "diarization",
        phase: "diarization",
        ...pipeline.diarization,
      });
      emitOperation({
        jobId: activeIntent.jobId,
        state: "running",
        attempt: activeIntent.attempt,
        phase: activeIntent.phase,
        progressFraction: 0.45,
      });
      let diarizationPayload: Record<string, unknown> | null = null;
      let diarizationErrorCode: "DIARIZATION_FAILED" | null = null;
      try {
        diarizationPayload = await coordinator.runPhase({
          intent: activeIntent,
          command: catalog.command("diarization", {
            runtimeRoot: path.join(catalog.root, "runtime"),
            attemptOutput: attemptDirectory,
          }),
          attemptOutputDirectory: attemptDirectory,
          inputFrame: {
            schemaVersion: 1,
            sourcePath,
            sourceSha256: activeIntent.sourceSha256,
          },
          frameAdapter: adaptExistingAsrWorkerFrame,
        });
      } catch (error) {
        if (error instanceof WorkerReportedError) {
          diarizationErrorCode = "DIARIZATION_FAILED";
        } else {
          throw error;
        }
      }
      service.publishProcessingResult({
        ...activeIntent,
        complete: true,
        payload: finalizeExistingSherpaResult(
          asrPayload,
          diarizationPayload,
          diarizationErrorCode,
          Date.now() - startedAtMs,
        ),
      });
      emitOperation({
        jobId: activeIntent.jobId,
        state: "completed",
        attempt: activeIntent.attempt,
        phase: activeIntent.phase,
        progressFraction: 1,
      });
    } catch (error) {
      if (!(error instanceof ProcessCanceledError)) {
        service.interruptProcessingAttempt(
          activeIntent,
          error instanceof ProcessDeadlineError
            ? "PROCESS_TIMEOUT"
            : "PROCESS_INTERRUPTED",
        );
        emitOperation({
          jobId: activeIntent.jobId,
          state: "interrupted",
          attempt: activeIntent.attempt,
          phase: activeIntent.phase,
        });
      }
    } finally {
      releaseProcessingTask?.();
      modelLease?.release();
      releaseModelStorageAccess?.();
      await rm(attemptDirectory, { force: true, recursive: true });
    }
  }
}

async function cleanupNativeImportArtifacts(
  profile: AudioProfilePaths,
  repository: DesktopRepository,
): Promise<void> {
  if (process.platform !== "darwin") return;
  const helperPath = resolveMacOSNativeHelper({
    appRoot: app.getAppPath(),
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!existsSync(helperPath)) return;
  const helper = new MacOSNativeHelperClient(helperPath);
  const nativeSession = await helper.openSession({
    exactSourcePaths: [],
    destinationRoots: [profile.mediaDirectory],
  });
  try {
    await nativeSession.cleanup(profile.mediaDirectory);
    await cleanupExpiredOrphanedImportedMedia(
      profile.mediaDirectory,
      repository
        .listMediaAuthorities()
        .map((authority) => authority.normalizedPath),
      async (orphanPath) =>
        await nativeSession.discard(orphanPath, profile.mediaDirectory),
    );
  } finally {
    await nativeSession.close();
  }
}
