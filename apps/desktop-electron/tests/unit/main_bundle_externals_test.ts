import { describe, expect, it } from "vitest";

import { externalMainDependencies } from "../../vite.main.config.mts";

function isExternal(id: string): boolean {
  return externalMainDependencies.some((entry) =>
    typeof entry === "string" ? entry === id : entry.test(id),
  );
}

describe("Electron Main bundle externals", () => {
  it("keeps Electron and every node: builtin on the packaged runtime boundary", () => {
    expect(isExternal("electron")).toBe(true);
    expect(isExternal("node:fs")).toBe(true);
    expect(isExternal("node:sqlite")).toBe(true);
    expect(isExternal("zod")).toBe(false);
  });
});
