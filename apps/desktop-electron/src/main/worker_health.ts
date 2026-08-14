import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  desktopProtocolVersion,
  workerHealthResponseSchema,
  type WorkerHealthResponse,
} from "../shared/contracts";
import type { WorkerResources } from "./resource_locator";

const maximumOutputBytes = 64 * 1024;
const healthDeadlineMs = 10_000;

interface WorkerHealthFrame {
  schemaVersion: number;
  type: string;
  operation: string;
  protocol: string;
  runtime: string;
}

export class WorkerHealthSupervisor {
  private readonly active = new Set<ChildProcessWithoutNullStreams>();

  constructor(private readonly resources: WorkerResources) {}

  async check(): Promise<WorkerHealthResponse> {
    const workerSha256 = await sha256File(this.resources.workerPath);
    const child = spawn(
      this.resources.workerPath,
      ["--phase", "health", "--runtime-root", this.resources.runtimeRoot],
      {
        detached: process.platform !== "win32",
        env: minimalWorkerEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.active.add(child);

    try {
      const frame = await readHealthFrame(child);
      return workerHealthResponseSchema.parse({
        protocolVersion: frame.schemaVersion,
        protocol: frame.protocol,
        runtime: frame.runtime,
        workerSha256,
      });
    } finally {
      this.active.delete(child);
      terminateProcessGroup(child);
    }
  }

  shutdown(): void {
    for (const child of this.active) terminateProcessGroup(child);
    this.active.clear();
  }
}

function minimalWorkerEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR,
  };
}

async function readHealthFrame(
  child: ChildProcessWithoutNullStreams,
): Promise<WorkerHealthFrame> {
  return await new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const finish = (error?: Error, frame?: WorkerHealthFrame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(frame!);
    };
    const append = (current: Buffer, chunk: Buffer) => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > maximumOutputBytes) {
        finish(new Error("worker health output exceeded the byte limit"));
      }
      return next;
    };
    const timer = setTimeout(() => {
      finish(new Error("worker health deadline exceeded"));
      terminateProcessGroup(child);
    }, healthDeadlineMs);

    child.once("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `worker health failed with exit ${String(code)}: ${stderr.toString("utf8").trim()}`,
          ),
        );
        return;
      }
      const lines = stdout.toString("utf8").trim().split("\n");
      if (lines.length !== 1) {
        finish(new Error("worker health emitted an invalid frame count"));
        return;
      }
      try {
        const decoded = JSON.parse(lines[0]!) as WorkerHealthFrame;
        if (
          decoded.schemaVersion !== desktopProtocolVersion ||
          decoded.type !== "result" ||
          decoded.operation !== "health"
        ) {
          throw new Error("worker health frame identity mismatch");
        }
        finish(undefined, decoded);
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("invalid worker health frame"),
        );
      }
    });

    child.stdin.end(
      `${JSON.stringify({
        schemaVersion: desktopProtocolVersion,
        operation: "health",
        expectedProtocolVersion: desktopProtocolVersion,
      })}\n`,
    );
  });
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
