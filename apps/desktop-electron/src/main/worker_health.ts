import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  desktopProtocolVersion,
  workerHealthResponseSchema,
  type WorkerHealthResponse,
} from "../shared/contracts";
import {
  assertAuthorizedResourceCommand,
  type ResolvedResourceCommand,
} from "./resources/resource_catalog";

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
  private readonly terminations = new WeakMap<
    ChildProcessWithoutNullStreams,
    Promise<void>
  >();

  constructor(private readonly command: ResolvedResourceCommand) {}

  async check(): Promise<WorkerHealthResponse> {
    await assertAuthorizedResourceCommand(this.command);
    const workerSha256 = await sha256File(this.command.executable);
    const child = spawn(this.command.executable, [...this.command.args], {
      detached: process.platform !== "win32",
      env: minimalWorkerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      await this.terminateOnce(child);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.active].map(async (child) => this.terminateOnce(child)),
    );
    this.active.clear();
  }

  private terminateOnce(child: ChildProcessWithoutNullStreams): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing) return existing;
    const termination = terminateProcessGroup(child);
    this.terminations.set(child, termination);
    return termination;
  }
}

function minimalWorkerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: process.env.TMPDIR,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
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

async function terminateProcessGroup(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill();
      await waitForChildExit(child, 2000);
      return;
    }
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
    return;
  }
  if (await waitForProcessGroupExit(child.pid, 500)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForProcessGroupExit(child.pid, 2000))) {
    throw new Error("worker health process group survived SIGKILL");
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
