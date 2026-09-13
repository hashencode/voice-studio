import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "vitest";

const mainSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/main/index.ts"),
  "utf8",
);

it("projects and hands off the repository-backed capture title", () => {
  expect(mainSource).not.toContain("activeCaptureTitle");
  expect(mainSource).toContain(
    "captureService.sessionTitle(snapshot.sessionId)",
  );
  expect(mainSource).toContain("service.sessionTitle(options.sessionId)");
  expect(mainSource).toContain(
    "service.sessionTitle(outcome.capture.sessionId)",
  );
});
