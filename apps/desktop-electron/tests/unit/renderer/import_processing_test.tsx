// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { AudioRouteFeature } from "../../../src/renderer/features/audios/audio-route-feature";
import type {
  AudioSummary,
  AudioWorkspaceSnapshot,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const audio: AudioSummary = {
  audioId: 3,
  displayName: "项目音频.wav",
  durationMs: 6_000,
  createdAtMs: 1,
  processingState: "running",
  generationId: 9,
  generationKind: "formal",
  segmentCount: 1,
};

const workspace: AudioWorkspaceSnapshot = {
  revision: 1,
  summary: audio,
  segments: [
    {
      id: 1,
      stableKey: "0:0:1000",
      sequenceId: 0,
      text: "准备发布。",
      machineText: "准备发布。",
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

const running: ProcessingTask = {
  id: 7,
  audioId: 3,
  displayName: audio.displayName,
  state: "running",
  phase: "asr",
  progressFraction: 0.42,
  attempt: 2,
  errorCode: null,
};

it("renders the selected Audio task with the single applicable cancel action", async () => {
  const cancel = vi.fn(async () => undefined);
  renderRoute([running], { onCancel: cancel });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: /打开 项目音频/ }),
  );

  expect(
    screen.getByRole("progressbar", { name: "项目音频.wav 处理进度" }),
  ).toHaveValue(0.42);
  const button = screen.getByRole("button", { name: "取消 项目音频.wav" });
  expect(screen.getAllByText("取消", { selector: "button" })).toHaveLength(1);
  await user.click(button);
  expect(cancel).toHaveBeenCalledWith(7);
});

it("shows retry for failed/interrupted and hides completed chrome once transcript is ready", async () => {
  const retry = vi.fn(async () => undefined);
  const view = renderRoute(
    [{ ...running, state: "failed", errorCode: "ASR_FAILED" }],
    {
      onRetry: retry,
    },
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: /打开 项目音频/ }),
  );
  await user.click(screen.getByRole("button", { name: "重试 项目音频.wav" }));
  expect(retry).toHaveBeenCalledWith(7, 2);

  view.rerender(
    route([{ ...running, state: "completed", progressFraction: 1 }]),
  );
  expect(
    screen.queryByRole("region", { name: "当前音频处理" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "项目音频.wav 工作区" }),
  ).toBeVisible();
});

it.each([
  ["failed", "处理失败"],
  ["canceled", "已取消"],
  ["interrupted", "已中断"],
] as const)(
  "renders a visible named %s terminal transition",
  async (state, label) => {
    const view = renderRoute([running]);
    view.rerender(route([{ ...running, state }]));
    expect(await screen.findByText(label, { selector: "span" })).toBeVisible();
  },
);

it("keeps completed audio discoverable without processing chrome", async () => {
  renderRoute([{ ...running, state: "completed", progressFraction: 1 }]);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "打开 项目音频.wav" }));

  expect(
    screen.queryByRole("region", { name: "当前音频处理" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "项目音频.wav 工作区" }),
  ).toBeVisible();
});

function renderRoute(
  tasks: ProcessingTask[],
  overrides: {
    onCancel?: (jobId: number) => void;
    onRetry?: (jobId: number, attempt: number) => void;
  } = {},
) {
  return render(route(tasks, overrides));
}

function route(
  tasks: ProcessingTask[],
  overrides: {
    onCancel?: (jobId: number) => void;
    onRetry?: (jobId: number, attempt: number) => void;
  } = {},
) {
  return (
    <AudioRouteFeature
      api={desktopApi()}
      tasks={tasks}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={overrides.onCancel ?? vi.fn()}
      onRetry={overrides.onRetry ?? vi.fn()}
    />
  );
}

function desktopApi() {
  return {
    getAudioAiSnapshot: vi.fn(async () => null),
    prepareAudioAi: vi.fn(),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => [audio]),
    openAudio: vi.fn(async () => workspace),
    searchTranscript: vi.fn(async () => []),
    editAudioSegment: vi.fn(),
    undoAudioEdit: vi.fn(),
    redoAudioEdit: vi.fn(),
    renameAudioSpeaker: vi.fn(),
    mergeAudioSpeakers: vi.fn(),
    assignAudioSpeaker: vi.fn(),
    controlAudioPlayback: vi.fn(async () => ({
      audioId: null,
      initialized: false,
      playing: false,
      positionMs: 0,
      durationMs: 0,
      speed: 1,
      error: null,
    })),
    exportAudio: vi.fn(async () => ({ state: "canceled" as const })),
  } as unknown as Voice2TextDesktopApi;
}
