import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMacOSNativeHelper } from "../../src/main/features/importing/helper_locator";

describe("macOS native helper locator", () => {
  it("resolves the development helper within the supplied worktree", () => {
    const appRoot = path.join(
      path.parse(process.cwd()).root,
      "worktrees",
      "active-checkout",
      "apps",
      "desktop-electron",
    );

    const resolved = resolveMacOSNativeHelper({
      appRoot,
      packaged: false,
      resourcesPath: "/ignored/packaged/resources",
    });

    expect(resolved).toBe(
      path.join(
        appRoot,
        "..",
        "..",
        "packages",
        "desktop_macos_native",
        ".build",
        "debug",
        "desktop_macos_native_helper",
      ),
    );
  });
});
