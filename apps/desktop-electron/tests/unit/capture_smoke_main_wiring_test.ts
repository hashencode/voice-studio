import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

const mainSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/main/index.ts"),
  "utf8",
);

it("routes every packaged smoke through its isolated appData and fails blocked profiles fast", () => {
  const bootstrapSource = readFileSync(
    path.resolve(import.meta.dirname, "../../scripts/smoke-packaged-macos.ts"),
    "utf8",
  );
  expect(mainSource).toContain('smokeAppDataPath ?? app.getPath("appData")');
  expect(mainSource).toContain("bootstrapSmokeRequest?.appDataPath");
  expect(bootstrapSource).toContain(
    "VOICE2TEXT_BOOTSTRAP_SMOKE_APP_DATA: appDataPath",
  );
  expect(bootstrapSource).toContain(
    'const evidencePath = path.join(processTemporaryPath, "evidence")',
  );
  expect(bootstrapSource).toContain(
    "await mkdir(evidencePath, { mode: 0o700 })",
  );
  expect(mainSource).toMatch(
    /if \(\s*bootstrapSmokeRequest \|\|\s*processingSmokeRequest \|\|\s*captureSmokeRequest \|\|\s*captionFormalSmokeRequest \|\|\s*aiBoundarySmokeRequest \|\|\s*companionSmokeRequest\s*\)/,
  );
});

it("ends capture smoke phases with their intended cleanup semantics", () => {
  expect(mainSource).toContain("await exitInitializedCaptureSmoke(85)");
  expect(mainSource).toMatch(
    /await exitInitializedCaptureSmoke\(85\);\s*return;/,
  );
  expect(mainSource).toContain("teardownPromise ??= teardownOwnedResources()");
  expect(mainSource).toContain("mainWindow?.destroy()");
  expect(mainSource).toContain("hardExitCaptureSmoke(86)");
  expect(mainSource).toContain("reallyExit?: (code: number) => never");
  expect(mainSource).toContain(
    'throw new Error("capture smoke hard-exit primitive is unavailable")',
  );
  expect(mainSource).not.toContain("process.exit(86)");
  expect(mainSource).not.toContain("app.exit(85)");
  expect(mainSource).not.toContain("app.exit(86)");
});

it("offers an explicit tray quit action through the guarded application lifecycle", () => {
  expect(mainSource).toMatch(
    /label: "退出 Voice2Text",\s*click: \(\) => app\.quit\(\),/,
  );
});
