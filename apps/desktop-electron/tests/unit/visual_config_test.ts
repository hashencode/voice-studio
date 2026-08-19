import { describe, expect, it } from "vitest";

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
});
