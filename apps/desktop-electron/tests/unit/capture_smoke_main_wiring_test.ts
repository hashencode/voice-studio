import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

it("routes every packaged smoke through its isolated appData and fails blocked profiles fast", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../../src/main/index.ts"),
    "utf8",
  );
  expect(source).toContain('smokeAppDataPath ?? app.getPath("appData")');
  expect(source).toMatch(
    /if \(\s*processingSmokeRequest \|\|\s*captureSmokeRequest \|\|\s*captionFormalSmokeRequest\s*\)/,
  );
});
