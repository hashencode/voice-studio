import { rm } from "node:fs/promises";

import type { ExecutionIntent } from "../domain/models";
import type { ResolvedResourceCommand } from "../resources/resource_catalog";
import { OwnedProcessSupervisor } from "./owned_process_supervisor";
import type { WorkerFrame } from "../../shared/contracts";

export { ProcessCanceledError } from "./owned_process_supervisor";

export interface DurableProcessAuthority {
  requestCancellation(jobId: number): Promise<ExecutionIntent | null>;
  completeCancellation(intent: ExecutionIntent): Promise<unknown>;
  publishResult(
    intent: ExecutionIntent,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
  recordProgress?(
    intent: ExecutionIntent,
    progress: Extract<WorkerFrame, { type: "progress" }>,
  ): Promise<unknown>;
}

export interface DurableProcessRun {
  intent: ExecutionIntent;
  command: ResolvedResourceCommand;
  attemptOutputDirectory: string;
  inputFrame?: Record<string, unknown>;
  frameAdapter?: (
    frame: unknown,
    intent: ExecutionIntent,
  ) => Record<string, unknown>;
}

export class DurableProcessCoordinator {
  private readonly attempts = new Map<
    number,
    { intent: ExecutionIntent; outputDirectory: string }
  >();

  constructor(
    private readonly supervisor: OwnedProcessSupervisor,
    private readonly authority: DurableProcessAuthority,
  ) {}

  async run(run: DurableProcessRun): Promise<Record<string, unknown>> {
    const payload = await this.runPhase(run);
    await this.authority.publishResult(run.intent, payload);
    return payload;
  }

  async runPhase(run: DurableProcessRun): Promise<Record<string, unknown>> {
    this.attempts.set(run.intent.jobId, {
      intent: run.intent,
      outputDirectory: run.attemptOutputDirectory,
    });
    try {
      return await this.supervisor.run({
        ...run,
        onProgress: async (progress) => {
          await this.authority.recordProgress?.(run.intent, progress);
        },
      });
    } finally {
      this.attempts.delete(run.intent.jobId);
    }
  }

  async cancel(jobId: number): Promise<boolean> {
    const intent = await this.authority.requestCancellation(jobId);
    if (!intent) return false;
    const attempt = this.attempts.get(jobId);
    if (attempt) {
      await this.supervisor.terminate(intent);
      await rm(attempt.outputDirectory, { force: true, recursive: true });
    }
    await this.authority.completeCancellation(intent);
    return true;
  }

  async shutdown(): Promise<void> {
    await this.supervisor.shutdown();
  }
}
