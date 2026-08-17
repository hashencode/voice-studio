// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { LibraryFeature } from "../../../src/renderer/features/library/library-feature";
import { TasksFeature } from "../../../src/renderer/features/tasks/tasks-feature";

it("imports through a business callback without exposing a source path", async () => {
  const onImport = vi.fn(async () => undefined);
  render(
    <LibraryFeature
      state={{ phase: "empty" }}
      writable
      importPending={false}
      onImport={onImport}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "导入会议" }));
  expect(onImport).toHaveBeenCalledWith();
});

it("shows semantic task states, throttled progress, and keyboard cancel", async () => {
  const cancel = vi.fn(async () => undefined);
  render(
    <TasksFeature
      tasks={[
        {
          id: 7,
          audioId: 3,
          displayName: "项目周会.wav",
          state: "running",
          phase: "asr",
          progressFraction: 0.42,
          attempt: 2,
          errorCode: null,
        },
        {
          id: 8,
          audioId: 4,
          displayName: "取消任务.wav",
          state: "canceled",
          phase: "asr",
          progressFraction: 0.2,
          attempt: 1,
          errorCode: "CANCELED",
        },
      ]}
      pendingJobActions={new Map()}
      onCancel={cancel}
      onRetry={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("status", { name: "任务进度公告" }),
  ).toHaveTextContent("项目周会.wav 正在识别 42%");
  expect(screen.getByText("已取消", { selector: "span" })).toHaveTextContent(
    "已取消",
  );
  const button = screen.getByRole("button", { name: "取消 项目周会.wav" });
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  expect(cancel).toHaveBeenCalledWith(7);
});

it.each([
  ["completed", "已完成"],
  ["failed", "处理失败"],
  ["canceled", "已取消"],
  ["interrupted", "已中断"],
] as const)(
  "announces a named %s terminal transition",
  async (state, label) => {
    const running = {
      id: 7,
      audioId: 3,
      displayName: "项目周会.wav",
      state: "running" as const,
      phase: "asr" as const,
      progressFraction: 0.42,
      attempt: 2,
      errorCode: null,
    };
    const view = render(
      <TasksFeature
        tasks={[running]}
        pendingJobActions={new Map()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    view.rerender(
      <TasksFeature
        tasks={[
          {
            ...running,
            state,
            progressFraction: state === "completed" ? 1 : 0.42,
          },
        ]}
        pendingJobActions={new Map()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 800));
    });

    expect(
      screen.getByRole("status", { name: "任务进度公告" }),
    ).toHaveTextContent(`项目周会.wav ${label}`);
  },
);

it("announces the task that just became terminal when an older terminal task is listed first", async () => {
  const olderCompleted = {
    id: 6,
    audioId: 2,
    displayName: "旧会议.wav",
    state: "completed" as const,
    phase: "diarization" as const,
    progressFraction: 1,
    attempt: 1,
    errorCode: null,
  };
  const running = {
    id: 7,
    audioId: 3,
    displayName: "本次会议.wav",
    state: "running" as const,
    phase: "asr" as const,
    progressFraction: 0.42,
    attempt: 2,
    errorCode: null,
  };
  const props = {
    pendingJobActions: new Map(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(
    <TasksFeature tasks={[olderCompleted, running]} {...props} />,
  );

  view.rerender(
    <TasksFeature
      tasks={[
        olderCompleted,
        { ...running, state: "failed", errorCode: "PROCESS_INTERRUPTED" },
      ]}
      {...props}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 800));
  });

  expect(
    screen.getByRole("status", { name: "任务进度公告" }),
  ).toHaveTextContent("本次会议.wav 处理失败");
});
