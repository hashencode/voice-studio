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
    expect(mainSource).toContain(
      'if (mode === "normal") await captureControlMutation',
    );
    expect(mainSource).toContain("exit: () => app.exit(0)");
  });
});
