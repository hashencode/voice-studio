import path from "node:path";

import { describe, expect, it } from "vitest";

import floatingRendererConfig from "../../vite.floating-renderer.config.mts";
import mainRendererConfig from "../../vite.renderer.config.mts";

const projectDirectory = path.resolve(import.meta.dirname, "../..");

describe("renderer Vite caches", () => {
  it("uses stable, non-overlapping optimizer caches for each Forge renderer", () => {
    expect(mainRendererConfig).toMatchObject({
      cacheDir: path.join(
        projectDirectory,
        "node_modules",
        ".vite",
        "main_window",
      ),
    });
    expect(floatingRendererConfig).toMatchObject({
      cacheDir: path.join(
        projectDirectory,
        "node_modules",
        ".vite",
        "floating_capture_window",
      ),
    });
    expect(mainRendererConfig.cacheDir).not.toBe(
      floatingRendererConfig.cacheDir,
    );
  });
});
