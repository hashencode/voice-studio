import { describe, expect, it } from "vitest";

import { resolveWorkerResources } from "../../src/main/resource_locator";

describe("resolveWorkerResources", () => {
  it("resolves packaged executables outside app.asar", () => {
    const resources = resolveWorkerResources({
      appRoot: "/Applications/Voice2Text.app/Contents/Resources/app.asar",
      packaged: true,
      resourcesPath: "/Applications/Voice2Text.app/Contents/Resources",
    });

    expect(resources.workerPath).toBe(
      "/Applications/Voice2Text.app/Contents/Resources/worker/bin/desktop_sherpa_worker",
    );
    expect(resources.workerPath).not.toContain("app.asar/");
  });

  it("resolves development resources from the application root", () => {
    const resources = resolveWorkerResources({
      appRoot: "/repo/apps/desktop-electron",
      packaged: false,
      resourcesPath: "/ignored",
    });

    expect(resources.runtimeRoot).toBe(
      "/repo/apps/desktop-electron/resources/worker/runtime",
    );
  });
});
