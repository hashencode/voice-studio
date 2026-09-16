// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";

import { AudioRouteFeature } from "../../../src/renderer/features/audios/audio-route-feature";
import { DesktopFailure } from "../../../src/shared/contracts";
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

it("deletes a recording from its context menu after confirmation", async () => {
  const deleteAudio = vi.fn(async () => ({ deleted: true }));
  renderRoute(api({ deleteAudio }));

  const audio = await screen.findByRole("button", { name: /打开 音频 A/ });
  fireEvent.contextMenu(audio);
  await userEvent
    .setup()
    .click(await screen.findByRole("menuitem", { name: "删除" }));

  const dialog = await screen.findByRole("alertdialog", { name: "删除确认" });
  expect(dialog).toHaveTextContent(
    "“音频 A.wav”及其转写内容和 AI 总结将从资料库中移除，且无法恢复。",
  );
  expect(deleteAudio).not.toHaveBeenCalled();

  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "确认删除" }));

  await waitFor(() => expect(deleteAudio).toHaveBeenCalledWith(1));
  expect(
    screen.queryByRole("button", { name: /打开 音频 A/ }),
  ).not.toBeInTheDocument();
});

it("does not clear a newer live recording when an older delete resolves", async () => {
  const pendingDelete = deferred<{ deleted: boolean }>();
  const recorded = summary(9, "刚保存的录音.wav");
  const deleteAudio = vi.fn(() => pendingDelete.promise);
  const desktop = api({
    deleteAudio,
    openAudio: vi.fn(async (audioId) =>
      workspace(audioId === recorded.audioId ? recorded : audioA),
    ),
  });
  const props = {
    api: desktop,
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
    <AudioRouteFeature {...props} liveRegisteredAudio={null} />,
  );
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  fireEvent.contextMenu(screen.getByRole("button", { name: /打开 音频 A/ }));
  await user.click(await screen.findByRole("menuitem", { name: "删除" }));
  await user.click(
    within(
      await screen.findByRole("alertdialog", { name: "删除确认" }),
    ).getByRole("button", { name: "确认删除" }),
  );
  await waitFor(() => expect(deleteAudio).toHaveBeenCalledWith(audioA.audioId));

  view.rerender(
    <AudioRouteFeature
      {...props}
      liveRegisteredAudio={{ intentId: "live-9", audioId: recorded.audioId }}
    />,
  );
  await waitFor(() => expect(desktop.openAudio).toHaveBeenCalledWith(9));

  await act(async () => pendingDelete.resolve({ deleted: true }));

  expect(
    await screen.findByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).toBeVisible();
});

it("opens a live registered recording by id without waiting for the audio list", async () => {
  const list = deferred<AudioSummary[]>();
  const recorded = summary(9, "刚保存的录音.wav");
  const openAudio = vi.fn(async () => workspace(recorded));
  const listAudios = vi.fn(() => list.promise);
  render(
    <AudioRouteFeature
      api={api({ listAudios, openAudio })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      liveRegisteredAudio={{ intentId: "live-9", audioId: 9 }}
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  expect(
    await screen.findByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).toBeVisible();
  expect(openAudio).toHaveBeenCalledWith(9);
  expect(listAudios).toHaveBeenCalledTimes(1);
});

it("waits to consume a live registered recording until the audio route activates", async () => {
  const recorded = summary(9, "刚保存的录音.wav");
  const openAudio = vi.fn(async () => workspace(recorded));
  const props = {
    api: api({ listAudios: vi.fn(async () => []), openAudio }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    liveRegisteredAudio: { intentId: "live-9", audioId: 9 },
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} active={false} />);

  await act(async () => undefined);
  expect(openAudio).not.toHaveBeenCalled();

  view.rerender(<AudioRouteFeature {...props} active />);

  expect(
    await screen.findByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).toBeVisible();
  expect(openAudio).toHaveBeenCalledTimes(1);
  expect(openAudio).toHaveBeenCalledWith(9);
});

it("retries only direct open and consumes the same live intent once", async () => {
  const list = deferred<AudioSummary[]>();
  const recorded = summary(9, "刚保存的录音.wav");
  const openAudio = vi
    .fn()
    .mockRejectedValueOnce(new Error("open failed"))
    .mockResolvedValueOnce(workspace(recorded));
  const props = {
    api: api({ listAudios: vi.fn(() => list.promise), openAudio }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    liveRegisteredAudio: { intentId: "live-9", audioId: 9 },
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} />);

  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "重试打开音频" }));
  expect(
    await screen.findByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).toBeVisible();
  expect(openAudio).toHaveBeenCalledTimes(2);

  view.rerender(<AudioRouteFeature {...props} />);
  await act(async () => undefined);
  expect(openAudio).toHaveBeenCalledTimes(2);
});

it("does not finish a live auto-open after navigation leaves the audio route", async () => {
  const pendingOpen = deferred<AudioWorkspaceSnapshot | null>();
  const recorded = summary(9, "刚保存的录音.wav");
  const onAudioSelected = vi.fn();
  const openAudio = vi.fn(() => pendingOpen.promise);
  const props = {
    api: api({
      listAudios: vi.fn(async () => []),
      openAudio,
    }),
    tasks: [],
    pendingJobActions: new Map<number, never>(),
    writable: true,
    paneOpen: true,
    liveRegisteredAudio: { intentId: "live-9", audioId: 9 },
    onAudioSelected,
    onRecord: vi.fn(),
    onImport: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };
  const view = render(<AudioRouteFeature {...props} active />);
  await waitFor(() => expect(openAudio).toHaveBeenCalledWith(9));

  view.rerender(<AudioRouteFeature {...props} active={false} />);
  await act(async () => pendingOpen.resolve(workspace(recorded)));

  expect(onAudioSelected).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).not.toBeInTheDocument();
});

it("keeps a replacement auto-open protected from stale cancellation and list data", async () => {
  const list = deferred<AudioSummary[]>();
  const firstOpen = deferred<AudioWorkspaceSnapshot | null>();
  const replacementOpen = deferred<AudioWorkspaceSnapshot | null>();
  const first = summary(9, "第一段录音.wav");
  const replacement = summary(10, "替换录音.wav");
  const openAudio = vi.fn((audioId: number) =>
    audioId === first.audioId ? firstOpen.promise : replacementOpen.promise,
  );
  const props = {
    api: api({ listAudios: vi.fn(() => list.promise), openAudio }),
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
    <AudioRouteFeature
      {...props}
      liveRegisteredAudio={{ intentId: "live-9", audioId: first.audioId }}
    />,
  );
  await waitFor(() => expect(openAudio).toHaveBeenCalledWith(first.audioId));

  view.rerender(
    <AudioRouteFeature
      {...props}
      liveRegisteredAudio={{
        intentId: "live-10",
        audioId: replacement.audioId,
      }}
    />,
  );
  await waitFor(() =>
    expect(openAudio).toHaveBeenCalledWith(replacement.audioId),
  );

  await act(async () => firstOpen.resolve(workspace(first)));
  await act(async () => replacementOpen.resolve(workspace(replacement)));
  await act(async () => list.resolve([]));

  expect(
    screen.getByRole("region", { name: "替换录音.wav 工作区" }),
  ).toBeVisible();
});

it("clears a failed open when the matching live projection is replaced", async () => {
  const list = deferred<AudioSummary[]>();
  const props = {
    api: api({
      listAudios: vi.fn(() => list.promise),
      openAudio: vi.fn().mockRejectedValue(new Error("open failed")),
    }),
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
    <AudioRouteFeature
      {...props}
      liveRegisteredAudio={{ intentId: "live-old", audioId: 9 }}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "重试打开音频" }),
  ).toBeVisible();

  view.rerender(<AudioRouteFeature {...props} liveRegisteredAudio={null} />);

  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "重试打开音频" }),
    ).not.toBeInTheDocument(),
  );
});

it("keeps an opened recording visible when the independent list refresh fails", async () => {
  const list = deferred<AudioSummary[]>();
  const recorded = summary(9, "刚保存的录音.wav");
  render(
    <AudioRouteFeature
      api={api({
        listAudios: vi.fn(() => list.promise),
        openAudio: vi.fn(async () => workspace(recorded)),
      })}
      tasks={[]}
      pendingJobActions={new Map()}
      writable
      paneOpen
      liveRegisteredAudio={{ intentId: "live-9", audioId: 9 }}
      onRecord={vi.fn()}
      onImport={vi.fn()}
      onCancel={vi.fn()}
      onRetry={vi.fn()}
    />,
  );

  expect(
    await screen.findByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).toBeVisible();
  list.reject(new Error("list failed"));
  expect(
    await screen.findByRole("button", { name: "重新载入音频列表" }),
  ).toBeVisible();
  expect(
    screen.getByRole("region", { name: "刚保存的录音.wav 工作区" }),
  ).toBeVisible();
});

it("renders the authoritative first-use state only after an empty list succeeds", async () => {
  const onImport = vi.fn(async () => ({
    protocolVersion: 3 as const,
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
  const routeState = main.querySelector('[data-audio-first-use="frame"]');
  expect(routeState).toBeInTheDocument();
  const frame = routeState?.querySelector(
    '[data-slot="full-screen-empty-state"]',
  );
  expect(frame).toBeInTheDocument();
  expect(frame).not.toHaveAttribute("data-slot", "card");
  expect(frame?.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
  expect(
    frame?.querySelector('[data-slot="full-screen-empty-state-content"]'),
  ).toBeInTheDocument();
  expect(frame?.querySelector("svg.lucide-audio-lines")).not.toBeNull();
  const preview = frame?.querySelector(
    '[data-slot="full-screen-empty-state-preview"]',
  );
  expect(preview).toHaveAttribute("aria-hidden", "true");
  expect(
    preview?.querySelector(
      '[data-slot="full-screen-empty-state-preview-surface"]',
    ),
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
    name: "导入外部音频",
  });
  expect(importButton.querySelector("svg")).not.toBeInTheDocument();
  await user.click(importButton);
  expect(onImport).toHaveBeenCalledOnce();
  expect(
    within(main).queryByRole("combobox", { name: "麦克风" }),
  ).not.toBeInTheDocument();
  expect(within(main).getByRole("button", { name: "开始录制" })).toBeVisible();
  expect(
    within(main).queryByRole("button", { name: "测试麦克风" }),
  ).not.toBeInTheDocument();
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
  expect(screen.getByRole("button", { name: "导入外部音频" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "测试麦克风" }),
  ).not.toBeInTheDocument();
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
  expect(screen.getByRole("button", { name: "导入外部音频" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "测试麦克风" }),
  ).not.toBeInTheDocument();
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
    .click(screen.getByRole("button", { name: "导入外部音频" }));
  expect(onProcessingUnavailable).not.toHaveBeenCalled();
  expect(onImport).toHaveBeenCalledOnce();
});

it("creates processing only after the user explicitly starts transcription", async () => {
  const startTranscription = vi.fn(async (audioId: number) => ({
    protocolVersion: 3 as const,
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
  const transcriptPanel = screen.getByRole("tabpanel", { name: "转写文本" });
  const description =
    within(transcriptPanel).getByText("当前音频尚未转写成文本");
  const localEmpty = description.closest<HTMLElement>(
    '[data-slot="empty-state"]',
  )!;
  expect(
    description.closest('[data-slot="full-screen-empty-state"]'),
  ).toBeNull();
  expect(localEmpty).toBeVisible();
  expect(
    localEmpty.querySelectorAll('[data-slot="empty-state-cube"]'),
  ).toHaveLength(3);
  expect(within(localEmpty).queryByRole("heading")).toBeNull();
  expect(
    within(transcriptPanel).getByRole("button", { name: "开始转写" }),
  ).toBeVisible();
  await userEvent.setup().click(screen.getByRole("tab", { name: "AI 总结" }));
  expect(description).not.toBeVisible();
  await userEvent.setup().click(screen.getByRole("tab", { name: "转写文本" }));
  expect(startTranscription).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "开始转写" }));
  expect(startTranscription).toHaveBeenCalledWith(audioA.audioId);
});

it("routes processing capability failures without exposing diagnostics", async () => {
  const rawDiagnostic = "本地转写不可用：模型 /private/models/asr.bin 缺失";
  const failure = new DesktopFailure({
    protocolVersion: 3,
    domain: "local-model",
    code: "MODEL_BUSY",
    retryable: true,
    fallback: "try-again",
  });
  failure.message = rawDiagnostic;
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
          throw failure;
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

it("places import and recording actions in the audio pane footer", async () => {
  const onImport = vi.fn(async () => undefined);
  const onRecord = vi.fn();
  render(
    <AudioRouteFeature
      api={api()}
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

  await screen.findByRole("button", { name: /打开 音频 A/ });
  const pane = screen.getByRole("region", { name: "音频列表" });
  const footer = pane.querySelector<HTMLElement>(
    "[data-audio-context-footer]",
  )!;
  const importButton = within(footer).getByRole("button", {
    name: "导入音频",
  });
  const recordButton = within(footer).getByRole("button", { name: "新录音" });

  expect(footer).toBeVisible();
  expect(importButton).toHaveAttribute("data-size", "icon");
  expect(importButton.querySelector("svg")).toHaveClass("lucide-file-music");
  expect(recordButton).toHaveTextContent("开始新录音");
  expect(within(pane).getByRole("button", { name: "显示音频搜索" })).not.toBe(
    importButton,
  );

  await userEvent.setup().click(importButton);
  expect(onImport).toHaveBeenCalledOnce();
  await waitFor(() => expect(recordButton).toBeEnabled());
  await userEvent.setup().click(recordButton);
  expect(onRecord).toHaveBeenCalledOnce();
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
    screen.queryByRole("button", { name: "导入外部音频" }),
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
    screen.queryByRole("button", { name: "导入外部音频" }),
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

  await screen.findByRole("button", { name: /打开 音频 A/ });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "显示音频搜索" }));
  const search = screen.getByRole("searchbox", { name: "搜索音频" });
  const populatedImport = screen.getByRole("button", { name: "导入音频" });
  expect(populatedImport.querySelector("svg")).toBeInTheDocument();
  const selectionPrompt = within(
    screen.getByRole("region", { name: "音频工作区" }),
  )
    .getByText("请选择左侧音频")
    .closest<HTMLElement>('[data-slot="empty-state"]')!;
  expect(selectionPrompt).toBeVisible();
  expect(selectionPrompt).toHaveAttribute("data-slot", "empty-state");
  expect(
    within(selectionPrompt).queryByRole("heading"),
  ).not.toBeInTheDocument();
  expect(
    selectionPrompt.querySelectorAll(
      '[data-slot="empty-state-graphic"] [data-slot="empty-state-cube"]',
    ),
  ).toHaveLength(3);
  expect(
    selectionPrompt.querySelector(
      '[data-slot="full-screen-empty-state-preview"]',
    ),
  ).not.toBeInTheDocument();
  expect(selectionPrompt).toHaveTextContent("请选择左侧音频");
  expect(
    screen
      .getByRole("region", { name: "音频工作区" })
      .querySelector('[data-audio-first-use="frame"]'),
  ).not.toBeInTheDocument();
  view.rerender(<AudioRouteFeature {...props} libraryRefreshToken="ready:2" />);
  expect(await screen.findByText("正在刷新音频…")).toBeVisible();
  expect(search).toBeVisible();
  expect(selectionPrompt).toBeVisible();

  await act(async () => refresh.resolve([audioA]));
  await userEvent.setup().type(search, "不存在");
  const filteredEmpty = screen
    .getByText("没有匹配的音频")
    .closest<HTMLElement>('[data-slot="empty-state"]')!;
  expect(filteredEmpty).toBeVisible();
  expect(
    filteredEmpty.querySelectorAll('[data-slot="empty-state-cube"]'),
  ).toHaveLength(3);
  expect(within(filteredEmpty).queryByRole("heading")).toBeNull();
  expect(selectionPrompt).toBeVisible();
});

it("persists only the audio search visibility preference", async () => {
  const desktop = api({ listAudios: vi.fn(async () => [audioA]) });
  const first = renderRoute(desktop);
  await screen.findByRole("button", { name: /打开 音频 A/ });

  expect(screen.queryByRole("searchbox", { name: "搜索音频" })).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "显示音频搜索" }));
  expect(screen.getByRole("searchbox", { name: "搜索音频" })).toBeVisible();

  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "筛选音频：全部" }));
  await userEvent
    .setup()
    .click(await screen.findByRole("menuitemradio", { name: "已转写 1" }));
  expect(
    screen.getByRole("button", { name: "筛选音频：已转写" }),
  ).toBeVisible();

  first.unmount();
  renderRoute(desktop);
  await screen.findByRole("button", { name: /打开 音频 A/ });
  expect(screen.getByRole("searchbox", { name: "搜索音频" })).toBeVisible();
  expect(screen.getByRole("button", { name: "筛选音频：全部" })).toBeVisible();
});

it("updates one background-refresh toast and dismisses it after success", async () => {
  const toastError = vi.spyOn(toast, "error");
  const toastDismiss = vi.spyOn(toast, "dismiss");
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([audioA])
    .mockRejectedValueOnce(new Error("localized refresh failure"))
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
    <AudioRouteFeature {...props} libraryRefreshToken="ready:1" />,
  );
  await screen.findByRole("button", { name: /打开 音频 A/ });

  view.rerender(<AudioRouteFeature {...props} libraryRefreshToken="ready:2" />);
  await waitFor(() =>
    expect(toastError).toHaveBeenCalledWith(
      "无法刷新音频列表，仍显示上次内容。",
      { id: "audio-library-refresh" },
    ),
  );
  expect(screen.getByRole("button", { name: /打开 音频 A/ })).toBeVisible();

  view.rerender(<AudioRouteFeature {...props} libraryRefreshToken="ready:3" />);
  await waitFor(() =>
    expect(toastDismiss).toHaveBeenCalledWith("audio-library-refresh"),
  );
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
      protocolVersion: 3 as const,
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
      .click(await screen.findByRole("button", { name: "导入外部音频" }));

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
    protocolVersion: 3 as const,
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
    .mockResolvedValueOnce({ protocolVersion: 3, state: "canceled" })
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
  await user.click(await screen.findByRole("button", { name: "导入外部音频" }));
  expect(screen.getByText("开始你的第一段音频")).toBeVisible();
  expect(listAudios).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "导入外部音频" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法导入音频，请重试。",
  );
  expect(screen.queryByText(/private\/import/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "导入外部音频" })).toBeEnabled();
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
  const selectionPrompt = (
    await screen.findByText("请选择左侧音频")
  ).closest<HTMLElement>('[data-slot="empty-state"]')!;
  expect(selectionPrompt).toBeVisible();
  expect(
    selectionPrompt.querySelectorAll(
      '[data-slot="empty-state-graphic"] [data-slot="empty-state-cube"]',
    ),
  ).toHaveLength(3);
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

  expect(await screen.findByText("请选择左侧音频")).toBeVisible();
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

it("filters Audio summaries into the five transcription states", async () => {
  const states = [
    "queued",
    "running",
    "canceling",
    "failed",
    "interrupted",
    "canceled",
  ] as const;
  const audios = [
    ...states.map((_, index) => summary(index + 1, `音频 ${index + 1}.wav`)),
    {
      ...summary(7, "音频 7.wav"),
      processingState: "not-started" as const,
    },
    summary(8, "音频 8.wav"),
    {
      ...summary(9, "音频 9.wav"),
      processingState: "partial-success" as const,
    },
  ];
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

  const firstRow = await screen.findByRole("button", { name: /打开 音频 1/ });
  expect(firstRow).toHaveAttribute("data-variant", "context");
  expect(firstRow).not.toHaveTextContent("个片段");
  expect(firstRow).not.toHaveTextContent("等待处理");
  expect(screen.queryByRole("button", { name: "全部 9" })).toBeNull();
  expect(screen.queryByRole("button", { name: "筛选音频：全部" })).toBeNull();
  expect(screen.queryByRole("searchbox", { name: "搜索音频" })).toBeNull();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "显示音频搜索" }));
  const search = screen.getByRole("searchbox", { name: "搜索音频" });
  expect(search).toHaveAttribute("data-variant", "context-search");
  expect(search).toHaveClass("h-8");
  expect(search).toHaveFocus();
  expect(
    window.localStorage.getItem("voice2text.audio.context-search-visible.v1"),
  ).toBe("true");
  const filterButton = screen.getByRole("button", {
    name: "筛选音频：全部",
  });
  const searchTools = search.closest('[data-slot="button-group"]');
  expect(searchTools).toContainElement(filterButton);
  expect(searchTools).toHaveClass("w-full");
  expect(filterButton).toHaveClass("h-8");
  expect(filterButton.querySelector("svg")).toBeNull();
  await userEvent.setup().click(filterButton);
  expect(
    await screen.findByRole("menuitemradio", { name: "全部 9" }),
  ).toHaveAttribute("data-state", "checked");
  expect(screen.getByRole("menuitemradio", { name: "待转写 1" })).toBeVisible();
  expect(screen.getByRole("menuitemradio", { name: "转写中 3" })).toBeVisible();
  expect(screen.getByRole("menuitemradio", { name: "已转写 1" })).toBeVisible();
  expect(screen.getByRole("menuitemradio", { name: "异常 4" })).toBeVisible();
  await userEvent.setup().keyboard("{Escape}");
  for (const label of [
    "等待处理",
    "正在处理",
    "正在取消",
    "处理失败",
    "已中断",
    "已取消",
  ]) {
    expect(screen.queryByText(label, { selector: "span" })).toBeNull();
  }
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
  await user.click(screen.getByRole("button", { name: "搜索转写" }));
  await user.type(
    screen.getByRole("searchbox", { name: "搜索音频转写" }),
    "A 状态",
  );
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(
    await screen.findByRole("dialog", { name: "音频操作未完成" }),
  ).toHaveTextContent("无法切换音频，请重试");
  expect(
    screen.getByRole("region", {
      name: "音频 A.wav 工作区",
      hidden: true,
    }),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "知道了" }));
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));
  expect(
    await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "搜索转写" }));
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
  expect(
    await screen.findByRole("dialog", { name: "音频操作未完成" }),
  ).toHaveTextContent("无法打开音频");
  await user.click(screen.getByRole("button", { name: "知道了" }));
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

it("serializes rapid title and description saves without dropping the trailing draft", async () => {
  const firstSave = deferred<AudioWorkspaceSnapshot>();
  const secondSave = deferred<AudioWorkspaceSnapshot>();
  const updateAudioMetadata = vi
    .fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockImplementationOnce(() => secondSave.promise);
  renderRoute(api({ updateAudioMetadata }));
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const title = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(title);
  await user.type(title, "发布复盘");
  await user.click(screen.getByRole("button", { name: "编辑音频描述" }));
  await waitFor(() =>
    expect(updateAudioMetadata).toHaveBeenNthCalledWith(1, {
      audioId: 1,
      title: "发布复盘",
      expectedRevision: 1,
    }),
  );

  await user.type(
    screen.getByRole("textbox", { name: "音频描述" }),
    "跟进发布准备",
  );
  await user.click(screen.getByRole("tab", { name: "AI 总结" }));
  expect(updateAudioMetadata).toHaveBeenCalledTimes(1);

  await act(async () => {
    firstSave.resolve({
      ...workspace(audioA),
      revision: 2,
      summary: { ...audioA, displayName: "发布复盘" },
    });
    await firstSave.promise;
  });
  await waitFor(() =>
    expect(updateAudioMetadata).toHaveBeenNthCalledWith(2, {
      audioId: 1,
      description: "跟进发布准备",
      expectedRevision: 2,
    }),
  );

  await act(async () => {
    secondSave.resolve({
      ...workspace({ ...audioA, displayName: "发布复盘" }),
      revision: 3,
      description: "跟进发布准备",
    });
    await secondSave.promise;
  });
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent("发布复盘");
});

it("persists a same-field restoration queued behind an in-flight save", async () => {
  const firstSave = deferred<AudioWorkspaceSnapshot>();
  const restoringSave = deferred<AudioWorkspaceSnapshot>();
  const updateAudioMetadata = vi
    .fn()
    .mockImplementationOnce(() => firstSave.promise)
    .mockImplementationOnce(() => restoringSave.promise);
  renderRoute(api({ updateAudioMetadata }));
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  let title = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(title);
  await user.type(title, "临时标题");
  await user.tab();
  await waitFor(() => expect(updateAudioMetadata).toHaveBeenCalledTimes(1));

  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  title = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(title);
  await user.type(title, audioA.displayName);
  await user.tab();
  expect(updateAudioMetadata).toHaveBeenCalledTimes(1);

  await act(async () => {
    firstSave.resolve({
      ...workspace({ ...audioA, displayName: "临时标题" }),
      revision: 2,
    });
    await firstSave.promise;
  });
  await waitFor(() =>
    expect(updateAudioMetadata).toHaveBeenNthCalledWith(2, {
      audioId: audioA.audioId,
      title: audioA.displayName,
      expectedRevision: 2,
    }),
  );

  await act(async () => {
    restoringSave.resolve({ ...workspace(audioA), revision: 3 });
    await restoringSave.promise;
  });
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent(audioA.displayName);
  expect(
    screen.getByRole("button", { name: `打开 ${audioA.displayName}` }),
  ).toBeVisible();
});

it("rebases a metadata save once after a workspace conflict", async () => {
  const conflict = new DesktopFailure({
    protocolVersion: 3,
    domain: "audio-workspace",
    code: "WORKSPACE_CONFLICT",
    retryable: true,
    fallback: "try-again",
  });
  const openAudio = vi
    .fn()
    .mockResolvedValueOnce(workspace(audioA))
    .mockResolvedValueOnce({ ...workspace(audioA), revision: 4 });
  const updateAudioMetadata = vi
    .fn()
    .mockRejectedValueOnce(conflict)
    .mockResolvedValueOnce({
      ...workspace({ ...audioA, displayName: "冲突后标题" }),
      revision: 5,
    });
  renderRoute(api({ openAudio, updateAudioMetadata }));
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const title = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(title);
  await user.type(title, "冲突后标题");
  await user.tab();

  await waitFor(() => expect(updateAudioMetadata).toHaveBeenCalledTimes(2));
  expect(updateAudioMetadata).toHaveBeenNthCalledWith(1, {
    audioId: 1,
    title: "冲突后标题",
    expectedRevision: 1,
  });
  expect(updateAudioMetadata).toHaveBeenNthCalledWith(2, {
    audioId: 1,
    title: "冲突后标题",
    expectedRevision: 4,
  });
  expect(openAudio).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent("冲突后标题");
});

it("discards a failed metadata draft while allowing an audio switch", async () => {
  const updateAudioMetadata = vi.fn(async () => {
    throw new Error("metadata unavailable");
  });
  renderRoute(api({ updateAudioMetadata }));
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const title = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(title);
  await user.type(title, "未保存标题");
  await user.click(screen.getByRole("button", { name: /打开 音频 B/ }));

  expect(
    await screen.findByRole("region", { name: "音频 B.wav 工作区" }),
  ).toBeVisible();
  expect(updateAudioMetadata).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "音频操作未完成" })).toBeNull();
});

it("keeps a confirmed title projected while an authoritative list refresh is stale", async () => {
  const staleRefresh = deferred<AudioSummary[]>();
  const listAudios = vi
    .fn()
    .mockResolvedValueOnce([audioA, audioB, audioC])
    .mockImplementationOnce(() => staleRefresh.promise);
  const updateAudioMetadata = vi.fn(async () => ({
    ...workspace({ ...audioA, displayName: "发布复盘" }),
    revision: 2,
  }));
  renderRoute(api({ listAudios, updateAudioMetadata }));
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /打开 音频 A/ }));
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const title = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(title);
  await user.type(title, "发布复盘");
  await user.click(screen.getByRole("tab", { name: "AI 总结" }));

  expect(
    await screen.findByRole("button", { name: "打开 发布复盘" }),
  ).toBeVisible();
  await waitFor(() => expect(listAudios).toHaveBeenCalledTimes(2));
  await act(async () => {
    staleRefresh.resolve([audioA, audioB, audioC]);
    await staleRefresh.promise;
  });
  expect(screen.getByRole("button", { name: "打开 发布复盘" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "打开 音频 A.wav" })).toBeNull();
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
    description: "",
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
