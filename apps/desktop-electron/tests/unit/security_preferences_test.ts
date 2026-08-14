import { describe, expect, it } from "vitest";

import { secureWebPreferences } from "../../src/main/security";

describe("secureWebPreferences", () => {
  it("keeps the renderer sandboxed and isolated", () => {
    expect(secureWebPreferences("/tmp/preload.js")).toEqual(
      expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      }),
    );
  });

  it("uses only the provided preload entry", () => {
    expect(secureWebPreferences("/tmp/preload.js").preload).toBe(
      "/tmp/preload.js",
    );
  });
});
