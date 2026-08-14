import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CaptionWorkerSupervisor } from "../../src/main/processes/caption_worker_supervisor";
import { ResourceCatalog } from "../../src/main/resources/resource_catalog";

const roots: string[] = [];
const packagedLiveCaptionIt =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  process.env.RUN_PACKAGED_LIVE_CAPTION === "1"
    ? it
    : it.skip;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("packaged macOS live-caption worker", () => {
  packagedLiveCaptionIt(
    "loads the bundled catalog and completes ready/open/poll/flush/shutdown",
    async () => {
      const workspaceRoot = realpathSync(
        mkdtempSync(path.join(tmpdir(), "voice2text-caption-worker-smoke-")),
      );
      roots.push(workspaceRoot);
      const sessionRoot = path.join(workspaceRoot, "session-smoke-123456");
      mkdirSync(path.join(sessionRoot, "caption"), {
        recursive: true,
        mode: 0o700,
      });
      const canonicalSessionRoot = realpathSync(sessionRoot);
      writeFileSync(
        path.join(sessionRoot, "caption/live-caption.pcmspool"),
        Buffer.alloc(0),
        { mode: 0o600 },
      );
      const workerRoot = path.resolve(
        "out/Voice2Text-darwin-arm64/Voice2Text.app/Contents/Resources/worker",
      );
      const catalog = await ResourceCatalog.load(workerRoot);
      const identity = catalog.processingIdentity("live-caption");
      if (!identity) {
        throw new Error("packaged live-caption identity is unavailable");
      }
      expect(identity).toMatchObject({
        protocolIdentity: "sensevoice-live-caption-worker/v1",
        resourceIdentity: catalog.identity,
        modelSha256:
          "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
        runtimeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const supervisor = await CaptionWorkerSupervisor.launch({
        command: catalog.command("live-caption", {
          runtimeRoot: path.join(workerRoot, "runtime"),
          attemptOutput: canonicalSessionRoot,
        }),
        workspaceRoot,
        sessionRoot: canonicalSessionRoot,
        fence: {
          sessionId: "session-smoke-123456",
          generationId: 1,
          attempt: 1,
          modelSha256: identity.modelSha256,
        },
        offsetBytes: 0,
        firstSequence: 1,
        onUtterance: () => {
          throw new Error("empty smoke spool emitted an utterance");
        },
        requestTimeoutMs: 30_000,
      });
      try {
        await expect(supervisor.poll()).resolves.toMatchObject({
          type: "pollComplete",
          offsetBytes: 0,
          backlogBytes: 0,
        });
        await expect(supervisor.flush()).resolves.toMatchObject({
          type: "sessionComplete",
          offsetBytes: 0,
          backlogBytes: 0,
        });
      } finally {
        await supervisor.close();
      }
    },
    120_000,
  );
});
