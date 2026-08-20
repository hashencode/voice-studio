import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import config from "../../playwright.config";

describe("visual regression server isolation", () => {
  it("never reuses a Vite server from another checkout", () => {
    const webServer = Array.isArray(config.webServer)
      ? config.webServer[0]
      : config.webServer;

    expect(webServer).toBeDefined();
    expect(webServer?.reuseExistingServer).toBe(false);
    expect(webServer?.command).toContain("--strictPort");
  });

  it("normalizes the Electron harness to CSS pixels exactly once", () => {
    const harnessPath = fileURLToPath(
      new URL("../visual/harness/main.ts", import.meta.url),
    );
    const harnessSource = readFileSync(harnessPath, "utf8");

    const visualSpecPath = fileURLToPath(
      new URL("../visual/renderer-shell.visual.spec.ts", import.meta.url),
    );
    const visualSpecSource = readFileSync(visualSpecPath, "utf8");

    expect(harnessSource).toContain("screen.getPrimaryDisplay().scaleFactor");
    expect(harnessSource).toContain(
      "partition: `voice2text-visual-${process.pid}`",
    );
    expect(visualSpecSource).toContain("setZoomFactor(zoomFactor)");
    expect(visualSpecSource).toContain("1 / nativeDpr");
    expect(visualSpecSource).not.toContain("setDeviceMetricsOverride");
  });
});
