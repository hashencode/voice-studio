import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(
  path.resolve(import.meta.dirname, "../../src/main/index.ts"),
  "utf8",
);

describe("packaged workstation progress evidence wiring", () => {
  it("observes renderer progress from before import and binds it to the imported job", () => {
    const prepare = mainSource.indexOf(
      "await preparePackagedRendererTelemetry()",
    );
    const imported = mainSource.indexOf(
      "const imported = await importAudioFromSource",
    );

    expect(prepare).toBeGreaterThan(-1);
    expect(imported).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(imported);
    expect(mainSource).toContain(
      "observePackagedRendererProgress(imported.jobId)",
    );
    expect(mainSource).toContain("new MutationObserver(observeDomProgress)");
    expect(mainSource).toContain("event.jobId === jobId");
  });

  it("keeps the progress observation window aligned with the packaged run budget", () => {
    expect(mainSource).toContain(
      "const packagedProgressObservationTimeoutMs = 15 * 60 * 1_000",
    );
    expect(mainSource).not.toContain("Date.now() + 120000");
  });
});
