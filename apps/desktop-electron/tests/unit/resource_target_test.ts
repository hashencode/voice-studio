import { describe, expect, it } from "vitest";

import {
  assertMacOSArm64ResourceHost,
  macOSArm64ResourceTarget,
} from "../../scripts/resource_target";

describe("worker resource target", () => {
  it("accepts only the frozen macOS arm64 build host", () => {
    expect(assertMacOSArm64ResourceHost("darwin", "arm64")).toBe(
      macOSArm64ResourceTarget,
    );
    expect(() => assertMacOSArm64ResourceHost("darwin", "x64")).toThrow(
      /darwin-arm64/i,
    );
    expect(() => assertMacOSArm64ResourceHost("linux", "arm64")).toThrow(
      /darwin-arm64/i,
    );
  });
});
