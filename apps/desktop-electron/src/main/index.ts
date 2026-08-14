import path from "node:path";
import { writeFile, rename } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import { app, BrowserWindow, session } from "electron";

import { registerDesktopIpc } from "./ipc";
import { initializeElectronProfile } from "./profile/electron_profile";
import { resolveWorkerResources } from "./resource_locator";
import { secureWebPreferences } from "./security";
import { WorkerHealthSupervisor } from "./worker_health";

app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let unregisterIpc: (() => void) | null = null;
let workerSupervisor: WorkerHealthSupervisor | null = null;
let profileDatabase: DatabaseSync | null = null;

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
    if (
      currentUrl &&
      new URL(targetUrl).origin !== new URL(currentUrl).origin
    ) {
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

void app.whenReady().then(async () => {
  const profile = initializeElectronProfile(app.getPath("appData"));
  if (profile.status === "blocked") {
    console.error(
      JSON.stringify({
        event: "electron-profile-initialization-blocked",
        code: profile.code,
        message: profile.message,
        repairable: profile.repairable,
      }),
    );
    app.quit();
    return;
  }
  profileDatabase = profile.database;
  configureSessionSecurity();
  workerSupervisor = new WorkerHealthSupervisor(
    resolveWorkerResources({
      appRoot: app.getAppPath(),
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
  );
  mainWindow = createMainWindow();
  unregisterIpc = registerDesktopIpc(mainWindow, workerSupervisor);
  await runBootstrapSmokeIfRequested();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
    if (workerSupervisor) {
      unregisterIpc?.();
      unregisterIpc = registerDesktopIpc(mainWindow, workerSupervisor);
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  unregisterIpc?.();
  unregisterIpc = null;
  workerSupervisor?.shutdown();
  profileDatabase?.close();
  profileDatabase = null;
});
