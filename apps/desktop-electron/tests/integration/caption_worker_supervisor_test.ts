import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CaptionWorkerSupervisor,
  captionWorkerDeadlines,
} from "../../src/main/processes/caption_worker_supervisor";
import { ResourceCatalog } from "../../src/main/resources/resource_catalog";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "darwin" && process.arch === "arm64")(
  "live-caption worker supervisor",
  () => {
    it("freezes distinct production deadlines while preserving explicit test override", () => {
      expect(captionWorkerDeadlines).toEqual({
        readyMs: 30_000,
        openMs: 10_000,
        pollMs: 30_000,
        flushMs: 600_000,
      });
    });
    it("runs the allowlisted private-pipe protocol and flushes completed utterances", async () => {
      const fixture = await workerFixture("normal");
      expect(fixture.identity).toEqual({
        protocolIdentity: "sensevoice-live-caption-worker/v1",
        resourceIdentity: fixture.catalogIdentity,
        modelSha256: fixture.workerReportedModelSha256,
        runtimeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const utterances: string[] = [];
      const worker = await CaptionWorkerSupervisor.launch({
        ...fixture.launch,
        onUtterance: async (event) => {
          utterances.push(event.text);
        },
      });

      await expect(worker.poll()).resolves.toEqual(
        expect.objectContaining({ type: "pollComplete", backlogBytes: 0 }),
      );
      await expect(worker.flush()).resolves.toEqual(
        expect.objectContaining({ type: "sessionComplete" }),
      );
      expect(utterances).toEqual(["完整话语"]);
      await worker.close();
      expect(await processExists(fixture.pidPath)).toBe(false);
    });

    it.each([
      ["oversized" as const, /byte limit/i],
      ["rate" as const, /event rate/i],
      ["crash" as const, /exited/i],
    ])("fails closed for %s worker output", async (mode, message) => {
      const fixture = await workerFixture(mode);
      await expect(
        CaptionWorkerSupervisor.launch({
          ...fixture.launch,
          onUtterance: async () => undefined,
          requestTimeoutMs: 2_000,
        }),
      ).rejects.toThrow(message);
      await waitForNoProcess(fixture.pidPath);
    });

    it("kills the whole owned process group when a request times out", async () => {
      const fixture = await workerFixture("timeout");
      await expect(
        CaptionWorkerSupervisor.launch({
          ...fixture.launch,
          onUtterance: async () => undefined,
          requestTimeoutMs: 75,
        }),
      ).rejects.toThrow(/deadline/i);
      await waitForNoProcess(fixture.pidPath);
      await waitForNoProcess(fixture.childPidPath);
    });

    it.each(["graceful-orphan" as const, "crash-orphan" as const])(
      "reaps descendants when the main worker exits first (%s)",
      async (mode) => {
        const fixture = await workerFixture(mode);
        if (mode === "graceful-orphan") {
          const worker = await CaptionWorkerSupervisor.launch({
            ...fixture.launch,
            onUtterance: async () => undefined,
            requestTimeoutMs: 2_000,
          });
          await worker.close();
        } else {
          await expect(
            CaptionWorkerSupervisor.launch({
              ...fixture.launch,
              onUtterance: async () => undefined,
              requestTimeoutMs: 2_000,
            }),
          ).rejects.toThrow(/exited/i);
        }
        await waitForNoProcess(fixture.childPidPath);
      },
    );
  },
);

async function workerFixture(
  mode:
    | "normal"
    | "oversized"
    | "rate"
    | "crash"
    | "timeout"
    | "graceful-orphan"
    | "crash-orphan",
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "caption-supervisor-")),
  );
  roots.push(root);
  const resourceRoot = path.join(root, "resource");
  const workspaceRoot = path.join(root, "workspace");
  const sessionRoot = path.join(workspaceRoot, "capture-session");
  const executable = path.join(resourceRoot, "fake-caption-worker");
  const modelPath = path.join(resourceRoot, "models", "model.int8.onnx");
  const tokensPath = path.join(resourceRoot, "models", "tokens.txt");
  const runtimePath = path.join(resourceRoot, "runtime", "worker.dylib");
  const pidPath = path.join(root, "worker.pid");
  const childPidPath = path.join(root, "worker-child.pid");
  await mkdir(path.dirname(modelPath), { recursive: true });
  await mkdir(path.dirname(runtimePath), { recursive: true });
  await mkdir(path.join(sessionRoot, "caption"), { recursive: true });
  await writeFile(
    path.join(sessionRoot, "caption", "live-caption.pcmspool"),
    Buffer.alloc(3_200),
  );
  const source = fakeWorkerSource();
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  const executableSha = sha256(Buffer.from(source));
  const modelBytes = Buffer.from("worker-reported-model");
  const tokensBytes = Buffer.from("auxiliary-tokens");
  const runtimeBytes = Buffer.from("caption-runtime");
  await writeFile(modelPath, modelBytes);
  await writeFile(tokensPath, tokensBytes);
  await writeFile(runtimePath, runtimeBytes);
  const workerReportedModelSha256 = sha256(modelBytes);
  const manifest = {
    schemaVersion: 1,
    target: "darwin-arm64",
    workerProtocol: "sensevoice-live-caption-worker/v1",
    artifacts: [
      { path: "fake-caption-worker", sha256: executableSha },
      { path: "models/model.int8.onnx", sha256: workerReportedModelSha256 },
      { path: "models/tokens.txt", sha256: sha256(tokensBytes) },
      { path: "runtime/worker.dylib", sha256: sha256(runtimeBytes) },
    ],
    operations: [
      {
        operation: "live-caption",
        executable: "fake-caption-worker",
        arguments: [
          mode,
          pidPath,
          childPidPath,
          workerReportedModelSha256,
          "--fixture-root={attemptOutput}",
        ],
        protocolIdentity: "sensevoice-live-caption-worker/v1",
        modelArtifacts: ["models/model.int8.onnx", "models/tokens.txt"],
        workerReportedModelArtifact: "models/model.int8.onnx",
        runtimeArtifacts: ["runtime/worker.dylib"],
      },
    ],
  };
  await writeFile(
    path.join(resourceRoot, "manifest.json"),
    JSON.stringify(manifest),
  );
  const catalog = await ResourceCatalog.load(resourceRoot);
  const identity = catalog.processingIdentity("live-caption")!;
  return {
    pidPath,
    childPidPath,
    identity,
    catalogIdentity: catalog.identity,
    workerReportedModelSha256,
    launch: {
      command: catalog.command("live-caption", {
        attemptOutput: sessionRoot,
      }),
      workspaceRoot,
      sessionRoot,
      fence: {
        sessionId: "session-caption-supervisor-123456",
        generationId: 7,
        attempt: 2,
        modelSha256: identity.modelSha256,
      },
      offsetBytes: 0,
      firstSequence: 1,
    },
  };
}

function fakeWorkerSource(): string {
  return `#!${process.execPath}
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const readline = require("node:readline");
const [mode, pidPath, childPidPath, modelSha256] = process.argv.slice(2);
writeFileSync(pidPath, String(process.pid));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
emit({schemaVersion:1,type:"ready",protocol:"sensevoice-live-caption-worker/v1",processId:process.pid,modelLoadMs:1,residentBytes:100,effectiveConfig:{},publishesTokenPartials:false});
readline.createInterface({input:process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "openSession") {
    if (mode === "crash") process.exit(19);
    if (mode === "crash-orphan") {
      const child = spawn("/bin/sleep", ["30"], {stdio:"ignore"});
      writeFileSync(childPidPath, String(child.pid));
      process.exit(19);
    }
    if (mode === "timeout") {
      const child = spawn("/bin/sleep", ["30"], {stdio:"ignore"});
      writeFileSync(childPidPath, String(child.pid));
      return;
    }
    if (mode === "oversized") {
      process.stdout.write("x".repeat(1024 * 1024 + 1));
      return;
    }
    if (mode === "rate") {
      for (let sequence = 1; sequence <= 51; sequence += 1) emit({schemaVersion:1,type:"utterance",sessionId:request.sessionId,generationId:request.generationId,sequence,startSeconds:0,endSeconds:0.05,text:"x",textSha256:createHash("sha256").update("x").digest("hex"),language:"en",event:"",offsetBytes:3200,modelSha256,residentBytes:100});
      return;
    }
    emit({schemaVersion:1,type:"sessionReady",sessionId:request.sessionId,generationId:request.generationId,offsetBytes:request.offsetBytes,nextSequence:request.firstSequence,modelSha256});
    return;
  }
  if (request.type === "poll") {
    const text = "完整话语";
    emit({schemaVersion:1,type:"utterance",sessionId:request.sessionId,generationId:7,sequence:1,startSeconds:0,endSeconds:0.05,text,textSha256:createHash("sha256").update(text).digest("hex"),language:"zh",event:"",offsetBytes:3200,modelSha256,residentBytes:100});
    emit({schemaVersion:1,type:"pollComplete",sessionId:request.sessionId,generationId:7,offsetBytes:3200,nextSequence:2,backlogBytes:0,residentBytes:100});
    return;
  }
  if (request.type === "flush") emit({schemaVersion:1,type:"sessionComplete",sessionId:request.sessionId,generationId:7,offsetBytes:3200,nextSequence:2,backlogBytes:0,residentBytes:100});
  if (request.type === "shutdown") {
    if (mode === "graceful-orphan") {
      const child = spawn("/bin/sleep", ["30"], {stdio:"ignore"});
      writeFileSync(childPidPath, String(child.pid));
    }
    process.exit(0);
  }
});
`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function processExists(pidPath: string): Promise<boolean> {
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForNoProcess(pidPath: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (await processExists(pidPath)) {
    if (Date.now() >= deadline)
      throw new Error("owned process survived cleanup");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
