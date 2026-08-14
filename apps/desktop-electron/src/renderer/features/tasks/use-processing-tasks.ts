import * as React from "react";

import type {
  ApplicationSnapshot,
  OperationEvent,
  ProcessingTask,
} from "@shared/contracts";

export type PendingJobAction = "cancel" | "retry";

type DeltaReceipt = {
  sequence: number;
  event: OperationEvent;
};

type ReconcileOptions = {
  preserveFromSequence?: number;
  allowTerminalResetJobIds?: ReadonlySet<number>;
  queueIfBusy?: boolean;
};

type QueuedReconcile = {
  preserveFromSequence: number;
  allowTerminalResetJobIds: Set<number>;
};

const terminalStates = new Set<ProcessingTask["state"]>([
  "canceled",
  "interrupted",
  "completed",
  "failed",
]);

export function useProcessingTasks(
  acceptSnapshot: (snapshot: ApplicationSnapshot) => void,
  profileReady: boolean,
) {
  const [tasks, setTasks] = React.useState<ProcessingTask[]>([]);
  const [operationError, setOperationError] = React.useState<string | null>(
    null,
  );
  const [importPending, setImportPending] = React.useState(false);
  const [pendingJobActions, setPendingJobActions] = React.useState<
    ReadonlyMap<number, PendingJobAction>
  >(new Map());
  const tasksRef = React.useRef<ProcessingTask[]>([]);
  const pendingRef = React.useRef(new Map<number, PendingJobAction>());
  const importPendingRef = React.useRef(false);
  const mountedRef = React.useRef(false);
  const mountGenerationRef = React.useRef(0);
  const eventSequenceRef = React.useRef(0);
  const latestDeltaRef = React.useRef(new Map<number, DeltaReceipt>());
  const lastEventRef = React.useRef(new Map<number, OperationEvent>());
  const reconcileInFlightRef = React.useRef<Promise<void> | null>(null);
  const queuedReconcileRef = React.useRef<QueuedReconcile | null>(null);
  const reconcileRunnerRef = React.useRef<
    (options?: ReconcileOptions) => Promise<void>
  >(async () => undefined);

  const publishTasks = React.useCallback((next: ProcessingTask[]) => {
    tasksRef.current = next;
    if (mountedRef.current) setTasks(next);
  }, []);

  const requestReconcile = React.useCallback(
    (options: ReconcileOptions = {}): Promise<void> => {
      const preserveFromSequence =
        options.preserveFromSequence ?? eventSequenceRef.current + 1;
      const allowTerminalResetJobIds = new Set(
        options.allowTerminalResetJobIds ?? [],
      );
      const inFlight = reconcileInFlightRef.current;
      if (inFlight) {
        if (options.queueIfBusy !== false) {
          const queued = queuedReconcileRef.current;
          if (queued) {
            queued.preserveFromSequence = Math.min(
              queued.preserveFromSequence,
              preserveFromSequence,
            );
            for (const jobId of allowTerminalResetJobIds)
              queued.allowTerminalResetJobIds.add(jobId);
          } else {
            queuedReconcileRef.current = {
              preserveFromSequence,
              allowTerminalResetJobIds,
            };
          }
        }
        return inFlight;
      }

      const generation = mountGenerationRef.current;
      const promise = window.voice2text
        .listProcessingTasks()
        .then((incoming) => {
          if (!mountedRef.current || generation !== mountGenerationRef.current)
            return;
          const next = reconcileTaskList(
            incoming,
            tasksRef.current,
            latestDeltaRef.current,
            preserveFromSequence,
            allowTerminalResetJobIds,
          );
          for (const [jobId, receipt] of latestDeltaRef.current) {
            if (receipt.sequence < preserveFromSequence)
              latestDeltaRef.current.delete(jobId);
          }
          publishTasks(next);
        })
        .catch((error: unknown) => {
          if (mountedRef.current && generation === mountGenerationRef.current) {
            setOperationError(
              error instanceof Error ? error.message : "无法读取转写任务",
            );
          }
        })
        .finally(() => {
          reconcileInFlightRef.current = null;
          const queued = queuedReconcileRef.current;
          queuedReconcileRef.current = null;
          if (mountedRef.current && queued) {
            void reconcileRunnerRef.current(queued);
          }
        });
      reconcileInFlightRef.current = promise;
      return promise;
    },
    [publishTasks],
  );

  React.useEffect(() => {
    reconcileRunnerRef.current = requestReconcile;
  }, [requestReconcile]);

  React.useEffect(() => {
    mountedRef.current = true;
    mountGenerationRef.current += 1;
    let active = true;
    const unsubscribe = window.voice2text.onOperationEvent((event) => {
      if (!active) return;
      const previousEvent = lastEventRef.current.get(event.jobId);
      if (sameOperationEvent(previousEvent, event)) return;

      const sequence = eventSequenceRef.current + 1;
      eventSequenceRef.current = sequence;
      const merged = mergeOperationEvent(tasksRef.current, event);
      lastEventRef.current.set(event.jobId, event);
      if (!merged.accepted) return;
      latestDeltaRef.current.set(event.jobId, { sequence, event });
      if (merged.known) publishTasks(merged.tasks);
      if (!merged.known || merged.structural) {
        void requestReconcile({ preserveFromSequence: sequence });
      }
    });
    return () => {
      active = false;
      mountedRef.current = false;
      mountGenerationRef.current += 1;
      queuedReconcileRef.current = null;
      unsubscribe();
    };
  }, [publishTasks, requestReconcile]);

  React.useEffect(() => {
    if (profileReady) void requestReconcile();
  }, [profileReady, requestReconcile]);

  const beginPending = React.useCallback(
    (jobId: number, action: PendingJobAction): boolean => {
      if (pendingRef.current.has(jobId)) return false;
      pendingRef.current.set(jobId, action);
      if (mountedRef.current) setPendingJobActions(new Map(pendingRef.current));
      return true;
    },
    [],
  );

  const finishPending = React.useCallback((jobId: number) => {
    pendingRef.current.delete(jobId);
    if (mountedRef.current) setPendingJobActions(new Map(pendingRef.current));
  }, []);

  const importMeeting = React.useCallback(async () => {
    if (importPendingRef.current) return;
    importPendingRef.current = true;
    if (mountedRef.current) setImportPending(true);
    setOperationError(null);
    try {
      const result = await window.voice2text.importMeeting();
      if (result.state === "queued") {
        acceptSnapshot(await window.voice2text.getApplicationSnapshot());
        await requestReconcile({ queueIfBusy: false });
      }
    } catch (error) {
      if (mountedRef.current)
        setOperationError(error instanceof Error ? error.message : "导入失败");
    } finally {
      importPendingRef.current = false;
      if (mountedRef.current) setImportPending(false);
    }
  }, [acceptSnapshot, requestReconcile]);

  const cancelProcessing = React.useCallback(
    async (jobId: number) => {
      if (!beginPending(jobId, "cancel")) return;
      setOperationError(null);
      try {
        await window.voice2text.cancelProcessing(jobId);
        await requestReconcile({ queueIfBusy: false });
      } catch (error) {
        if (mountedRef.current)
          setOperationError(
            error instanceof Error ? error.message : "取消失败",
          );
      } finally {
        finishPending(jobId);
      }
    },
    [beginPending, finishPending, requestReconcile],
  );

  const retryProcessing = React.useCallback(
    async (jobId: number, expectedAttempt: number) => {
      if (!beginPending(jobId, "retry")) return;
      setOperationError(null);
      try {
        await window.voice2text.retryProcessing(jobId, expectedAttempt);
        await requestReconcile({
          allowTerminalResetJobIds: new Set([jobId]),
        });
      } catch (error) {
        if (mountedRef.current)
          setOperationError(
            error instanceof Error ? error.message : "重试失败",
          );
      } finally {
        finishPending(jobId);
      }
    },
    [beginPending, finishPending, requestReconcile],
  );

  return {
    tasks,
    operationError,
    importPending,
    pendingJobActions,
    importMeeting,
    cancelProcessing,
    retryProcessing,
  };
}

export function mergeOperationEvent(
  tasks: readonly ProcessingTask[],
  event: OperationEvent,
): {
  tasks: ProcessingTask[];
  known: boolean;
  accepted: boolean;
  structural: boolean;
} {
  const index = tasks.findIndex((task) => task.id === event.jobId);
  if (index < 0)
    return {
      tasks: [...tasks],
      known: false,
      accepted: true,
      structural: true,
    };
  const current = tasks[index]!;
  if (event.attempt < current.attempt) {
    return {
      tasks: [...tasks],
      known: true,
      accepted: false,
      structural: false,
    };
  }
  if (event.attempt > current.attempt) {
    return {
      tasks: [...tasks],
      known: false,
      accepted: true,
      structural: true,
    };
  }
  if (!canApplyState(current.state, event.state)) {
    return {
      tasks: [...tasks],
      known: true,
      accepted: false,
      structural: false,
    };
  }

  const phaseRegressed =
    current.phase === "diarization" && event.phase === "asr";
  const phase = phaseRegressed ? current.phase : (event.phase ?? current.phase);
  const progressFraction =
    event.progressFraction === undefined || phaseRegressed
      ? current.progressFraction
      : phase === current.phase
        ? Math.max(current.progressFraction, event.progressFraction)
        : event.progressFraction;
  const next: ProcessingTask = {
    ...current,
    state: event.state,
    phase,
    progressFraction,
  };
  const output = [...tasks];
  output[index] = next;
  return {
    tasks: output,
    known: true,
    accepted: true,
    structural: current.state !== next.state,
  };
}

function reconcileTaskList(
  incoming: ProcessingTask[],
  current: readonly ProcessingTask[],
  deltas: ReadonlyMap<number, DeltaReceipt>,
  preserveFromSequence: number,
  allowTerminalResetJobIds: ReadonlySet<number>,
): ProcessingTask[] {
  const currentById = new Map(current.map((task) => [task.id, task]));
  let next = incoming.map((task) => {
    const existing = currentById.get(task.id);
    if (
      existing &&
      existing.attempt === task.attempt &&
      terminalStates.has(existing.state) &&
      !terminalStates.has(task.state) &&
      !allowTerminalResetJobIds.has(task.id)
    ) {
      return existing;
    }
    return task;
  });
  for (const receipt of deltas.values()) {
    if (receipt.sequence < preserveFromSequence) continue;
    next = mergeOperationEvent(next, receipt.event).tasks;
  }
  return next;
}

function canApplyState(
  current: ProcessingTask["state"],
  next: ProcessingTask["state"],
): boolean {
  if (current === next) return true;
  if (terminalStates.has(current)) return false;
  if (current === "canceling") return next === "canceled";
  if (current === "running" && next === "queued") return false;
  return true;
}

function sameOperationEvent(
  left: OperationEvent | undefined,
  right: OperationEvent,
): boolean {
  return (
    left?.jobId === right.jobId &&
    left.attempt === right.attempt &&
    left.state === right.state &&
    left.phase === right.phase &&
    left.progressFraction === right.progressFraction
  );
}
