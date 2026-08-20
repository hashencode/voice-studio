import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

it("routes every packaged smoke through its isolated appData and fails blocked profiles fast", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../../src/main/index.ts"),
    "utf8",
  );
  const bootstrapSource = readFileSync(
    path.resolve(import.meta.dirname, "../../scripts/smoke-packaged-macos.ts"),
    "utf8",
  );
  expect(source).toContain('smokeAppDataPath ?? app.getPath("appData")');
  expect(source).toContain("bootstrapSmokeRequest?.appDataPath");
  expect(bootstrapSource).toContain(
    "VOICE2TEXT_BOOTSTRAP_SMOKE_APP_DATA: appDataPath",
  );
  expect(bootstrapSource).toContain(
    'const evidencePath = path.join(processTemporaryPath, "evidence")',
  );
  expect(bootstrapSource).toContain(
    "await mkdir(evidencePath, { mode: 0o700 })",
  );
  expect(source).toMatch(
    /if \(\s*bootstrapSmokeRequest \|\|\s*processingSmokeRequest \|\|\s*captureSmokeRequest \|\|\s*captionFormalSmokeRequest \|\|\s*aiBoundarySmokeRequest \|\|\s*companionSmokeRequest\s*\)/,
  );
});

it("ends capture smoke phases with their intended cleanup semantics", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../../src/main/index.ts"),
    "utf8",
  );
  expect(source).toContain("await exitInitializedCaptureSmoke(85)");
  expect(source).toMatch(/await exitInitializedCaptureSmoke\(85\);\s*return;/);
  expect(source).toContain("teardownPromise ??= teardownOwnedResources()");
  expect(source).toContain("mainWindow?.destroy()");
  expect(source).toContain("hardExitCaptureSmoke(86)");
  expect(source).toContain("reallyExit?: (code: number) => never");
  expect(source).toContain(
    'throw new Error("capture smoke hard-exit primitive is unavailable")',
  );
  expect(source).not.toContain("process.exit(86)");
  expect(source).not.toContain("app.exit(85)");
  expect(source).not.toContain("app.exit(86)");
});
