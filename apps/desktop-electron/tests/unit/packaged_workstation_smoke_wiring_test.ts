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
      "observePackagedRendererProgress(imported.jobId, imported.audioId)",
    );
    expect(mainSource).toContain('`[data-audio-id="${audioId}"]`');
    expect(mainSource).toContain('`[data-processing-job-id="${jobId}"]`');
  });

  it("accepts only a running imported job with its own accessible progress node", () => {
    expect(mainSource).toContain("event.jobId === jobId");
    expect(mainSource).toContain('event.state === "running"');
    expect(mainSource).toContain(
      'progress?.getAttribute("role") === "progressbar"',
    );
    expect(mainSource).toContain(
      'Number(progress?.getAttribute("aria-valuemax"))',
    );
    expect(mainSource).toContain("progressMax === 1");
    expect(mainSource).toContain("progressValue < 1");
  });

  it("drives icon-only edit history controls through their accessible names", () => {
    expect(mainSource).toContain(
      'button.getAttribute("aria-label") === "撤销" && !button.disabled',
    );
    expect(mainSource).toContain(
      'button.getAttribute("aria-label") === "重做" && !button.disabled',
    );
    expect(mainSource).not.toContain(
      'button.textContent?.includes("撤销") && !button.disabled',
    );
    expect(mainSource).not.toContain(
      'button.textContent?.includes("重做") && !button.disabled',
    );
  });
});
