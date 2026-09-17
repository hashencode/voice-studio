import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/main/index.ts"),
  "utf8",
);

describe("capture quit Main wiring", () => {
  it("routes interactive before-quit events through one coordinator", () => {
    expect(mainSource).toContain(
      "const captureQuitCoordinator = new CaptureQuitCoordinator",
    );
    expect(mainSource).toMatch(
      /app\.on\("before-quit",[\s\S]*captureQuitCoordinator\.allowsNativeQuit[\s\S]*captureQuitCoordinator\.requestInteractive\(\)/,
    );
    expect(mainSource).not.toContain("prepareCaptureForQuit");
  });

  it("routes termination signals through the bounded non-interactive intent", () => {
    expect(mainSource.match(/requestNonInteractive\(\)/g)).toHaveLength(2);
    expect(mainSource).not.toMatch(
      /process\.once\("SIG(?:TERM|INT)", \(\) => app\.quit\(\)\)/,
    );
  });

  it("quits the macOS development app when its main window closes", () => {
    expect(mainSource).toMatch(
      /window\.on\("closed"[\s\S]*process\.platform !== "darwin" \|\| MAIN_WINDOW_VITE_DEV_SERVER_URL[\s\S]*app\.quit\(\)/,
    );
  });

  it("exits instead of leaving a blank development window when loading fails", () => {
    expect(mainSource).toMatch(
      /window\s*\.loadURL\(MAIN_WINDOW_VITE_DEV_SERVER_URL\)[\s\S]*catch\(\(error: unknown\)[\s\S]*Voice2Text development renderer failed to load[\s\S]*app\.exit\(1\)/,
    );
  });

  it("reopens transport-equivalent capture sessions and tears down the current one", () => {
    expect(mainSource).toContain(
      "captureNativePort = new MacOSCaptureNativePort(\n    captureNativeSession,\n    openCaptureSession",
    );
    expect(mainSource).toContain(
      "abortCapture: () => captureNativePort?.abort()",
    );
    expect(mainSource).toContain(
      "captureNativePort?.currentSession() ?? captureNativeSession",
    );
    expect(mainSource).toContain("await captureNativePort?.close()");
  });

  it("suppresses publication and polling before bounded recovery teardown", () => {
    expect(mainSource).toMatch(
      /suppressCapturePublications: suppressCapturePublications,[\s\S]*abortCapture: \(\) => captureNativePort\?\.abort\(\)/,
    );
    expect(mainSource).toContain("teardownOwnedResources(mode)");
    expect(mainSource).toContain("await captureRecoveryMutation");
    expect(mainSource).toContain(
      'if (mode === "normal") await captureControlMutation',
    );
    expect(mainSource).toContain("exit: () => app.exit(0)");
  });

  it("serializes recovery mutations with capture control and fences teardown", () => {
    expect(mainSource).toMatch(
      /actOnCaptureRecovery: async \(options\)[\s\S]*Promise\.all\(\[\s*captureControlMutation,\s*captureRecoveryMutation,[\s\S]*captureControlMutation = captureRecoveryMutation/,
    );
    expect(mainSource).toContain(
      'throw new Error("capture recovery is unavailable during teardown")',
    );
  });

  it("waits for recovery cleanup before starting on the native capture session", () => {
    expect(mainSource).toMatch(
      /async function startCapture[\s\S]*const operation = Promise\.all\(\[\s*captureControlMutation,\s*captureRecoveryMutation,\s*\]\)\.then\(async \(\) => await performCaptureStart\(options\)\)[\s\S]*captureControlMutation = operation\.then/,
    );
    expect(mainSource).toMatch(
      /async function performCaptureStart[\s\S]*await service\.start\(/,
    );
  });

  it("shows quit decisions on a visible Main window", () => {
    expect(mainSource).toMatch(
      /activate: \(\) => \{\s*showMainWindow\(\);\s*app\.focus\(\{ steal: true \}\);\s*\}/,
    );
    expect(mainSource).toMatch(
      /dialogParent: \(\) =>\s*mainWindow && !mainWindow\.isDestroyed\(\) && mainWindow\.isVisible\(\)/,
    );
  });

  it("uses the same single-flight stop transaction for Renderer stop and quit", () => {
    expect(mainSource).toMatch(
      /function runCaptureStopTransaction[\s\S]*captureStopTransaction\?\.sessionId === options\.sessionId[\s\S]*captureStopTransaction\.promise/,
    );
    expect(
      mainSource.match(/runCaptureStopTransaction\(options\)/g),
    ).toHaveLength(2);
  });

  it("offers no post-stop technical retry or recovery decision", () => {
    expect(mainSource).not.toMatch(
      /"live-failure"|"recovered-failure"|"unknown-failure"/,
    );
    expect(mainSource).not.toContain("captureControlsDisabled");
    expect(mainSource).toContain("returnToCapture: () =>");
  });

  it("resolves secret operations against the recreated helper session", () => {
    expect(mainSource).toMatch(
      /new MacOSHelperSecretStore\(\(\) => \{[\s\S]*captureNativePort\?\.currentSession\(\)/,
    );
  });
});
