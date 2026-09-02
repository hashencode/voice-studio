// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { AudioRouteFeature } from "../../../src/renderer/features/audios/audio-route-feature";
import { RECORDING_PREFERENCE_STORAGE_KEY } from "../../../src/renderer/features/capture/use-recording-preference";
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

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

it("renders the authoritative first-use state only after an empty list succeeds", async () => {
  const onImport = vi.fn(async () => ({
    protocolVersion: 2 as const,
    state: "canceled" as const,
  }));
  const onRecord = vi.fn();
  render(
    <AudioRouteFeature
      api={api({ listAudios: vi.fn(async () => []) })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={onRecord}
      onImport={onImport}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const main = screen.getByRole("region", { name: "音频工作区" });
  expect(
    await within(main).findByRole("heading", {
      name: "开始你的第一段音频",
    }),
  ).toBeVisible();
  expect(main).toHaveTextContent(
    "录制一段新音频，或导入已有文件开始转写和整理。",
  );
  const frame = main.querySelector('[data-audio-first-use="frame"]');
  expect(frame).toBeInTheDocument();
  expect(frame).not.toHaveAttribute("data-slot", "card");
  expect(frame?.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
  expect(
    frame?.querySelector('[data-audio-first-use="content"]'),
  ).toBeInTheDocument();
  const preview = frame?.querySelector('[data-audio-first-use="preview"]');
  expect(preview).toHaveAttribute("aria-hidden", "true");
  expect(
    preview?.querySelector('[data-audio-first-use="preview-surface"]'),
  ).toBeEmptyDOMElement();
  expect(
    preview?.querySelectorAll(
      'button, a, input, select, textarea, [tabindex], [contenteditable="true"]',
    ),
  ).toHaveLength(0);
  expect(
    screen.queryByRole("searchbox", { name: "搜索音频" }),
  ).not.toBeInTheDocument();
  const user = userEvent.setup();
  const importButton = within(main).getByRole("button", {
    name: "导入音频",
  });
  await user.click(importButton);
  expect(onImport).toHaveBeenCalledOnce();
  expect(
    within(main).queryByRole("combobox", { name: "麦克风" }),
  ).not.toBeInTheDocument();
  expect(within(main).getByRole("button", { name: "开始录制" })).toBeVisible();
  expect(
    within(main).getByRole("button", { name: "测试麦克风" }),
  ).toBeVisible();
  await userEvent
    .setup()
    .click(within(main).getByRole("button", { name: "开始录制" }));
  expect(onRecord).toHaveBeenCalledOnce();
});

it("keeps first-use write actions disabled when the workspace is read-only", async () => {
  render(
    <AudioRouteFeature
      api={firstUseApi()}
      tasks={[]}
      pendingJobActions={new Map()}
      writable={false}
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  expect(
    await screen.findByRole("button", { name: "开始录制" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "导入音频" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "测试麦克风" })).toBeEnabled();
});

it("keeps first-use recording controls disabled during active recording", async () => {
  render(
    <AudioRouteFeature
      api={firstUseApi()}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      recordingActive
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  expect(
    await screen.findByRole("button", { name: "开始录制" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "导入音频" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "测试麦克风" })).toBeDisabled();
});

it("allows recording and pure audio import without local processing", async () => {
  const onImport = vi.fn();
  const onProcessingUnavailable = vi.fn();
  render(
    <AudioRouteFeature
      api={firstUseApi()}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      processingAvailable={false}
      paneOpen
      onProcessingUnavailable={onProcessingUnavailable}
      onRecord={vi.fn()}
      onImport={onImport}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  expect(await screen.findByRole("button", { name: "开始录制" })).toBeEnabled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "导入音频" }));
  expect(onProcessingUnavailable).not.toHaveBeenCalled();
  expect(onImport).toHaveBeenCalledOnce();
});

it("creates processing only after the user explicitly starts transcription", async () => {
  const startTranscription = vi.fn(async (audioId: number) => ({
    protocolVersion: 2 as const,
    jobId: audioId + 100,
    state: "queued" as const,
  }));
  const untranscribed = {
    ...workspace(audioA),
    summary: {
      ...audioA,
      processingState: "not-started" as const,
      generationId: null,
      generationKind: null,
      segmentCount: 0,
    },
    segments: [],
  };
  renderRoute(
    api({
      startTranscription,
      openAudio: vi.fn(async () => untranscribed),
    }),
  );
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  expect(await screen.findByText("尚未转写")).toBeVisible();
  expect(startTranscription).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "开始转写" }));
  expect(startTranscription).toHaveBeenCalledWith(audioA.audioId);
});

it("routes processing capability failures without exposing diagnostics", async () => {
  const rawDiagnostic = "本地转写不可用：模型 /private/models/asr.bin 缺失";
  const onProcessingUnavailable = vi.fn();
  const untranscribed = {
    ...workspace(audioA),
    summary: {
      ...audioA,
      processingState: "not-started" as const,
      generationId: null,
      generationKind: null,
      segmentCount: 0,
    },
    segments: [],
  };
  render(
    <AudioRouteFeature
      api={api({
        openAudio: vi.fn(async () => untranscribed),
        startTranscription: vi.fn(async () => {
          throw new Error(rawDiagnostic);
        }),
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onProcessingUnavailable={onProcessingUnavailable}
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "开始转写" }));

  await waitFor(() => expect(onProcessingUnavailable).toHaveBeenCalledOnce());
  expect(onProcessingUnavailable).toHaveBeenCalledWith();
  expect(screen.queryByText(rawDiagnostic)).not.toBeInTheDocument();
});

it("disables the new recording action and shows the active recording state", async () => {
  render(
    <AudioRouteFeature
      api={api()}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      recordingActive
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  const record = await screen.findByRole("button", { name: "正在录音" });
  expect(record).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "新录音" }),
  ).not.toBeInTheDocument();
});

it("disables new recording while capture recovery needs attention", async () => {
  render(
    <AudioRouteFeature
      api={api()}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      newRecordingBlocked
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  expect(await screen.findByRole("button", { name: "新录音" })).toBeDisabled();
});

it("keeps initial loading out of the list and first-use states", async () => {
  const listAudios = deferred<AudioSummary[]>();
  render(
    <AudioRouteFeature
      api={api({ listAudios: vi.fn(() => listAudios.promise) })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const main = screen.getByRole("region", { name: "音频工作区" });
  const loading = await within(main).findByRole("status", {
    name: "正在加载音频",
  });
  expect(loading).toHaveTextContent("正在加载音频…");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "导入音频" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("开始你的第一段音频")).not.toBeInTheDocument();
  expect(
    main.querySelector('[data-audio-first-use="frame"]'),
  ).not.toBeInTheDocument();

  await act(async () => listAudios.resolve([]));

  expect(
    await within(main).findByRole("heading", {
      name: "开始你的第一段音频",
    }),
  ).toBeVisible();
});

it("shows only the workspace error and retry after an initial list failure", async () => {
  const listAudios = vi
    .fn()
    .mockRejectedValueOnce(new Error("raw /private/library failure"))
    .mockResolvedValueOnce([audioA]);
  renderRoute(api({ listAudios }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("无法载入音频列表");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "导入音频" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "开始录制" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("开始你的第一段音频")).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("region", { name: "音频工作区" })
      .querySelector('[data-audio-first-use="frame"]'),
  ).not.toBeInTheDocument();

  await userEvent
    .setup()
    .click(within(alert).getByRole("button", { name: "重新载入" }));
  expect(
    await screen.findByRole("button", { name: /打开 音频 A/ }),
  ).toBeVisible();
});

it("preserves a populated workspace during background refresh and query-empty", async () => {
  const refresh = deferred<AudioSummary[]>();
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([audioA])
    .mockImplementationOnce(() => refresh.promise);
  const props = {
    api: api({ listAudios }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(
    <AudioRouteFeature {...props} libraryRefreshToken="ready:1" />,
  );

  const search = await screen.findByRole("searchbox", { name: "搜索音频" });
  expect(screen.getByText("选择一段音频")).toBeVisible();
  expect(
    screen
      .getByRole("region", { name: "音频工作区" })
      .querySelector('[data-audio-first-use="frame"]'),
  ).not.toBeInTheDocument();
  view.rerender(<AudioRouteFeature {...props} libraryRefreshToken="ready:2" />);
  expect(await screen.findByText("正在刷新音频…")).toBeVisible();
  expect(search).toBeVisible();
  expect(screen.getByText("选择一段音频")).toBeVisible();

  await act(async () => refresh.resolve([audioA]));
  await userEvent.setup().type(search, "不存在");
  expect(screen.getByText("没有匹配的音频")).toBeVisible();
  expect(screen.getByText("选择一段音频")).toBeVisible();
});

it("combines truthful processing filters with search without clearing selection", async () => {
  const processingAudio = {
    ...audioB,
    processingState: "running" as const,
  };
  const openAudio = vi.fn(async (audioId: number) =>
    workspace(audioId === audioA.audioId ? audioA : processingAudio),
  );
  render(
    <AudioRouteFeature
      api={api({
        listAudios: vi.fn(async () => [audioA, processingAudio, audioC]),
        openAudio,
      })}
      tasks={[
        {
          id: 22,
          audioId: processingAudio.audioId,
          displayName: processingAudio.displayName,
          state: "running",
          phase: "asr",
          progressFraction: 0.4,
          attempt: 1,
          errorCode: null,
        },
      ]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  const workspaceRegion = screen.getByRole("region", { name: "音频工作区" });
  expect(await within(workspaceRegion).findByText("音频 A.wav")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "处理中 1" }));
  expect(
    screen.queryByRole("button", { name: /打开 音频 A/ }),
  ).not.toBeInTheDocument();
  expect(within(workspaceRegion).getByText("音频 A.wav")).toBeVisible();
  expect(screen.getByRole("button", { name: /打开 音频 B/ })).toBeVisible();

  await user.type(screen.getByRole("searchbox", { name: "搜索音频" }), "C");
  expect(screen.getByText("没有匹配的音频")).toBeVisible();
  expect(within(workspaceRegion).getByText("音频 A.wav")).toBeVisible();
  await user.clear(screen.getByRole("searchbox", { name: "搜索音频" }));
  await user.click(screen.getByRole("button", { name: "全部 3" }));
  expect(screen.getByRole("button", { name: /打开 音频 A/ })).toBeVisible();
});

it.each([true, false])(
  "refreshes and selects the exact imported audio when inserted=%s",
  async (inserted) => {
    const listAudios = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([audioB]);
    const openAudio = vi.fn(async () => workspace(audioB));
    const onImport = vi.fn(async () => ({
      protocolVersion: 2 as const,
      state: "imported" as const,
      audioId: audioB.audioId,
      mediaSha256: "a".repeat(64),
      inserted,
    }));
    render(
      <AudioRouteFeature
        api={api({ listAudios, openAudio })}
        tasks={[]}
        pendingJobActions={new Map()}
        writable
        paneOpen
        onRecord={vi.fn()}
        onImport={onImport}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "导入音频" }));

    expect(
      await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
    ).toBeVisible();
    expect(listAudios).toHaveBeenCalledTimes(2);
    expect(openAudio).toHaveBeenCalledWith(audioB.audioId);
  },
);

it("waits for a trailing authoritative refresh when import overlaps a list request", async () => {
  const staleRefresh = deferred<AudioSummary[]>();
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([audioA])
    .mockImplementationOnce(() => staleRefresh.promise)
    .mockResolvedValueOnce([audioA, audioB]);
  const openAudio = vi.fn(async () => workspace(audioB));
  const onImport = vi.fn(async () => ({
    protocolVersion: 2 as const,
    state: "imported" as const,
    audioId: audioB.audioId,
    mediaSha256: "a".repeat(64),
    inserted: true,
  }));
  const props = {
    api: api({ listAudios, openAudio }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onRecord: vi.fn(),
    onImport,
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(
    <AudioRouteFeature {...props} libraryRefreshToken="ready:1" />,
  );
  await screen.findByRole("button", { name: /打开 音频 A/ });

  view.rerender(<AudioRouteFeature {...props} libraryRefreshToken="ready:2" />);
  await screen.findByText("正在刷新音频…");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "导入音频" }));
  await act(async () => staleRefresh.resolve([audioA]));

  expect(
    await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: /打开 音频 B/ })).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(3);
  expect(openAudio).toHaveBeenCalledWith(audioB.audioId);
});

it("keeps canceled imports in first-use and reports retryable failures there", async () => {
  const onImport = vi
    .fn()
    .mockResolvedValueOnce({ protocolVersion: 2, state: "canceled" })
    .mockRejectedValueOnce(new Error("raw /private/import failure"));
  const listAudios = vi.fn(async () => []);
  render(
    <AudioRouteFeature
      api={api({ listAudios })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={onImport}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "导入音频" }));
  expect(screen.getByText("开始你的第一段音频")).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "导入音频" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法导入音频，请重试。",
  );
  expect(screen.queryByText(/private\/import/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导入音频" })).toBeEnabled();
});

it("refreshes once when recording completes and never guesses an audio selection", async () => {
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([audioA]);
  const openAudio = vi.fn();
  const props = {
    api: api({ listAudios, openAudio }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(
    <AudioRouteFeature {...props} recordingCompletionToken={null} />,
  );
  expect(await screen.findByText("开始你的第一段音频")).toBeVisible();

  view.rerender(
    <AudioRouteFeature
      {...props}
      recordingCompletionToken="capture-session-1"
    />,
  );
  expect(await screen.findByText("选择一段音频")).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(2);
  expect(openAudio).not.toHaveBeenCalled();
  view.rerender(
    <AudioRouteFeature
      {...props}
      recordingCompletionToken="capture-session-1"
    />,
  );
  await waitFor(() => expect(listAudios).toHaveBeenCalledTimes(2));
});

it("queues an authoritative refresh when recording completes during a list request", async () => {
  const staleList = deferred<AudioSummary[]>();
  const listAudios = vi
    .fn()
    .mockImplementationOnce(() => staleList.promise)
    .mockResolvedValueOnce([audioA]);
  const props = {
    api: api({ listAudios }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(
    <AudioRouteFeature {...props} recordingCompletionToken={null} />,
  );
  await waitFor(() => expect(listAudios).toHaveBeenCalledOnce());

  view.rerender(
    <AudioRouteFeature
      {...props}
      recordingCompletionToken="capture-session-while-loading"
    />,
  );
  await act(async () => staleList.resolve([]));

  expect(await screen.findByText("选择一段音频")).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(2);
});

it("recovers first-use recording after a failed microphone preflight", async () => {
  const preflightCapture = vi
    .fn()
    .mockRejectedValueOnce(new Error("raw /private/microphone failure"))
    .mockResolvedValueOnce({
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "13.0",
      captureMode: "dual_track" as const,
      systemAudioPermission: "granted" as const,
      microphonePermission: "granted" as const,
      microphones: [
        { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
      ],
      availableBytes: 8 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    });
  renderFirstUseRoute(api({ preflightCapture }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("无法检查麦克风，请重试。");
  expect(screen.queryByText(/private\/microphone/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始录制" })).toBeDisabled();
  await userEvent
    .setup()
    .click(within(alert).getByRole("button", { name: "重试" }));

  expect(await screen.findByRole("button", { name: "开始录制" })).toBeEnabled();
  expect(preflightCapture).toHaveBeenNthCalledWith(2, {
    requestPermissions: true,
    captionEnabled: false,
  });
});

it("shows first-use preflight progress and keeps recording blocks effective", async () => {
  const preflight =
    deferred<Awaited<ReturnType<Voice2TextDesktopApi["preflightCapture"]>>>();
  const onRecord = vi.fn();
  render(
    <AudioRouteFeature
      api={firstUseApi({
        preflightCapture: vi.fn(() => preflight.promise),
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      newRecordingBlocked
      onRecord={onRecord}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  expect(
    await screen.findByRole("button", { name: "正在检查麦克风…" }),
  ).toBeDisabled();
  await act(async () =>
    preflight.resolve({
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "13.0",
      captureMode: "dual_track",
      systemAudioPermission: "granted",
      microphonePermission: "granted",
      microphones: [
        { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
      ],
      availableBytes: 8 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    }),
  );

  const start = await screen.findByRole("button", { name: "开始录制" });
  expect(start).toBeDisabled();
  await userEvent.setup().click(start);
  expect(onRecord).not.toHaveBeenCalled();
});

it("disables recording when no microphone is available", async () => {
  const onRecord = vi.fn();
  const desktop = firstUseApi({
    preflightCapture: vi.fn(async () => ({
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "13.0",
      captureMode: "system_audio_only" as const,
      systemAudioPermission: "granted" as const,
      microphonePermission: "denied" as const,
      microphones: [],
      availableBytes: 8 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    })),
  });
  render(
    <AudioRouteFeature
      api={desktop}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={onRecord}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const start = await screen.findByRole("button", { name: "开始录制" });
  expect(start).toBeDisabled();
  await userEvent.setup().click(start);
  expect(onRecord).not.toHaveBeenCalled();
});

it("uses the native capture lifecycle for a user-ended microphone test", async () => {
  const running = {
    testId: "mic-test-123456789012",
    state: "running" as const,
    elapsedMs: 1_000,
    normalizedRMS: 0.1,
    normalizedPeak: 0.5,
    observedFrames: 10,
    observedSound: true,
  };
  const startMicrophoneTest = vi.fn(async () => running);
  const finishMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "finished" as const,
    reason: "detected" as const,
  }));
  render(
    <AudioRouteFeature
      api={firstUseApi({ startMicrophoneTest, finishMicrophoneTest })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "测试麦克风" }));
  const testingDialog = await screen.findByRole("dialog", {
    name: "测试麦克风",
  });
  expect(
    within(testingDialog).queryByRole("button", { name: "开始测试" }),
  ).not.toBeInTheDocument();
  expect(within(testingDialog).getByRole("meter")).toHaveAttribute(
    "aria-valuenow",
    "67",
  );
  expect(testingDialog).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");
  expect(within(testingDialog).queryByRole("status")).not.toBeInTheDocument();
  await userEvent
    .setup()
    .click(within(testingDialog).getByRole("button", { name: "结束测试" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.queryByText("麦克风测试完成")).not.toBeInTheDocument();
  expect(startMicrophoneTest).toHaveBeenCalledWith({
    microphoneDeviceId: "mic-default",
  });
  expect(finishMicrophoneTest).toHaveBeenCalledWith(running.testId);
});

it("uses the persisted microphone for tests and recording", async () => {
  window.localStorage.setItem(
    RECORDING_PREFERENCE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      microphoneDeviceId: "mic-usb",
      microphoneName: "USB 麦克风",
    }),
  );
  const microphones = [
    { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
    { id: "mic-usb", name: "USB 麦克风", isDefault: false },
  ];
  const startMicrophoneTest = vi.fn(async () => ({
    testId: "mic-test-persisted-device",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  }));
  const onRecord = vi.fn();
  render(
    <AudioRouteFeature
      api={firstUseApi({
        preflightCapture: vi.fn(async () => ({
          minimumMacosVersion: "13.0",
          systemAudioMinimumMacosVersion: "13.0",
          captureMode: "dual_track" as const,
          systemAudioPermission: "granted" as const,
          microphonePermission: "granted" as const,
          microphones,
          availableBytes: 8 * 1024 ** 3,
          requiredBytes: 2 * 1024 ** 3,
          captionModelAvailable: true,
          canStart: true,
          blockingReasons: [],
        })),
        startMicrophoneTest,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={onRecord}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "测试麦克风" }));
  expect(startMicrophoneTest).toHaveBeenCalledWith({
    microphoneDeviceId: "mic-usb",
  });
  await userEvent.setup().click(screen.getByRole("button", { name: "关闭" }));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "开始录制" }));
  expect(onRecord).toHaveBeenCalledOnce();
});

it("smooths the RMS meter and throttles its maximum", async () => {
  const running = {
    testId: "mic-test-rms-envelope-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0.1,
    normalizedPeak: 0.9,
    observedFrames: 1_024,
    observedSound: true,
  };
  const snapshots = [
    { ...running, elapsedMs: 200, normalizedRMS: 0.2, normalizedPeak: 0 },
    { ...running, elapsedMs: 300, normalizedRMS: 0, normalizedPeak: 1 },
    { ...running, elapsedMs: 400, normalizedRMS: 0, normalizedPeak: 1 },
    { ...running, elapsedMs: 500, normalizedRMS: 0, normalizedPeak: 1 },
  ];
  const getMicrophoneTestSnapshot = vi
    .fn<Voice2TextDesktopApi["getMicrophoneTestSnapshot"]>()
    .mockImplementation(async () => snapshots.shift() ?? running);
  const startMicrophoneTest = vi.fn(async () => running);
  const cancelMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "cancelled" as const,
  }));

  renderFirstUseRoute(
    api({
      startMicrophoneTest,
      getMicrophoneTestSnapshot,
      cancelMicrophoneTest,
    }),
  );

  const trigger = await screen.findByRole("button", { name: "测试麦克风" });
  vi.useFakeTimers();
  try {
    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const dialog = screen.getByRole("dialog", { name: "测试麦克风" });
    const meter = within(dialog).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "67");
    expect(dialog).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce();
    expect(meter).toHaveAttribute("aria-valuenow", "77");
    expect(dialog).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "51");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "26");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(dialog).toHaveTextContent("已收到声音 · 最高输入电平 −14 dBFS");

    await act(async () => {
      within(dialog).getByRole("button", { name: "关闭" }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("button", { name: "测试麦克风" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(startMicrophoneTest).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("dialog", { name: "测试麦克风" }),
    ).toHaveTextContent("已收到声音 · 最高输入电平 −20 dBFS");
  } finally {
    vi.useRealTimers();
  }
});

it("keeps slow snapshots serial and releases by elapsed time", async () => {
  const running = {
    testId: "mic-test-slow-snapshot-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0.1,
    normalizedPeak: 0.9,
    observedFrames: 1_024,
    observedSound: true,
  };
  const slowSnapshot = deferred<typeof running>();
  const getMicrophoneTestSnapshot = vi
    .fn<Voice2TextDesktopApi["getMicrophoneTestSnapshot"]>()
    .mockImplementationOnce(() => slowSnapshot.promise)
    .mockImplementation(async () => ({
      ...running,
      elapsedMs: 700,
      normalizedRMS: 0,
    }));

  renderFirstUseRoute(
    api({
      startMicrophoneTest: vi.fn(async () => running),
      getMicrophoneTestSnapshot,
    }),
  );

  const trigger = await screen.findByRole("button", { name: "测试麦克风" });
  vi.useFakeTimers();
  try {
    await act(async () => {
      trigger.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const meter = within(screen.getByRole("dialog")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "67");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      slowSnapshot.resolve({
        ...running,
        elapsedMs: 600,
        normalizedRMS: 0,
      });
      await Promise.resolve();
    });
    expect(meter).toHaveAttribute("aria-valuenow", "0");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(99);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getMicrophoneTestSnapshot).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("shows one instruction before sound and starts only once on rapid activation", async () => {
  const running = {
    testId: "mic-test-rapid-start-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
  const startMicrophoneTest = vi.fn(async () => running);
  const pendingSnapshot = deferred<typeof running>();
  const desktop = firstUseApi({
    startMicrophoneTest,
    getMicrophoneTestSnapshot: vi.fn(() => pendingSnapshot.promise),
  });
  const preflightCapture = vi.mocked(desktop.preflightCapture);
  renderRoute(desktop);

  const trigger = await screen.findByRole("button", { name: "测试麦克风" });
  await waitFor(() => expect(trigger).toBeEnabled());
  preflightCapture.mockClear();
  act(() => {
    trigger.click();
    trigger.click();
  });

  const dialog = await screen.findByRole("dialog", { name: "测试麦克风" });
  await waitFor(() => expect(startMicrophoneTest).toHaveBeenCalledOnce());
  expect(preflightCapture).toHaveBeenCalledOnce();
  expect(dialog).toHaveTextContent("请对着麦克风说话。");
  expect(dialog).not.toHaveTextContent("暂未收到声音");
  expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: "开始测试" }),
  ).not.toBeInTheDocument();
});

it("cancels a late microphone start exactly once after the dialog closes", async () => {
  const pendingStart =
    deferred<
      Awaited<ReturnType<Voice2TextDesktopApi["startMicrophoneTest"]>>
    >();
  const cancelMicrophoneTest = vi.fn(async (testId: string) => ({
    testId,
    state: "cancelled" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  }));
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(() => pendingStart.promise),
        cancelMicrophoneTest,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));
  const starting = await screen.findByRole("dialog", {
    name: "测试麦克风",
  });
  expect(starting).toHaveTextContent("正在连接麦克风…");
  expect(
    within(starting).queryByRole("button", { name: "结束测试" }),
  ).not.toBeInTheDocument();
  await user.click(within(starting).getByRole("button", { name: "取消" }));
  expect(screen.getByRole("button", { name: "开始录制" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "测试麦克风" })).toBeDisabled();
  pendingStart.resolve({
    testId: "mic-test-late-start-123456",
    state: "running",
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  });
  await waitFor(() =>
    expect(cancelMicrophoneTest).toHaveBeenCalledWith(
      "mic-test-late-start-123456",
    ),
  );
  expect(cancelMicrophoneTest).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "测试麦克风" })).toBeEnabled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("cancels once and ignores a late running snapshot after closing during recovery", async () => {
  const running = {
    testId: "mic-test-recovery-close-123456",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
  const pendingRecovery = deferred<typeof running>();
  const cancelMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "cancelled" as const,
  }));
  const getMicrophoneTestSnapshot = vi.fn(() => pendingRecovery.promise);
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(async () => running),
        getMicrophoneTestSnapshot,
        cancelMicrophoneTest,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));
  const testing = await screen.findByRole("dialog", {
    name: "测试麦克风",
  });
  await waitFor(() => expect(getMicrophoneTestSnapshot).toHaveBeenCalledOnce());
  await user.click(within(testing).getByRole("button", { name: "关闭" }));
  pendingRecovery.resolve({
    ...running,
    elapsedMs: 500,
    normalizedPeak: 0.7,
    observedFrames: 4_096,
    observedSound: true,
  });

  await waitFor(() => expect(cancelMicrophoneTest).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("已收到声音")).not.toBeInTheDocument();
});

it("cancels an active microphone test exactly once when its owner unmounts", async () => {
  const running = {
    testId: "mic-test-unmount-123456789",
    state: "running" as const,
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
  const cancelMicrophoneTest = vi.fn(async () => ({
    ...running,
    state: "cancelled" as const,
  }));
  const view = renderFirstUseRoute(
    api({
      startMicrophoneTest: vi.fn(async () => running),
      cancelMicrophoneTest,
    }),
  );

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "测试麦克风" }));
  await screen.findByRole("dialog", { name: "测试麦克风" });
  view.unmount();

  await waitFor(() => expect(cancelMicrophoneTest).toHaveBeenCalledOnce());
});

it("shows helper contract failures with one close action and no settings affordance", async () => {
  const openMicrophoneSettings = vi.fn();
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(async () => ({
          testId: "mic-test-helper-mismatch-123456",
          state: "failed" as const,
          reason: "native-helper-failed" as const,
          elapsedMs: 0,
          normalizedRMS: 0,
          normalizedPeak: 0,
          observedFrames: 0,
          observedSound: false,
        })),
        openMicrophoneSettings,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));

  const failure = await screen.findByRole("dialog", {
    name: "麦克风测试失败",
  });
  expect(failure).toHaveTextContent("麦克风测试暂不可用，请重启应用。");
  expect(
    within(failure)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["知道了"]);
  expect(within(failure).getByRole("button", { name: "知道了" })).toBeVisible();
  expect(
    within(failure).queryByRole("button", { name: "前往麦克风设置" }),
  ).not.toBeInTheDocument();
  expect(openMicrophoneSettings).not.toHaveBeenCalled();
});

it("shows typed silence failure and the fixed settings fallback path", async () => {
  const running = {
    testId: "mic-test-silent-12345678",
    state: "running" as const,
    elapsedMs: 31_000,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 100,
    observedSound: false,
  };
  const openMicrophoneSettings = vi.fn(async () => ({
    state: "failed" as const,
  }));
  render(
    <AudioRouteFeature
      api={firstUseApi({
        startMicrophoneTest: vi.fn(async () => running),
        finishMicrophoneTest: vi.fn(async () => ({
          ...running,
          state: "finished" as const,
          reason: "no-sound-observed" as const,
        })),
        openMicrophoneSettings,
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "测试麦克风" }));
  await user.click(
    within(await screen.findByRole("dialog", { name: "测试麦克风" })).getByRole(
      "button",
      { name: "结束测试" },
    ),
  );
  const failure = await screen.findByRole("dialog", {
    name: "未检测到麦克风输入",
  });
  expect(failure).not.toHaveTextContent("31");
  await user.click(
    within(failure).getByRole("button", { name: "前往麦克风设置" }),
  );
  expect(
    await within(failure).findByText(
      "请手动前往：系统设置 → 隐私与安全 → 麦克风",
    ),
  ).toBeVisible();
  expect(openMicrophoneSettings).toHaveBeenCalledOnce();
  expect(
    within(failure).getByRole("button", { name: "前往麦克风设置" }),
  ).toBeVisible();
});

it("reports an unavailable microphone in a dialog", async () => {
  render(
    <AudioRouteFeature
      api={firstUseApi({
        preflightCapture: vi.fn(async () => ({
          minimumMacosVersion: "13.0",
          systemAudioMinimumMacosVersion: "13.0",
          captureMode: "system_audio_only" as const,
          systemAudioPermission: "granted" as const,
          microphonePermission: "denied" as const,
          microphones: [],
          availableBytes: 8 * 1024 ** 3,
          requiredBytes: 2 * 1024 ** 3,
          captionModelAvailable: true,
          canStart: true,
          blockingReasons: [],
        })),
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  const testMicrophone = await screen.findByRole("button", {
    name: "测试麦克风",
  });
  await waitFor(() => expect(testMicrophone).toBeEnabled());
  await userEvent.setup().click(testMicrophone);

  const dialog = await screen.findByRole("dialog", {
    name: "麦克风测试失败",
  });
  expect(
    within(dialog).getByRole("heading", { name: "麦克风测试失败" }),
  ).toBeVisible();
  expect(
    within(dialog).getAllByText("没有麦克风权限，请在系统设置中允许访问。"),
  ).toHaveLength(1);
  expect(
    within(dialog).getByRole("button", { name: "前往麦克风设置" }),
  ).toBeVisible();
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
      throw new Error("raw /private/audio-a playback failure");
    }
    return playback(audioId, command.action !== "close");
  });
  const desktop = api({ controlAudioPlayback });
  renderRoute(desktop);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("region", { name: "音频 A.wav 工作区" });
  await user.type(
    screen.getByRole("searchbox", { name: "搜索音频转写" }),
    "A 状态",
  );
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法切换音频，请重试",
  );
  expect(
    screen.getByRole("region", { name: "音频 A.wav 工作区" }),
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(
    await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
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
  await screen.findByRole("region", { name: "音频 A.wav 工作区" });
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  await user.click(screen.getByRole("button", { name: /打开 音频 C/ }));
  closeA.resolve(playback(1, false));

  expect(
    await screen.findByRole("region", { name: "音频 C.wav 工作区" }),
  ).toBeVisible();
  openB.resolve(workspace(audioB));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "音频 B.wav 工作区" }),
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
        throw new Error("raw /private/audio-b open failure");
      }
      return workspace([audioA, audioB, audioC][audioId - 1]!);
    }),
  });
  renderRoute(desktop);
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("region", { name: "音频 A.wav 工作区" });
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法打开音频");
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));

  expect(
    await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
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
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} tasks={[running]} />);

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("region", { name: "音频 A.wav 工作区" });
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
    .mockRejectedValueOnce(new Error("raw /private/library database failure"))
    .mockResolvedValueOnce([audioA]);
  renderRoute(api({ listAudios }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("无法载入音频列表");
  const retry = within(alert).getByRole("button", { name: "重新载入" });
  expect(retry).toBeEnabled();
  await userEvent.setup().click(retry);

  expect(
    await screen.findByRole("button", { name: /打开 音频 A/ }),
  ).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/private\/library/)).not.toBeInTheDocument();
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
    await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
  ).toBeVisible();

  await act(async () => {
    undoA.resolve({ ...workspace(audioA), revision: 2 });
    await undoA.promise;
  });
  expect(
    screen.queryByRole("region", { name: "音频 A.wav 工作区" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "音频 B.wav 工作区" }),
  ).toBeVisible();
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
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} tasks={[]} />);

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await screen.findByRole("region", { name: "音频 A.wav 工作区" });

  view.rerender(
    <AudioRouteFeature {...props} tasks={[processingTask("queued", 71)]} />,
  );

  await waitFor(() =>
    expect(desktop.controlAudioPlayback).toHaveBeenCalledWith(1, {
      action: "close",
    }),
  );
  expect(await screen.findByRole("button", { name: "开始录制" })).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "音频 A.wav 工作区" }),
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
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

function renderFirstUseRoute(desktop: Voice2TextDesktopApi) {
  return renderRoute(
    api({
      ...desktop,
      listAudios: vi.fn(async () => []),
    }),
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
    preflightCapture: vi.fn(async () => ({
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "13.0",
      captureMode: "dual_track" as const,
      systemAudioPermission: "granted" as const,
      microphonePermission: "granted" as const,
      microphones: [
        { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
      ],
      availableBytes: 8 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    })),
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

function firstUseApi(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return api({
    listAudios: vi.fn(async () => []),
    ...overrides,
  });
}
