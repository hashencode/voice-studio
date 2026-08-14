import path from "node:path";
import { writeFile, rename } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { app, BrowserWindow, session } from "electron";

import type { BootstrapAction } from "../shared/contracts";
import { DesktopApplicationState } from "./application/application_state";
import { registerDesktopIpc } from "./ipc";
import { canceledResponse } from "./ipc/desktop_ipc";
import { DesktopDomainService } from "./domain/desktop_domain_service";
import { DurableProcessCoordinator } from "./processes/durable_process_coordinator";
import { OwnedProcessSupervisor } from "./processes/owned_process_supervisor";
import { initializeElectronProfile } from "./profile/electron_profile";
import {
  ResourceCatalog,
  resolveResourceRoot,
} from "./resources/resource_catalog";
import { secureWebPreferences } from "./security";
import { DesktopRepository } from "./storage/desktop_repository";
import { WorkerHealthSupervisor } from "./worker_health";

app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let unregisterIpc: (() => void) | null = null;
let workerSupervisor: WorkerHealthSupervisor | null = null;
let processCoordinator: DurableProcessCoordinator | null = null;
let profileDatabase: DatabaseSync | null = null;
let teardownPromise: Promise<void> | null = null;
let teardownComplete = false;
let bootstrapPromise: Promise<void> | null = null;
const applicationState = new DesktopApplicationState();

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
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
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
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src${connectSource}; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
        ],
      },
    });
  });
}

async function runBootstrapSmokeIfRequested(): Promise<void> {
  const outputPath = process.env.VOICE2TEXT_BOOTSTRAP_SMOKE_OUTPUT;
  if (!outputPath || !workerSupervisor) return;
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
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, outputPath);
  app.quit();
}

function bindDesktopIpc(window: BrowserWindow): void {
  unregisterIpc?.();
  unregisterIpc = registerDesktopIpc(window, {
    applicationSnapshot: () => applicationState.snapshot(),
    navigate: (section) => applicationState.navigate(section),
    requestBootstrapAction: async (action) =>
      await requestBootstrapAction(action),
    onApplicationSnapshot: (listener) => applicationState.subscribe(listener),
    workerHealth: async () => {
      if (!workerSupervisor)
        throw new Error("worker capability is unavailable");
      return await workerSupervisor.check();
    },
    cancelProcessing: async (jobId) => {
      if (!processCoordinator || !(await processCoordinator.cancel(jobId))) {
        throw new Error("processing job is not running or canceling");
      }
      return canceledResponse(jobId);
    },
  });
}

async function requestBootstrapAction(action: BootstrapAction) {
  if (action === "repair-guidance") return applicationState.snapshot();
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
  applicationState.beginBootstrap();
  const profile = initializeElectronProfile(app.getPath("appData"));
  applicationState.completeBootstrap(profile);
  if (profile.status === "blocked") {
    console.error(
      JSON.stringify({
        event: "electron-profile-initialization-blocked",
        code: profile.code,
        message: profile.message,
        repairable: profile.repairable,
      }),
    );
    return;
  }
  profileDatabase = profile.database;
  const domainService = new DesktopDomainService(
    new DesktopRepository(profile.database, profile.profile),
  );
  const processSupervisor = new OwnedProcessSupervisor({
    workspaceRoot: profile.profile.workspaceDirectory,
  });
  processCoordinator = new DurableProcessCoordinator(processSupervisor, {
    requestCancellation: async (jobId) =>
      domainService.requestProcessingCancellation(jobId),
    completeCancellation: async (intent) => {
      if (!domainService.completeProcessingCancellation(intent)) {
        throw new Error(
          "durable cancellation completion lost its attempt fence",
        );
      }
    },
    publishResult: async (intent, payload) => {
      domainService.publishProcessingResult({
        ...intent,
        complete: true,
        payload,
      });
    },
  });
  try {
    const resourceCatalog = await ResourceCatalog.load(
      resolveResourceRoot({
        appRoot: app.getAppPath(),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    );
    workerSupervisor = new WorkerHealthSupervisor(
      resourceCatalog.command("worker-health"),
    );
    applicationState.setProcessingCapability();
  } catch (error) {
    applicationState.setProcessingCapability(
      error instanceof Error ? error.message : "本地处理运行时不可用",
    );
  }
  await runBootstrapSmokeIfRequested();
}

void app.whenReady().then(async () => {
  configureSessionSecurity();
  mainWindow = createMainWindow();
  bindDesktopIpc(mainWindow);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await bootstrapApplication();
});

app.on("activate", () => {
  if (teardownPromise) return;
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
    bindDesktopIpc(mainWindow);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (teardownComplete) return;
  event.preventDefault();
  teardownPromise ??= teardownOwnedResources()
    .then(() => {
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

async function teardownOwnedResources(): Promise<void> {
  unregisterIpc?.();
  unregisterIpc = null;
  await processCoordinator?.shutdown();
  processCoordinator = null;
  await workerSupervisor?.shutdown();
  workerSupervisor = null;
  profileDatabase?.close();
  profileDatabase = null;
}
