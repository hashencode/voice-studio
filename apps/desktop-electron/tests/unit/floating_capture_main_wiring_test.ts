import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/main/index.ts"),
  "utf8",
);

describe("floating capture Main wiring", () => {
  it("delegates floating lifecycle state and application projection to the controller", () => {
    expect(mainSource).toContain(
      'import { FloatingCaptureWindowController } from "./features/capture/floating_capture_window_controller"',
    );
    expect(mainSource).toMatch(
      /let floatingCaptureController: FloatingCaptureWindowController<BrowserWindow> \| null =\s*null/,
    );
    expect(mainSource).toMatch(
      /subscribeSnapshot: \(listener\) =>\s*applicationState\.subscribe\(\(snapshot\) =>\s*listener\(deriveFloatingCaptureSnapshot\(snapshot\)\)/,
    );
    expect(mainSource).not.toContain("let floatingCaptureWindow:");
    expect(mainSource).not.toContain("let floatingCaptureEnabled =");
    expect(mainSource).not.toContain("floatingSuppressedSessionId");
    expect(mainSource).not.toContain("floatingLoadFailedSessionId");
    expect(mainSource).not.toContain("lastFloatingCapturePresentation");
    expect(mainSource).not.toContain("floatingPresentedSessionId");
    expect(mainSource).not.toContain("floatingPreferenceMutation");
    expect(mainSource).not.toContain(
      "function reconcileFloatingCapturePresentation",
    );
    expect(mainSource).not.toContain("function handleFloatingWindowAction");
  });

  it("keeps BrowserWindow security and IPC authority in Main", () => {
    expect(mainSource).toMatch(
      /createWindow: \(\) => createFloatingCaptureWindowRegistration\(\)/,
    );
    expect(mainSource).toMatch(
      /function createFloatingCaptureWindowRegistration[\s\S]*secureWebPreferences\([\s\S]*floating-preload\.js[\s\S]*setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)[\s\S]*will-navigate/,
    );
    expect(mainSource).toMatch(
      /registerWindow: \(window\) => registerFloatingCaptureIpc\(window\)/,
    );
    expect(mainSource).toMatch(
      /registerAdditionalDesktopIpcWindow\(window, \{\s*capability: "floating-capture",[\s\S]*(?:origins|fileUrls): new Set/,
    );
  });

  it("delegates Main focus, visibility, and display changes without changing presentation policy", () => {
    expect(mainSource).toMatch(
      /window\.on\("focus", \(\) => floatingCaptureController\?\.hideWindow\(\)\)/,
    );
    for (const eventName of ["blur", "minimize", "hide"]) {
      expect(mainSource).toMatch(
        new RegExp(
          `window\\.on\\("${eventName}", \\(\\) => floatingCaptureController\\?\\.reconcileCurrent\\(\\)\\)`,
        ),
      );
    }
    expect(mainSource).toMatch(
      /subscribeDisplayChanges: \(listener\) => \{[\s\S]*screen\.on\("display-removed", listener\)[\s\S]*screen\.on\("display-metrics-changed", listener\)[\s\S]*screen\.off\("display-removed", listener\)[\s\S]*screen\.off\("display-metrics-changed", listener\)/,
    );
  });

  it("delegates IPC services while retaining stop and details handoff in Main", () => {
    expect(mainSource).toMatch(
      /floatingCaptureSnapshot: \(\) =>\s*deriveFloatingCaptureSnapshot\(applicationState\.snapshot\(\)\)/,
    );
    expect(mainSource).toMatch(
      /controlFloatingCapture: async \(options\)[\s\S]*runFloatingCaptureControl\(options,[\s\S]*handoffToMain: \(\) => \{\s*floatingCaptureController\?\.hideWindow\(\);\s*showMainWindow\(\{ openCaptureDetails: true \}\)/,
    );
    expect(mainSource).toContain(
      "floatingCaptureWindowAction: (action) =>\n      requireFloatingCaptureController().handleWindowAction(action)",
    );
    expect(mainSource).toContain(
      "getFloatingCapturePreference: () =>\n      requireFloatingCaptureController().getPreference()",
    );
    expect(mainSource).toContain(
      "setFloatingCapturePreference: (enabled) =>\n      requireFloatingCaptureController().setPreference(enabled)",
    );
    expect(mainSource).toContain(
      "onFloatingCaptureSnapshot: (listener) =>\n      requireFloatingCaptureController().onSnapshot(listener)",
    );
  });

  it("rebinds only after the replacement Main registry is installed", () => {
    const registration = mainSource.indexOf(
      "unregisterIpc = registerDesktopIpc(window, services,",
    );
    const rebind = mainSource.indexOf(
      "floatingCaptureController?.rebindIpc()",
      registration,
    );
    expect(registration).toBeGreaterThan(-1);
    expect(rebind).toBeGreaterThan(registration);
    expect(mainSource.slice(registration, rebind)).not.toContain(
      "unregisterIpc?.()",
    );
  });

  it("initializes once after session security and preserves two-phase teardown ordering", () => {
    expect(mainSource).toMatch(
      /configureSessionSecurity\(\);[\s\S]*floatingCaptureController = createFloatingCaptureController\(\);[\s\S]*floatingCaptureController\.initialize\(\);[\s\S]*mainWindow = createMainWindow\(\)/,
    );

    const teardown = mainSource.slice(
      mainSource.indexOf("async function teardownOwnedResources"),
    );
    const fence = teardown.indexOf(
      "await floatingCaptureController?.beginTeardown()",
    );
    const recovery = teardown.indexOf("await captureRecoveryMutation");
    const controls = teardown.indexOf(
      'if (mode === "normal") await captureControlMutation',
    );
    const dispose = teardown.indexOf(
      "await floatingCaptureController?.completeTeardown()",
    );
    const unregister = teardown.indexOf("unregisterIpc?.()");
    expect(fence).toBeGreaterThan(-1);
    expect(fence).toBeLessThan(recovery);
    expect(recovery).toBeLessThan(controls);
    expect(controls).toBeLessThan(dispose);
    expect(dispose).toBeLessThan(unregister);
  });
});
