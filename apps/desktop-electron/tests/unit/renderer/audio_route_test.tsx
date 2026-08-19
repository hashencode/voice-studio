// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { AudioRouteFeature } from "../../../src/renderer/features/audios/audio-route-feature";
import type {
  AudioSummary,
  AudioWorkspaceSnapshot,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const audioA = summary(1, "音频 A.wav");
const audioB = summary(2, "音频 B.wav");
const audioC = summary(3, "音频 C.wav");

it("owns create/import in the pane and keeps the no-selection main minimal", async () => {
  const onImport = vi.fn(async () => undefined);
  const onRecord = vi.fn();
  render(
    <AudioRouteFeature
      api={api()}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onOpenPane={vi.fn()}
      onRecord={onRecord}
      onImport={onImport}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const pane = screen.getByRole("region", { name: "音频列表" });
  const main = screen.getByRole("region", { name: "音频工作区" });
  expect(
    await within(pane).findByRole("searchbox", { name: "搜索音频" }),
  ).toBeVisible();
  await userEvent
    .setup()
    .click(within(pane).getByRole("button", { name: "开始录音" }));
  await userEvent
    .setup()
    .click(within(pane).getByRole("button", { name: "导入音频" }));
  expect(onRecord).toHaveBeenCalledOnce();
  expect(onImport).toHaveBeenCalledOnce();
  expect(
    within(main).getByRole("button", { name: "打开音频列表" }),
  ).toBeVisible();
  expect(main).not.toHaveTextContent("开始录音");
  expect(main).not.toHaveTextContent("导入音频");

  const list = within(pane).getByRole("list", { name: "音频列表" });
  expect(list).toHaveAttribute("data-flat-row-list", "true");
  const row = within(list).getByRole("button", { name: /打开 音频 A/ });
  expect(row).toHaveAttribute("data-flat-row", "true");
  expect(row).not.toHaveClass("rounded-lg", "border", "bg-card");
});

it("filters Audio summaries and projects every non-completed processing state", async () => {
  const states = [
    "queued",
    "running",
    "canceling",
    "failed",
    "interrupted",
    "canceled",
  ] as const;
  const audios = states.map((_, index) =>
    summary(index + 1, `音频 ${index + 1}.wav`),
  );
  const tasks = states.map((state, index): ProcessingTask => ({
    id: index + 10,
    audioId: index + 1,
    displayName: audios[index]!.displayName,
    state,
    phase: "asr",
    progressFraction: 0.25,
    attempt: 1,
    errorCode: state === "failed" ? "ASR_FAILED" : null,
  }));
  render(
    <AudioRouteFeature
      api={api({ listAudios: vi.fn(async () => audios) })}
      tasks={tasks}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onOpenPane={vi.fn()}
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await screen.findByRole("button", { name: /打开 音频 1/ });
  for (const label of [
    "等待处理",
    "正在处理",
    "正在取消",
    "处理失败",
    "已中断",
    "已取消",
  ]) {
    expect(screen.getByText(label, { selector: "span" })).toBeVisible();
  }
  expect(
    screen.getAllByRole("status", { name: "音频处理进度公告" }),
  ).toHaveLength(1);

  const search = screen.getByRole("searchbox", { name: "搜索音频" });
  await userEvent.setup().type(search, "音频 4");
  expect(screen.getByRole("button", { name: /打开 音频 4/ })).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /打开 音频 1/ }),
  ).not.toBeInTheDocument();
});

it("keeps A on failed A-to-B transition and keys detail after success", async () => {
  let rejectClose = true;
  const controlAudioPlayback = vi.fn(async (audioId, command) => {
    if (command.action === "close" && audioId === 1 && rejectClose) {
      rejectClose = false;
      throw new Error("无法关闭 A");
    }
    return playback(audioId, command.action !== "close");
  });
  const desktop = api({ controlAudioPlayback });
  renderRoute(desktop);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("heading", { name: "音频 A.wav" });
  await user.type(
    screen.getByRole("searchbox", { name: "搜索音频转写" }),
    "A 状态",
  );
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法关闭 A");
  expect(screen.getByRole("heading", { name: "音频 A.wav" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(
    await screen.findByRole("heading", { name: "音频 B.wav" }),
  ).toBeVisible();
  expect(screen.getByRole("searchbox", { name: "搜索音频转写" })).toHaveValue(
    "",
  );
  expect(controlAudioPlayback.mock.calls[0]).toEqual([1, { action: "close" }]);
});

it("fences rapid B/C intents so only C renders after A closes", async () => {
  const closeA = deferred<ReturnType<typeof playback>>();
  const openB = deferred<AudioWorkspaceSnapshot | null>();
  const desktop = api({
    openAudio: vi.fn((audioId) => {
      if (audioId === 2) return openB.promise;
      return Promise.resolve(workspace(audioId === 1 ? audioA : audioC));
    }),
    controlAudioPlayback: vi.fn((audioId, command) => {
      if (audioId === 1 && command.action === "close") return closeA.promise;
      return Promise.resolve(playback(audioId, command.action !== "close"));
    }),
  });
  renderRoute(desktop);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("heading", { name: "音频 A.wav" });
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  await user.click(screen.getByRole("button", { name: /打开 音频 C/ }));
  closeA.resolve(playback(1, false));

  expect(
    await screen.findByRole("heading", { name: "音频 C.wav" }),
  ).toBeVisible();
  openB.resolve(workspace(audioB));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "音频 B.wav" }),
    ).not.toBeInTheDocument(),
  );
  expect(desktop.controlAudioPlayback).toHaveBeenCalledTimes(1);
});

it("closes A again after a successful close is followed by a failed B open", async () => {
  let failB = true;
  const desktop = api({
    openAudio: vi.fn(async (audioId) => {
      if (audioId === 2 && failB) {
        failB = false;
        throw new Error("无法打开 B");
      }
      return workspace([audioA, audioB, audioC][audioId - 1]!);
    }),
  });
  renderRoute(desktop);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("heading", { name: "音频 A.wav" });
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法打开 B");
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));

  expect(
    await screen.findByRole("heading", { name: "音频 B.wav" }),
  ).toBeVisible();
  expect(desktop.controlAudioPlayback).toHaveBeenCalledTimes(2);
  expect(desktop.controlAudioPlayback).toHaveBeenNthCalledWith(1, 1, {
    action: "close",
  });
  expect(desktop.controlAudioPlayback).toHaveBeenNthCalledWith(2, 1, {
    action: "close",
  });
});

it("chooses the newest processing job id before comparing attempts", async () => {
  const olderHighAttempt: ProcessingTask = {
    id: 40,
    audioId: 1,
    displayName: audioA.displayName,
    state: "failed",
    phase: "asr",
    progressFraction: 0.4,
    attempt: 9,
    errorCode: "OLD_FAILURE",
  };
  const newerLowAttempt: ProcessingTask = {
    ...olderHighAttempt,
    id: 41,
    state: "running",
    progressFraction: 0.7,
    attempt: 1,
    errorCode: null,
  };
  render(
    <AudioRouteFeature
      api={api()}
      tasks={[olderHighAttempt, newerLowAttempt]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onOpenPane={vi.fn()}
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  expect(
    await screen.findByRole("button", { name: "取消 音频 A.wav" }),
  ).toBeVisible();
  expect(
    screen.getByRole("progressbar", { name: "音频 A.wav 处理进度" }),
  ).toHaveAttribute("data-processing-job-id", "41");
  expect(
    screen.getByRole("button", { name: "打开 音频 A.wav" }),
  ).toHaveAttribute("data-audio-id", "1");
  expect(
    screen.queryByRole("button", { name: "重试 音频 A.wav" }),
  ).not.toBeInTheDocument();
});

it("reopens the still-selected Audio exactly once when its current task completes", async () => {
  const running = processingTask("running", 51);
  const completed = { ...running, state: "completed" as const };
  const refreshed = workspace({
    ...audioA,
    segmentCount: 2,
  });
  refreshed.segments[0]!.text = "完成后的转写";
  refreshed.segments[0]!.machineText = "完成后的转写";
  const openAudio = vi
    .fn()
    .mockResolvedValueOnce(workspace(audioA))
    .mockResolvedValueOnce(refreshed);
  const props = {
    api: api({ openAudio }),
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onOpenPane: vi.fn(),
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} tasks={[running]} />);

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("heading", { name: "音频 A.wav" });
  view.rerender(<AudioRouteFeature {...props} tasks={[completed]} />);

  await waitFor(() => expect(openAudio).toHaveBeenCalledTimes(2));
  expect(screen.getByText("完成后的转写")).toBeVisible();
  view.rerender(<AudioRouteFeature {...props} tasks={[completed]} />);
  await waitFor(() => expect(openAudio).toHaveBeenCalledTimes(2));
});

it("refreshes the list for structural task changes but not progress-only updates", async () => {
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([audioA])
    .mockResolvedValueOnce([audioA]);
  const desktop = api({ listAudios });
  const running = processingTask("running", 61);
  const props = {
    api: desktop,
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onOpenPane: vi.fn(),
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} tasks={[]} />);

  await screen.findByRole("button", { name: /打开 音频 A/ });
  expect(listAudios).toHaveBeenCalledTimes(1);
  view.rerender(<AudioRouteFeature {...props} tasks={[running]} />);
  await waitFor(() => expect(listAudios).toHaveBeenCalledTimes(2));
  view.rerender(
    <AudioRouteFeature
      {...props}
      tasks={[{ ...running, progressFraction: 0.9 }]}
    />,
  );
  await waitFor(() => expect(listAudios).toHaveBeenCalledTimes(2));
});

it("recovers a failed Audio list through the visible retry action", async () => {
  const listAudios = vi
    .fn()
    .mockRejectedValueOnce(new Error("列表暂时不可用"))
    .mockResolvedValueOnce([audioA]);
  renderRoute(api({ listAudios }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("列表暂时不可用");
  const retry = within(alert).getByRole("button", { name: "重新载入" });
  expect(retry).toBeEnabled();
  await userEvent.setup().click(retry);

  expect(
    await screen.findByRole("button", { name: /打开 音频 A/ }),
  ).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("列表暂时不可用")).not.toBeInTheDocument();
});

it("ignores an Audio mutation response after a newer selection", async () => {
  const undoA = deferred<AudioWorkspaceSnapshot>();
  const desktop = api({
    openAudio: vi.fn(async (audioId) => ({
      ...workspace([audioA, audioB, audioC][audioId - 1]!),
      canUndo: audioId === audioA.audioId,
    })),
    undoAudioEdit: vi.fn(() => undoA.promise),
  });
  renderRoute(desktop);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await user.click(screen.getByRole("button", { name: "撤销" }));
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(
    await screen.findByRole("heading", { name: "音频 B.wav" }),
  ).toBeVisible();

  await act(async () => {
    undoA.resolve({ ...workspace(audioA), revision: 2 });
    await undoA.promise;
  });
  expect(
    screen.queryByRole("heading", { name: "音频 A.wav" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "音频 B.wav" })).toBeVisible();
});

it("clears a selected Audio only after its playback closes when a structural refresh removes it", async () => {
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([audioA])
    .mockResolvedValueOnce([]);
  const desktop = api({ listAudios });
  const props = {
    api: desktop,
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onOpenPane: vi.fn(),
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} tasks={[]} />);

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("heading", { name: "音频 A.wav" });

  view.rerender(
    <AudioRouteFeature {...props} tasks={[processingTask("queued", 71)]} />,
  );

  await waitFor(() =>
    expect(desktop.controlAudioPlayback).toHaveBeenCalledWith(1, {
      action: "close",
    }),
  );
  expect(
    await screen.findByRole("button", { name: "打开音频列表" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "音频 A.wav" }),
  ).not.toBeInTheDocument();
});

function processingTask(
  state: ProcessingTask["state"],
  id: number,
): ProcessingTask {
  return {
    id,
    audioId: audioA.audioId,
    displayName: audioA.displayName,
    state,
    phase: "asr",
    progressFraction: state === "completed" ? 1 : 0.2,
    attempt: 1,
    errorCode: null,
  };
}

function renderRoute(desktop: Voice2TextDesktopApi) {
  return render(
    <AudioRouteFeature
      api={desktop}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onOpenPane={vi.fn()}
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

function summary(audioId: number, displayName: string): AudioSummary {
  return {
    audioId,
    displayName,
    durationMs: 6_000,
    createdAtMs: audioId,
    processingState: "completed",
    generationId: audioId + 100,
    generationKind: "formal",
    segmentCount: 1,
  };
}

function workspace(value: AudioSummary): AudioWorkspaceSnapshot {
  return {
    revision: 1,
    summary: value,
    segments: [
      {
        id: value.audioId,
        stableKey: `${value.audioId}:0:1000`,
        sequenceId: 0,
        text: value.displayName,
        machineText: value.displayName,
        startMs: 0,
        endMs: 1_000,
        reviewState: "unreviewed",
        speakerState: "unknown",
        speakerId: null,
        speakerName: null,
        speakerSource: "machine",
      },
    ],
    speakers: [],
    canUndo: false,
    canRedo: false,
  };
}

function playback(audioId: number, initialized: boolean) {
  return {
    audioId: initialized ? audioId : null,
    initialized,
    playing: false,
    positionMs: 0,
    durationMs: 6_000,
    speed: 1,
    error: null,
  };
}

function api(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return {
    getAudioAiSnapshot: vi.fn(async () => null),
    prepareAudioAi: vi.fn(),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => [audioA, audioB, audioC]),
    openAudio: vi.fn(async (audioId) =>
      workspace([audioA, audioB, audioC][audioId - 1]!),
    ),
    searchTranscript: vi.fn(async () => []),
    editAudioSegment: vi.fn(),
    undoAudioEdit: vi.fn(),
    redoAudioEdit: vi.fn(),
    renameAudioSpeaker: vi.fn(),
    mergeAudioSpeakers: vi.fn(),
    assignAudioSpeaker: vi.fn(),
    controlAudioPlayback: vi.fn(async (audioId, command) =>
      playback(audioId, command.action !== "close"),
    ),
    exportAudio: vi.fn(async () => ({ state: "canceled" as const })),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}
