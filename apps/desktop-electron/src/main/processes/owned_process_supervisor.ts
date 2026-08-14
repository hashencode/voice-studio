import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ExecutionIntent } from "../domain/models";
import {
  assertAuthorizedResourceCommand,
  type ResolvedResourceCommand,
} from "../resources/resource_catalog";
import { workerFrameSchema, type WorkerFrame } from "../../shared/contracts";

export class ProcessCanceledError extends Error {
  constructor() {
    super("owned process was canceled");
    this.name = "ProcessCanceledError";
  }
}

export class ProcessDeadlineError extends Error {
  constructor() {
    super("owned process deadline was exceeded");
    this.name = "ProcessDeadlineError";
  }
}

export class WorkerReportedError extends Error {
  constructor(readonly code: string) {
    super(`worker failed with ${code}`);
    this.name = "WorkerReportedError";
  }
}

export interface OwnedProcessRun {
  intent: ExecutionIntent;
  command: ResolvedResourceCommand;
  attemptOutputDirectory: string;
  inputFrame?: Record<string, unknown>;
  onProgress?: (
    frame: Extract<WorkerFrame, { type: "progress" }>,
  ) => void | Promise<void>;
  frameAdapter?: (
    frame: unknown,
    intent: ExecutionIntent,
  ) => Record<string, unknown>;
}

export interface OwnedProcessSupervisorOptions {
  workspaceRoot: string;
  maximumOutputBytes?: number;
  maximumFrameBytes?: number;
  maximumStderrBytes?: number;
  terminationGraceMs?: number;
  onTerminate?: (owned: OwnedProcessRun) => void;
}

interface ActiveProcess {
  run: OwnedProcessRun;
  child: ChildProcessWithoutNullStreams;
  cancellationRequested: boolean;
  termination: Promise<void> | null;
}

export class OwnedProcessSupervisor {
  private readonly active = new Map<number, ActiveProcess>();
  private shutdownPromise: Promise<void> | null = null;
  private readonly maximumOutputBytes: number;
  private readonly maximumFrameBytes: number;
  private readonly maximumStderrBytes: number;
  private readonly terminationGraceMs: number;

  constructor(private readonly options: OwnedProcessSupervisorOptions) {
    this.maximumOutputBytes = options.maximumOutputBytes ?? 32 * 1024 * 1024;
    this.maximumFrameBytes = options.maximumFrameBytes ?? 1024 * 1024;
    this.maximumStderrBytes = options.maximumStderrBytes ?? 256 * 1024;
    this.terminationGraceMs = options.terminationGraceMs ?? 500;
  }

  async run(run: OwnedProcessRun): Promise<Record<string, unknown>> {
    if (this.shutdownPromise)
      throw new Error("process supervisor is shutting down");
    if (this.active.has(run.intent.jobId)) {
      throw new Error("processing job already owns a process");
    }
    validateIntent(run.intent, run.command);
    await assertAuthorizedResourceCommand(run.command);
    await assertAttemptDirectory(
      this.options.workspaceRoot,
      run.attemptOutputDirectory,
    );
    validateCommandArguments(run.command, run.attemptOutputDirectory);

    const child = spawn(run.command.executable, [...run.command.args], {
      cwd: run.attemptOutputDirectory,
      detached: process.platform !== "win32",
      env: minimalProcessEnvironment(run.attemptOutputDirectory),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const owned: ActiveProcess = {
      run,
      child,
      cancellationRequested: false,
      termination: null,
    };
    this.active.set(run.intent.jobId, owned);

    try {
      return await this.collectResult(owned);
    } finally {
      this.active.delete(run.intent.jobId);
    }
  }

  async terminate(intent: ExecutionIntent): Promise<boolean> {
    const owned = this.active.get(intent.jobId);
    if (!owned) return false;
    assertSameAttempt(owned.run.intent, intent);
    owned.cancellationRequested = true;
    await this.terminateOwned(owned);
    return true;
  }

  async shutdown(): Promise<void> {
    this.shutdownPromise ??= Promise.all(
      [...this.active.values()].map(async (owned) => {
        owned.cancellationRequested = true;
        await this.terminateOwned(owned);
      }),
    ).then(() => undefined);
    await this.shutdownPromise;
  }

  private async collectResult(
    owned: ActiveProcess,
  ): Promise<Record<string, unknown>> {
    const { child, run } = owned;
    return await new Promise((resolve, reject) => {
      let stdout = Buffer.alloc(0);
      let totalOutputBytes = 0;
      let stderr = Buffer.alloc(0);
      let terminalPayload: Record<string, unknown> | null = null;
      let failure: Error | null = null;
      let settled = false;
      let progressWork: Promise<void> = Promise.resolve();

      const settle = (
        error: Error | null,
        payload?: Record<string, unknown>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve(payload ?? {});
      };
      const failAndTerminate = (error: Error) => {
        failure ??= error;
        void this.terminateOwned(owned).catch((terminationError: unknown) => {
          failure ??= new Error("owned process termination failed", {
            cause: terminationError,
          });
        });
      };
      const parseLine = (line: Buffer) => {
        if (line.byteLength > this.maximumFrameBytes) {
          failAndTerminate(
            new Error("worker protocol frame exceeded the byte limit"),
          );
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(line.toString("utf8"));
        } catch (error) {
          failAndTerminate(
            new Error("worker emitted invalid JSON", { cause: error }),
          );
          return;
        }
        let adapted: unknown = decoded;
        try {
          adapted = run.frameAdapter
            ? run.frameAdapter(decoded, run.intent)
            : decoded;
        } catch (error) {
          failAndTerminate(
            new Error("worker frame adapter rejected output", { cause: error }),
          );
          return;
        }
        const parsed = workerFrameSchema.safeParse(adapted);
        if (!parsed.success) {
          failAndTerminate(
            new Error("worker emitted an invalid protocol frame", {
              cause: parsed.error,
            }),
          );
          return;
        }
        const frame = parsed.data;
        if (
          frame.operationId !== run.intent.operationId ||
          frame.attempt !== run.intent.attempt ||
          frame.sourceIdentity !== run.intent.sourceIdentity ||
          frame.phase !== run.intent.phase ||
          frame.protocolIdentity !== run.intent.protocolIdentity ||
          frame.sourceSha256 !== run.intent.sourceSha256 ||
          frame.modelSha256 !== run.intent.modelSha256 ||
          frame.runtimeSha256 !== run.intent.runtimeSha256
        ) {
          failAndTerminate(
            new Error("worker frame failed the attempt/source fence"),
          );
          return;
        }
        if (owned.cancellationRequested || failure) return;
        if (frame.type === "progress" && run.onProgress) {
          progressWork = progressWork
            .then(async () => {
              if (owned.cancellationRequested || failure) return;
              await run.onProgress?.(frame);
            })
            .catch((error: unknown) => {
              const progressFailure = new Error(
                "worker progress callback failed",
                { cause: error },
              );
              failAndTerminate(progressFailure);
              throw progressFailure;
            });
          void progressWork.catch(() => undefined);
        }
        if (frame.type === "error") {
          failAndTerminate(new WorkerReportedError(frame.code));
        }
        if (frame.type === "result") {
          if (terminalPayload) {
            failAndTerminate(
              new Error("worker emitted more than one result frame"),
            );
          } else {
            terminalPayload = frame.payload;
          }
        }
      };
      const deadlineDelay = Math.max(0, run.intent.deadlineAtMs - Date.now());
      const deadline = setTimeout(() => {
        failure = new ProcessDeadlineError();
        void this.terminateOwned(owned).catch((terminationError: unknown) => {
          failure ??= new Error("owned process termination failed", {
            cause: terminationError,
          });
        });
      }, deadlineDelay);

      child.once("error", (error) => {
        failure = error;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        totalOutputBytes += chunk.byteLength;
        if (totalOutputBytes > this.maximumOutputBytes) {
          failAndTerminate(new Error("worker output exceeded the byte limit"));
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
        let newline = stdout.indexOf(0x0a);
        while (newline >= 0) {
          const line = stdout.subarray(0, newline);
          stdout = stdout.subarray(newline + 1);
          if (line.byteLength > 0) parseLine(line);
          newline = stdout.indexOf(0x0a);
        }
        if (stdout.byteLength > this.maximumFrameBytes) {
          failAndTerminate(
            new Error("worker protocol frame exceeded the byte limit"),
          );
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.byteLength >= this.maximumStderrBytes) return;
        stderr = Buffer.concat([
          stderr,
          chunk.subarray(0, this.maximumStderrBytes - stderr.byteLength),
        ]);
      });
      const finishAfterClose = (code: number | null) => {
        if (owned.cancellationRequested) {
          settle(new ProcessCanceledError());
          return;
        }
        if (failure) {
          settle(failure);
          return;
        }
        if (stdout.byteLength > 0) {
          settle(
            new Error("worker closed with an unterminated protocol frame"),
          );
          return;
        }
        if (code !== 0) {
          settle(
            new Error(
              `worker exited with ${String(code)}: ${stderr.toString("utf8").trim()}`,
            ),
          );
          return;
        }
        if (!terminalPayload) {
          settle(new Error("worker exited without a result frame"));
          return;
        }
        settle(null, terminalPayload);
      };
      child.once("close", (code) => {
        void (async () => {
          try {
            await progressWork;
          } catch (error) {
            failure ??= new Error("worker progress callback failed", {
              cause: error,
            });
          }
          try {
            await owned.termination;
          } catch (error) {
            failure ??= new Error("owned process termination failed", {
              cause: error,
            });
          }
          finishAfterClose(code);
        })();
      });

      child.stdin.end(
        run.inputFrame ? `${JSON.stringify(run.inputFrame)}\n` : undefined,
      );
    });
  }

  private async terminateOwned(owned: ActiveProcess): Promise<void> {
    owned.termination ??= this.performTermination(owned);
    await owned.termination;
  }

  private async performTermination(owned: ActiveProcess): Promise<void> {
    this.options.onTerminate?.(owned.run);
    const { child } = owned;
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      child.kill("SIGTERM");
      await waitForExit(child, this.terminationGraceMs);
      if (child.exitCode === null) child.kill("SIGKILL");
      await waitForExit(child, 2000);
      return;
    }
    signalGroup(child.pid, "SIGTERM");
    if (await waitForGroupGone(child.pid, this.terminationGraceMs)) return;
    signalGroup(child.pid, "SIGKILL");
    if (!(await waitForGroupGone(child.pid, 2000))) {
      throw new Error("owned process group survived SIGKILL");
    }
  }
}

function validateCommandArguments(
  command: ResolvedResourceCommand,
  attemptOutputDirectory: string,
): void {
  for (const argument of command.args) {
    if (argument.includes("\0")) {
      throw new Error("resource command contains an invalid argument");
    }
    if (!path.isAbsolute(argument)) continue;
    const candidate = path.resolve(argument);
    if (
      !isPathAtOrInside(command.resourceRoot, candidate) &&
      !isPathAtOrInside(attemptOutputDirectory, candidate)
    ) {
      throw new Error("resource command argument escapes authorized roots");
    }
  }
}

function isPathAtOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative.length === 0 ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateIntent(
  intent: ExecutionIntent,
  command: ResolvedResourceCommand,
): void {
  if (
    !Number.isSafeInteger(intent.jobId) ||
    intent.jobId <= 0 ||
    !Number.isSafeInteger(intent.attempt) ||
    intent.attempt <= 0 ||
    intent.deadlineAtMs <= Date.now() ||
    intent.operationId !== command.operation ||
    intent.resourceIdentity !== command.catalogIdentity ||
    intent.sourceIdentity.trim().length === 0
  ) {
    throw new Error(
      "execution intent does not authorize this resource command",
    );
  }
}

function assertSameAttempt(
  owned: ExecutionIntent,
  requested: ExecutionIntent,
): void {
  if (
    owned.jobId !== requested.jobId ||
    owned.operationId !== requested.operationId ||
    owned.attempt !== requested.attempt ||
    owned.sourceIdentity !== requested.sourceIdentity ||
    owned.deadlineAtMs !== requested.deadlineAtMs ||
    owned.resourceIdentity !== requested.resourceIdentity
  ) {
    throw new Error("termination request failed the attempt/source fence");
  }
}

async function assertAttemptDirectory(
  workspaceRoot: string,
  attemptDirectory: string,
): Promise<void> {
  const canonicalRoot = await realpath(path.resolve(workspaceRoot));
  const canonicalAttempt = await realpath(path.resolve(attemptDirectory));
  const relative = path.relative(canonicalRoot, canonicalAttempt);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("attempt output directory is outside the workspace root");
  }
}

function minimalProcessEnvironment(attemptOutput: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries({
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: process.env.TMPDIR,
      VOICE2TEXT_ATTEMPT_OUTPUT: attemptOutput,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForGroupGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Supervised workers keep our uid. EPERM therefore means this numeric
      // process-group id no longer identifies a group we own (macOS can retain
      // or reuse the id briefly after the leader exits).
      if (code === "ESRCH" || code === "EPERM") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
