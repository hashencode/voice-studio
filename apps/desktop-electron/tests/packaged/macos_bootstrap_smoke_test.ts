import { describe, expect, it } from "vitest";

import { runPackagedMacosSmoke } from "../../scripts/smoke-packaged-macos";

const packagedIt = process.env.RUN_PACKAGED_SMOKE === "1" ? it : it.skip;

describe("packaged macOS bootstrap", () => {
  packagedIt(
    "loads static assets and launches the packaged worker",
    async () => {
      const receipt = await runPackagedMacosSmoke();

      expect(receipt.arch).toBe(process.arch);
      expect(receipt.electron).toMatch(/^\d+\.\d+\.\d+$/);
      expect(receipt.worker.protocol).toBe("desktop-sherpa-worker-health/v1");
      expect(receipt.worker.workerSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.appSha256).toMatch(/^[a-f0-9]{64}$/);
    },
  );
});
