import { describe, expect, it, vi } from "vitest";

import { prepareProcessingAttempt } from "../../src/main/processes/processing_attempt";
import { DurableProcessCoordinator } from "../../src/main/processes/durable_process_coordinator";
import type { OwnedProcessSupervisor } from "../../src/main/processes/owned_process_supervisor";
import type { ResolvedResourceCommand } from "../../src/main/resources/resource_catalog";
import type { ExecutionIntent } from "../../src/main/domain/models";

const intent: ExecutionIntent = {
  jobId: 7,
  audioId: 3,
  operationId: "asr",
  attempt: 1,
  sourceIdentity: "worker-test",
  deadlineAtMs: 10_000,
  resourceIdentity: "resource",
  phase: "asr",
  protocolIdentity: "protocol",
  sourceSha256: "a".repeat(64),
  modelSha256: "b".repeat(64),
  runtimeSha256: "c".repeat(64),
};

describe("processing attempt preparation", () => {
  it("durably interrupts a claimed job when its private directory cannot be created", async () => {
    const failure = new Error("mkdir denied");
    const interrupt = vi.fn(() => true);
    const emitInterrupted = vi.fn();

    expect(
      prepareProcessingAttempt({
        intent,
        attemptDirectory: "/not-created",
        mkdir: () => {
          throw failure;
        },
        interrupt,
        emitInterrupted,
      }),
    ).toBe(false);
    expect(interrupt).toHaveBeenCalledWith(intent, "PROCESS_INTERRUPTED");
    expect(emitInterrupted).toHaveBeenCalledOnce();
  });

  it("keeps intermediate phase output ephemeral until final publication", async () => {
    const publishResult = vi.fn();
    const run = vi.fn(async () => ({ text: "asr-intermediate" }));
    const coordinator = new DurableProcessCoordinator(
      { run, shutdown: vi.fn() } as unknown as OwnedProcessSupervisor,
      {
        requestCancellation: async () => null,
        completeCancellation: async () => undefined,
        publishResult,
      },
    );
    const command = {
      operation: "asr",
    } as unknown as ResolvedResourceCommand;

    await expect(
      coordinator.runPhase({
        intent,
        command,
        attemptOutputDirectory: "/private/attempt",
      }),
    ).resolves.toEqual({ text: "asr-intermediate" });
    expect(publishResult).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });
});
