import * as React from "react";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RotateCcw,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PendingJobAction } from "@/features/tasks/use-processing-tasks";
import type { ProcessingTask } from "@shared/contracts";

export function TasksFeature({
  tasks,
  pendingJobActions,
  onCancel,
  onRetry,
}: {
  tasks: readonly ProcessingTask[];
  pendingJobActions: ReadonlyMap<number, PendingJobAction>;
  onCancel: (jobId: number) => void | Promise<void>;
  onRetry: (jobId: number, attempt: number) => void | Promise<void>;
}) {
  const announcement = useThrottledAnnouncement(tasks);
  return (
    <section className="space-y-5">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          进度由 Electron Main 持久保存
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">转写任务</h1>
      </div>
      <p
        role="status"
        aria-label="任务进度公告"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </p>
      {tasks.length === 0 ? (
        <div className="grid min-h-64 place-items-center rounded-xl border bg-card p-8 text-center">
          <div>
            <Clock3 className="mx-auto size-8" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold">暂无转写任务</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              导入会议后，进度、取消和重试状态会显示在这里。
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="转写任务列表">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="rounded-xl border bg-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate font-medium">{task.displayName}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {phaseLabel(task.phase)} · 第 {Math.max(1, task.attempt)}{" "}
                    次尝试
                  </p>
                </div>
                <SemanticState task={task} />
              </div>
              <progress
                className="mt-4 h-2 w-full"
                max={1}
                value={task.progressFraction}
                aria-label={`${task.displayName} 处理进度`}
              />
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span>{Math.round(task.progressFraction * 100)}%</span>
                {task.state === "running" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${pendingJobActions.get(task.id) === "cancel" ? "正在取消" : "取消"} ${task.displayName}`}
                    disabled={pendingJobActions.has(task.id)}
                    onClick={() => void onCancel(task.id)}
                  >
                    <Square aria-hidden="true" />
                    {pendingJobActions.get(task.id) === "cancel"
                      ? "正在取消"
                      : "取消"}
                  </Button>
                ) : task.state === "failed" || task.state === "interrupted" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`${pendingJobActions.get(task.id) === "retry" ? "正在重试" : "重试"} ${task.displayName}`}
                    disabled={pendingJobActions.has(task.id)}
                    onClick={() => void onRetry(task.id, task.attempt)}
                  >
                    <RotateCcw aria-hidden="true" />
                    {pendingJobActions.get(task.id) === "retry"
                      ? "正在重试"
                      : "重试"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SemanticState({ task }: { task: ProcessingTask }) {
  const presentation = {
    queued: { icon: Clock3 },
    running: { icon: LoaderCircle },
    canceling: { icon: LoaderCircle },
    canceled: { icon: Ban },
    interrupted: { icon: CircleAlert },
    completed: { icon: CheckCircle2 },
    failed: { icon: CircleAlert },
  }[task.state];
  const Icon = presentation.icon;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
      <Icon
        className={
          task.state === "running" || task.state === "canceling"
            ? "size-3.5 animate-spin"
            : "size-3.5"
        }
        aria-hidden="true"
      />
      {taskStateLabel(task.state)}
    </span>
  );
}

function useThrottledAnnouncement(tasks: readonly ProcessingTask[]): string {
  const previousTasks = React.useRef(tasks);
  const [current, setCurrent] = React.useState(() => announce(tasks, tasks));
  const currentRef = React.useRef(current);
  const lastUpdate = React.useRef(0);
  React.useEffect(() => {
    const next = announce(tasks, previousTasks.current);
    previousTasks.current = tasks;
    if (next === currentRef.current) return;
    const delay = Math.max(0, 750 - (Date.now() - lastUpdate.current));
    const timer = window.setTimeout(() => {
      lastUpdate.current = Date.now();
      currentRef.current = next;
      setCurrent(next);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [tasks]);
  return current;
}

function announce(
  tasks: readonly ProcessingTask[],
  previousTasks: readonly ProcessingTask[],
): string {
  const task = tasks.find(
    (candidate) =>
      candidate.state === "running" || candidate.state === "canceling",
  );
  if (!task) {
    const terminal = tasks.find((candidate) => {
      if (
        !["completed", "failed", "canceled", "interrupted"].includes(
          candidate.state,
        )
      ) {
        return false;
      }
      const previous = previousTasks.find(
        (item) =>
          item.id === candidate.id && item.attempt === candidate.attempt,
      );
      return previous?.state !== candidate.state;
    });
    return terminal
      ? `${terminal.displayName} ${taskStateLabel(terminal.state)}`
      : "当前没有正在运行的任务";
  }
  return `${task.displayName} ${task.state === "canceling" ? "正在取消" : phaseLabel(task.phase)} ${Math.round(task.progressFraction * 100)}%`;
}

function taskStateLabel(state: ProcessingTask["state"]): string {
  return {
    queued: "等待处理",
    running: "正在处理",
    canceling: "正在取消",
    canceled: "已取消",
    interrupted: "已中断",
    completed: "已完成",
    failed: "处理失败",
  }[state];
}

function phaseLabel(phase: ProcessingTask["phase"]): string {
  return phase === "asr" ? "正在识别" : "正在区分说话人";
}
