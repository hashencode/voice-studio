// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { expect, it, vi } from "vitest";

import {
  AudioDetailWorkspace,
  AudioWorkspaceFeature,
} from "../../../src/renderer/features/audios/audio-workspace-feature";
import type {
  AudioAiSnapshot,
  AudioWorkspaceSnapshot,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const snapshot: AudioWorkspaceSnapshot = {
  revision: 3,
  summary: {
    audioId: 4,
    displayName: "项目周会.wav",
    durationMs: 6_000,
    createdAtMs: 1,
    processingState: "completed",
    generationId: 9,
    generationKind: "formal",
    segmentCount: 3,
  },
  description: "",
  segments: [
    {
      id: 11,
      stableKey: "0:0:1500",
      sequenceId: 0,
      text: "确认下周发布。",
      machineText: "确认下周发布。",
      startMs: 0,
      endMs: 1_500,
      reviewState: "unreviewed",
      speakerState: "assigned",
      speakerId: 7,
      speakerName: "说话人 1",
      speakerSource: "machine",
    },
    {
      id: 12,
      stableKey: "1:1500:3000",
      sequenceId: 1,
      text: "我会准备发布清单。",
      machineText: "我会准备发布清单。",
      startMs: 1_500,
      endMs: 3_000,
      reviewState: "unreviewed",
      speakerState: "unknown",
      speakerId: null,
      speakerName: null,
      speakerSource: "machine",
    },
    {
      id: 13,
      stableKey: "2:3000:5000",
      sequenceId: 2,
      text: "好的。",
      machineText: "好的。",
      startMs: 3_000,
      endMs: 5_000,
      reviewState: "unreviewed",
      speakerState: "overlap",
      speakerId: null,
      speakerName: null,
      speakerSource: "machine",
    },
  ],
  speakers: [
    {
      id: 7,
      stableKey: "speaker-a",
      displayName: "说话人 1",
      source: "machine",
      mergedIntoSpeakerId: null,
    },
  ],
  canUndo: true,
  canRedo: false,
};

const completedAi: AudioAiSnapshot = {
  revision: 1,
  jobId: 41,
  audioId: 4,
  generationId: 9,
  providerDisplayName: "团队模型",
  providerId: "deepseek",
  modelId: "deepseek-chat",
  endpointOrigin: "https://api.deepseek.com",
  endpointIdentitySha256: "c".repeat(64),
  transcriptScopeSha256: "a".repeat(64),
  attempt: 0,
  state: "completed",
  errorCode: null,
  note: {
    noteId: 71,
    schemaVersion: "audio_intelligence_output/v1",
    suggestedTitle: "发布复盘",
    audioType: "weekly",
    items: [
      {
        insightId: 81,
        kind: "unrecognized-kind",
        body: "准备发布清单",
        evidence: [{ segmentId: 12, startMs: 1_500, endMs: 3_000 }],
        actionOwner: "主持人",
        actionDueAtMs: Date.UTC(2026, 8, 20),
      },
    ],
  },
};

function api(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return {
    getAudioAiSnapshot: vi.fn(async () => null),
    prepareAudioAi: vi.fn(),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => [snapshot.summary]),
    openAudio: vi.fn(async () => snapshot),
    searchTranscript: vi.fn(async () => [snapshot.segments[0]!]),
    editAudioSegment: vi.fn(async () => ({ ...snapshot, revision: 4 })),
    updateAudioMetadata: vi.fn(async (command) => ({
      ...snapshot,
      revision: 4,
      description: command.description ?? snapshot.description,
      summary: {
        ...snapshot.summary,
        displayName: command.title || snapshot.summary.displayName,
      },
    })),
    undoAudioEdit: vi.fn(async () => snapshot),
    redoAudioEdit: vi.fn(async () => snapshot),
    renameAudioSpeaker: vi.fn(async () => snapshot),
    mergeAudioSpeakers: vi.fn(async () => snapshot),
    assignAudioSpeaker: vi.fn(async () => snapshot),
    controlAudioPlayback: vi.fn(async () => ({
      audioId: 4,
      initialized: true,
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    })),
    exportAudio: vi.fn(async () => ({
      state: "saved",
      fileName: "项目周会.wav.txt",
    })),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}

it("supports keyboard open, search, edit, playback, speaker and contextual feedback", async () => {
  const desktop = api();
  const toastSuccess = vi.spyOn(toast, "success");
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);

  const audio = await screen.findByRole("button", { name: /打开 项目周会/ });
  audio.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("region", { name: "项目周会.wav 工作区" }),
  ).toBeVisible();
  expect(screen.getByRole("tab", { name: "转写文本" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("region", { name: "音频播放器" })).toBeVisible();
  expect(screen.queryByRole("status", { name: "音频工作区状态" })).toBeNull();
  expect(screen.queryByRole("searchbox", { name: "搜索音频转写" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "搜索转写" }));

  await user.type(
    screen.getByRole("searchbox", { name: "搜索音频转写" }),
    "发布",
  );
  await user.keyboard("{Enter}");
  expect(desktop.searchTranscript).toHaveBeenCalledWith(4, "发布");
  expect(
    await screen.findByRole("group", { name: "搜索结果导航" }),
  ).toHaveTextContent("搜索结果 1 / 1，片段 1");

  const row = screen.getByRole("listitem", { name: /00:00 说话人 1/ });
  await user.click(within(row).getByRole("button", { name: "编辑片段 1" }));
  const editor = within(row).getByRole("textbox", { name: "片段 1 文本" });
  expect(editor).toHaveAttribute("data-slot", "textarea");
  await user.clear(editor);
  await user.type(editor, "修订：确认下周发布。");
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(desktop.editAudioSegment).toHaveBeenCalled());

  await user.click(screen.getByRole("button", { name: "播放音频" }));
  const position = screen.getByRole("slider", { name: "音频播放位置" });
  expect(position).toHaveAttribute("aria-valuetext", "00:00");
  expect(position).toHaveAttribute("aria-valuemin", "0");
  expect(position).toHaveAttribute("aria-valuemax", "6000");
  expect(position).toHaveAttribute("aria-valuenow", "0");
  position.focus();
  await user.keyboard("{ArrowRight}");
  expect(desktop.controlAudioPlayback).toHaveBeenCalledWith(4, {
    action: "seek",
    positionMs: 1,
  });
  await selectRadixOption(user, "播放速度", "1.5×");
  await user.click(screen.getByRole("button", { name: "导出" }));
  await user.click(screen.getByRole("menuitem", { name: "TXT" }));
  expect(desktop.controlAudioPlayback).toHaveBeenCalledWith(4, {
    action: "play",
  });
  expect(desktop.controlAudioPlayback).toHaveBeenCalledWith(4, {
    action: "speed",
    speed: 1.5,
  });
  expect(desktop.exportAudio).toHaveBeenCalledWith(4, "txt");
  expect(toastSuccess).toHaveBeenCalledWith("已导出 项目周会.wav.txt", {
    id: "audio-export",
  });

  const name = screen.getByRole("textbox", { name: "说话人 1 名称" });
  await user.clear(name);
  await user.type(name, "主持人");
  await user.click(screen.getByRole("button", { name: "重命名" }));
  expect(desktop.renameAudioSpeaker).toHaveBeenCalledWith(
    expect.objectContaining({ speakerId: 7, name: "主持人" }),
  );

  await selectRadixOption(user, "片段 2 说话人", "说话人 1");
  expect(desktop.assignAudioSpeaker).toHaveBeenCalledWith(
    expect.objectContaining({ segmentId: 12, state: "assigned", speakerId: 7 }),
  );

  await user.click(screen.getByRole("button", { name: "返回音频列表" }));
  const restoredAudio = await screen.findByRole("button", {
    name: /打开 项目周会/,
  });
  await waitFor(() => expect(restoredAudio).toHaveFocus());
});

it("reports an empty transcript search through the message channel", async () => {
  const toastInfo = vi.spyOn(toast, "info");
  const desktop = api({ searchTranscript: vi.fn(async () => []) });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);

  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "搜索转写" }));
  await user.type(
    screen.getByRole("searchbox", { name: "搜索音频转写" }),
    "不存在的内容",
  );
  await user.keyboard("{Enter}");

  await waitFor(() =>
    expect(toastInfo).toHaveBeenCalledWith("没有找到匹配片段", {
      id: "audio-transcript-search",
    }),
  );
  expect(screen.queryByRole("group", { name: "搜索结果导航" })).toBeNull();
  expect(screen.queryByRole("status", { name: "音频工作区状态" })).toBeNull();
});

it("edits metadata and exposes summary and knowledge as tabs", async () => {
  const desktop = api();
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  expect(screen.queryByRole("textbox", { name: "音频标题" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent("项目周会.wav");
  expect(
    screen.getByRole("button", { name: "编辑音频描述" }),
  ).toHaveTextContent("添加描述");
  expect(screen.queryByRole("button", { name: "更多" })).toBeNull();
  expect(screen.queryByRole("button", { name: "撤销" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const title = screen.getByRole("textbox", { name: "音频标题" });
  expect(title.tagName).toBe("SPAN");
  expect(title).toHaveAttribute("contenteditable", "true");
  expect(title).toHaveAttribute("data-plaintext-only", "true");
  expect(title).not.toHaveClass("py-1");
  expect(title).not.toHaveClass("focus-visible:ring-1");
  await user.clear(title);
  await user.type(title, "发布复盘");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(desktop.updateAudioMetadata).toHaveBeenCalledWith({
      audioId: 4,
      title: "发布复盘",
      expectedRevision: 3,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "编辑音频标题" })).toHaveFocus(),
  );
  expect(screen.getByRole("button", { name: "编辑音频标题" })).toHaveClass(
    "focus-visible:underline",
    "focus-visible:underline-offset-2",
  );
  expect(screen.getByRole("button", { name: "编辑音频标题" })).not.toHaveClass(
    "focus-visible:ring-1",
    "focus-visible:bg-accent",
  );
  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  await user.type(screen.getByRole("textbox", { name: "音频标题" }), "不保存");
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent("发布复盘");
  expect(screen.getByRole("button", { name: "编辑音频标题" })).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "编辑音频描述" }));
  const description = screen.getByRole("textbox", { name: "音频描述" });
  expect(description.tagName).toBe("SPAN");
  expect(description).toHaveAttribute("contenteditable", "true");
  expect(description).toHaveAttribute("data-plaintext-only", "true");
  expect(description).not.toHaveClass("focus-visible:ring-1");
  await user.type(description, " 保留边界");
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  await waitFor(() =>
    expect(desktop.updateAudioMetadata).toHaveBeenCalledWith({
      audioId: 4,
      description: " 保留边界",
      expectedRevision: 4,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "编辑音频描述" })).toHaveFocus(),
  );

  await user.click(screen.getByRole("tab", { name: "AI 总结" }));
  expect(screen.getByRole("tabpanel", { name: "AI 总结" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "知识库" }));
  const knowledgeEmpty = screen
    .getByText("知识库即将推出，之后可以在这里检索与当前音频相关的内容。")
    .closest<HTMLElement>('[data-slot="empty-state"]')!;
  expect(knowledgeEmpty).toBeVisible();
  expect(
    knowledgeEmpty.querySelectorAll('[data-slot="empty-state-cube"]'),
  ).toHaveLength(3);
  expect(within(knowledgeEmpty).queryByRole("heading")).toBeNull();
  expect(screen.getByRole("region", { name: "音频播放器" })).toBeVisible();

  expect(
    screen.getByRole("tab", { name: "转写文本" }).querySelector("svg"),
  ).toHaveClass("lucide-message-square-text");
  expect(
    screen.getByRole("tab", { name: "AI 总结" }).querySelector("svg"),
  ).toHaveClass("lucide-astroid");
  expect(
    screen.getByRole("tab", { name: "知识库" }).querySelector("svg"),
  ).toHaveClass("lucide-hard-drive");
});

it("keeps the active inline draft when an earlier metadata save resolves", async () => {
  let resolveSave!: (value: AudioWorkspaceSnapshot) => void;
  const savePromise = new Promise<AudioWorkspaceSnapshot>((resolve) => {
    resolveSave = resolve;
  });
  const onSaveMetadata = vi.fn(() => savePromise);
  const user = userEvent.setup();
  render(
    <AudioDetailWorkspace
      api={api()}
      workspace={snapshot}
      routePending={false}
      onWorkspaceChange={() => undefined}
      onSaveMetadata={onSaveMetadata}
    />,
  );

  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const firstEditor = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(firstEditor);
  await user.type(firstEditor, "第一次保存 ");
  await user.keyboard("{Enter}");
  expect(onSaveMetadata).toHaveBeenCalledWith({ title: "第一次保存" });

  await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
  const currentEditor = screen.getByRole("textbox", { name: "音频标题" });
  await user.clear(currentEditor);
  await user.type(currentEditor, "尚未提交的新草稿");

  act(() =>
    resolveSave({
      ...snapshot,
      revision: 4,
      summary: { ...snapshot.summary, displayName: "第一次保存" },
    }),
  );
  await waitFor(() =>
    expect(currentEditor).toHaveTextContent("尚未提交的新草稿"),
  );
  await user.keyboard("{Escape}");
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent("第一次保存");
});

it("groups transcript tools and switches between flat and message views", async () => {
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={api()} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  const tools = screen.getByRole("group", { name: "转写显示工具" });
  expect(within(tools).getByRole("button", { name: "搜索转写" })).toBeVisible();
  expect(
    within(tools).getByRole("button", { name: "切换为对话模式" }),
  ).toBeVisible();
  expect(tools).toHaveAttribute("data-slot", "button-group");
  expect(screen.queryByRole("searchbox", { name: "搜索音频转写" })).toBeNull();

  await user.click(within(tools).getByRole("button", { name: "搜索转写" }));
  expect(screen.getByRole("searchbox", { name: "搜索音频转写" })).toHaveFocus();

  await user.click(
    within(tools).getByRole("button", { name: "切换为对话模式" }),
  );
  expect(
    screen.getByRole("button", { name: "切换为平铺模式" }),
  ).toHaveAttribute("aria-pressed", "true");
  const transcript = screen.getByRole("tabpanel", { name: "转写文本" });
  expect(transcript.querySelectorAll('[data-slot="message"]')).toHaveLength(3);
  const bubbles = transcript.querySelectorAll('[data-slot="bubble"]');
  expect(bubbles).toHaveLength(3);
  expect(bubbles[0]).toHaveClass("h-16");
  expect(bubbles[0]?.querySelector('[data-slot="bubble-content"]')).toHaveClass(
    "h-16",
  );
  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  expect(screen.getByRole("textbox", { name: "片段 1 文本" })).toHaveClass(
    "h-16",
  );
});

it("uses roving keyboard focus for the three audio detail tabs", async () => {
  render(<AudioWorkspaceFeature api={api()} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 项目周会/ }));
  const transcript = screen.getByRole("tab", { name: "转写文本" });
  const summary = screen.getByRole("tab", { name: "AI 总结" });
  const knowledge = screen.getByRole("tab", { name: "知识库" });

  transcript.focus();
  await userEvent.setup().keyboard("{ArrowRight}");
  expect(summary).toHaveFocus();
  expect(summary).toHaveAttribute("aria-selected", "true");
  await userEvent.setup().keyboard("{End}");
  expect(knowledge).toHaveFocus();
  await userEvent.setup().keyboard("{Home}");
  expect(transcript).toHaveFocus();
  expect(transcript).toHaveAttribute("tabindex", "0");
  expect(summary).toHaveAttribute("tabindex", "-1");
});

it("freezes the reduced-motion compact title while metadata is being edited", async () => {
  let notify: IntersectionObserverCallback | undefined;
  class TestIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      notify = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
  }
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
  try {
    const desktop = api();
    const user = userEvent.setup();
    render(<AudioWorkspaceFeature api={desktop} />);
    await user.click(
      await screen.findByRole("button", { name: /打开 项目周会/ }),
    );
    const workspace = screen.getByRole("region", {
      name: "项目周会.wav 工作区",
    });
    const tablist = screen.getByRole("tablist", { name: "音频内容" });
    const compact = workspace.querySelector<HTMLElement>(
      "[data-audio-compact-title]",
    )!;
    const expanded = workspace.querySelector<HTMLElement>(
      "[data-audio-expanded-title]",
    )!;
    const stickyActionsContent = workspace.querySelector<HTMLElement>(
      "[data-audio-sticky-actions-content]",
    )!;
    const stickyHeader = workspace.querySelector<HTMLElement>(
      "[data-audio-sticky-header]",
    );
    const hero = workspace.querySelector<HTMLElement>("[data-audio-hero]");
    expect(stickyHeader).toHaveClass("h-11");
    expect(stickyHeader).toHaveClass("top-[50px]");
    expect(compact).toHaveClass("absolute");
    expect(compact).toHaveClass("-top-[35px]");
    expect(compact).toHaveClass("h-5");
    expect(compact).toHaveClass("leading-5");
    expect(hero).not.toHaveClass("absolute");
    expect(expanded).toHaveClass("opacity-100");
    expect(expanded).toHaveAttribute("aria-hidden", "false");
    expect(expanded).not.toHaveAttribute("inert");
    expect(compact).toHaveClass("opacity-0");
    expect(compact).toHaveAttribute("inert");
    expect(workspace.querySelectorAll('[aria-label="音频操作"]')).toHaveLength(
      1,
    );
    expect(stickyActionsContent).toHaveClass("translate-y-8");

    await user.click(screen.getByRole("button", { name: "编辑音频描述" }));
    act(() =>
      notify?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(compact).toHaveAttribute("aria-hidden", "true");
    expect(expanded).toHaveClass("opacity-100");
    expect(expanded).not.toHaveAttribute("inert");
    expect(stickyActionsContent).toHaveClass("translate-y-8");

    await user.click(screen.getByRole("tab", { name: "转写文本" }));
    expect(compact).toHaveAttribute("aria-hidden", "false");
    expect(compact).toHaveTextContent("项目周会.wav");
    expect(compact).toHaveClass("motion-reduce:transition-none");
    expect(expanded).toHaveClass("opacity-0");
    expect(expanded).toHaveAttribute("aria-hidden", "true");
    expect(expanded).toHaveAttribute("inert");
    expect(compact).toHaveClass("opacity-100");
    expect(compact).not.toHaveAttribute("inert");
    expect(stickyHeader).toHaveClass("h-11");
    expect(tablist).toHaveClass("translate-y-0");
    expect(stickyActionsContent).toHaveClass("translate-y-[9px]");

    await user.click(screen.getByRole("button", { name: "编辑音频标题" }));
    const compactTitleEditor = screen.getByRole("textbox", {
      name: "音频标题",
    });
    expect(compactTitleEditor.tagName).toBe("SPAN");
    expect(compactTitleEditor).toHaveAttribute("contenteditable", "true");
    expect(compactTitleEditor).toHaveAttribute("data-plaintext-only", "true");
    expect(compactTitleEditor).not.toHaveClass("focus-visible:ring-1");
    await user.clear(compactTitleEditor);
    await user.type(compactTitleEditor, "吸顶标题");
    await user.tab();
    await waitFor(() =>
      expect(desktop.updateAudioMetadata).toHaveBeenCalledWith({
        audioId: 4,
        title: "吸顶标题",
        expectedRevision: 3,
      }),
    );
    expect(compact).toHaveTextContent("吸顶标题");

    act(() =>
      notify?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(compact).toHaveAttribute("aria-hidden", "true");
    expect(expanded).toHaveClass("opacity-100");
    expect(expanded).toHaveAttribute("aria-hidden", "false");
    expect(expanded).not.toHaveAttribute("inert");
    expect(compact).toHaveClass("opacity-0");
    expect(compact).toHaveAttribute("inert");
    expect(stickyHeader).toHaveClass("h-11");
    expect(tablist).toHaveClass("translate-y-0");
    expect(stickyActionsContent).toHaveClass("translate-y-8");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("persists an adopted AI title and validates full evidence identity", async () => {
  const desktop = api({
    getAudioAiSnapshot: vi.fn(async () => completedAi),
  });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("tab", { name: "AI 总结" }));

  expect(await screen.findByText("unrecognized-kind")).toBeVisible();
  expect(screen.getByText(/负责人 主持人/)).toHaveTextContent("截止");
  await user.click(screen.getByRole("button", { name: "采用标题" }));
  await waitFor(() =>
    expect(desktop.updateAudioMetadata).toHaveBeenCalledWith({
      audioId: 4,
      title: "发布复盘",
      expectedRevision: 3,
    }),
  );
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent("发布复盘");

  await user.click(screen.getByRole("tab", { name: "AI 总结" }));
  await user.click(screen.getByRole("button", { name: "证据 1 · 00:01" }));
  expect(screen.getByRole("tab", { name: "转写文本" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("group", { name: "搜索结果导航" })).toHaveTextContent(
    "片段 2",
  );
  expect(desktop.getAudioAiSnapshot).toHaveBeenCalledTimes(1);
});

it("keeps an over-limit AI title as a visible draft without submitting it", async () => {
  const suggestedTitle = "过".repeat(257);
  const desktop = api({
    getAudioAiSnapshot: vi.fn(async () => ({
      ...completedAi,
      note: { ...completedAi.note!, suggestedTitle },
    })),
  });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("tab", { name: "AI 总结" }));
  await user.click(await screen.findByRole("button", { name: "采用标题" }));

  expect(desktop.updateAudioMetadata).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "标题不能超过 256 个字符，请精简后重试",
  );
  expect(
    screen.getByRole("button", { name: "编辑音频标题" }),
  ).toHaveTextContent(suggestedTitle);
});

it("returns to the transcript without locating evidence whose time range changed", async () => {
  const toastWarning = vi.spyOn(toast, "warning");
  const staleAi: AudioAiSnapshot = {
    ...completedAi,
    note: {
      ...completedAi.note!,
      items: [
        {
          ...completedAi.note!.items[0]!,
          evidence: [{ segmentId: 12, startMs: 1_500, endMs: 3_001 }],
        },
      ],
    },
  };
  const user = userEvent.setup();
  render(
    <AudioWorkspaceFeature
      api={api({ getAudioAiSnapshot: vi.fn(async () => staleAi) })}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("tab", { name: "AI 总结" }));
  await user.click(
    await screen.findByRole("button", { name: "证据 1 · 00:01" }),
  );

  expect(screen.getByRole("tab", { name: "转写文本" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("group", { name: "搜索结果导航" })).toBeNull();
  expect(toastWarning).toHaveBeenCalledWith(
    "对应的转写片段已变化，请重新生成总结",
    { id: "audio-evidence-stale" },
  );
});

it("clamps ten-second seek controls to the audio boundaries", async () => {
  const desktop = api();
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);

  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await screen.findByRole("region", { name: "项目周会.wav 工作区" });
  vi.mocked(desktop.controlAudioPlayback).mockClear();

  await user.click(screen.getByRole("button", { name: "后退 10 秒" }));
  expect(desktop.controlAudioPlayback).toHaveBeenLastCalledWith(4, {
    action: "seek",
    positionMs: 0,
  });

  await user.click(screen.getByRole("button", { name: "前进 10 秒" }));
  expect(desktop.controlAudioPlayback).toHaveBeenLastCalledWith(4, {
    action: "seek",
    positionMs: 6_000,
  });
});

it("shows a recoverable list error and then the explicit empty state", async () => {
  const listAudios = vi
    .fn()
    .mockRejectedValueOnce(new Error("raw /private/database busy"))
    .mockResolvedValueOnce([]);
  render(<AudioWorkspaceFeature api={api({ listAudios })} />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法载入音频资料库",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "重新载入" }));
  const reviewEmpty = (
    await screen.findByText("还没有可复核的音频")
  ).closest<HTMLElement>('[data-slot="empty-state"]')!;
  expect(reviewEmpty).toBeVisible();
  expect(
    reviewEmpty.querySelectorAll('[data-slot="empty-state-cube"]'),
  ).toHaveLength(3);
  expect(within(reviewEmpty).queryByRole("heading")).toBeNull();
  expect(listAudios).toHaveBeenCalledTimes(2);
});

it("uses the local empty state when AI summary needs a transcript", async () => {
  const user = userEvent.setup();
  render(
    <AudioDetailWorkspace
      api={api()}
      workspace={{
        ...snapshot,
        summary: { ...snapshot.summary, generationId: null },
      }}
      routePending={false}
      onWorkspaceChange={() => undefined}
    />,
  );

  await user.click(screen.getByRole("tab", { name: "AI 总结" }));
  const summaryEmpty = screen
    .getByText("完成转写后即可生成 AI 总结")
    .closest<HTMLElement>('[data-slot="empty-state"]')!;
  expect(
    summaryEmpty.querySelectorAll('[data-slot="empty-state-cube"]'),
  ).toHaveLength(3);
  expect(within(summaryEmpty).queryByRole("heading")).toBeNull();
});

it("renders only a bounded virtual window for a 3001 segment transcript", async () => {
  const large = {
    ...snapshot,
    segments: Array.from({ length: 3001 }, (_, index) => ({
      ...snapshot.segments[0]!,
      id: index + 1,
      stableKey: `${index}:${index * 1000}:${index * 1000 + 900}`,
      sequenceId: index,
      startMs: index * 1000,
      endMs: index * 1000 + 900,
      text: `片段 ${index}`,
      machineText: `片段 ${index}`,
    })),
    summary: { ...snapshot.summary, segmentCount: 3001 },
  };
  const desktop = api({ openAudio: vi.fn(async () => large) });
  render(<AudioWorkspaceFeature api={desktop} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 项目周会/ }));

  await screen.findByRole("list", { name: "音频转写片段" });
  const items = screen.getAllByRole("listitem");
  expect(items.length).toBeLessThanOrEqual(40);
  expect(items[0]).toHaveAttribute("aria-setsize", "3001");
});

it("keeps search result identity and keyboard-navigates to segment 3000", async () => {
  const segments = Array.from({ length: 3001 }, (_, index) => ({
    ...snapshot.segments[0]!,
    id: index + 1,
    stableKey: `${index}:${index * 1000}:${index * 1000 + 900}`,
    sequenceId: index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: `命中片段 ${index + 1}`,
    machineText: `命中片段 ${index + 1}`,
  }));
  const large = {
    ...snapshot,
    segments,
    summary: { ...snapshot.summary, segmentCount: segments.length },
  };
  const desktop = api({
    openAudio: vi.fn(async () => large),
    searchTranscript: vi.fn(async () => [segments[100]!, segments[2999]!]),
  });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  await user.click(screen.getByRole("button", { name: "搜索转写" }));
  await user.type(
    screen.getByRole("searchbox", { name: "搜索音频转写" }),
    "命中",
  );
  await user.keyboard("{Enter}");
  const resultNavigation = await screen.findByRole("group", {
    name: "搜索结果导航",
  });
  expect(resultNavigation).toHaveTextContent("搜索结果 1 / 2，片段 101");
  expect(
    await screen.findByRole("listitem", { name: /片段 101/ }),
  ).toHaveFocus();

  const next = screen.getByRole("button", { name: "下一个搜索结果" });
  next.focus();
  await user.keyboard("{Enter}");
  expect(resultNavigation).toHaveTextContent("搜索结果 2 / 2，片段 3000");
  expect(
    await screen.findByRole("listitem", { name: /片段 3000/ }),
  ).toHaveFocus();

  const previous = screen.getByRole("button", { name: "上一个搜索结果" });
  previous.focus();
  await user.keyboard("{Enter}");
  expect(resultNavigation).toHaveTextContent("搜索结果 1 / 2，片段 101");
});

it("closes playback once on workspace back and keeps close failures visible", async () => {
  let closeAttempts = 0;
  const controlAudioPlayback = vi.fn(async (_audioId, command) => {
    if (command.action === "close" && closeAttempts++ === 0)
      throw new Error("raw /private/audio close failure");
    return {
      audioId: 4,
      initialized: command.action !== "close",
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    };
  });
  const desktop = api({ controlAudioPlayback });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "播放音频" }));

  await user.click(screen.getByRole("button", { name: "返回音频列表" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("音频关闭未完成");
  expect(
    screen.getByRole("region", { name: "项目周会.wav 工作区" }),
  ).toBeVisible();

  await user.click(screen.getByRole("button", { name: "返回音频列表" }));
  await screen.findByRole("heading", { name: "音频资料库" });
  await waitFor(() =>
    expect(controlAudioPlayback).toHaveBeenCalledWith(4, {
      action: "close",
    }),
  );
  expect(
    controlAudioPlayback.mock.calls.filter(
      ([, command]) => command.action === "close",
    ),
  ).toHaveLength(2);
});

it("surfaces a typed export write failure instead of reporting cancellation", async () => {
  const toastError = vi.spyOn(toast, "error");
  const desktop = api({
    exportAudio: vi.fn(async () => ({
      state: "failed" as const,
      code: "export-write-failed" as const,
      message: "所选位置不可写，请选择其他位置",
    })),
  });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  await user.click(screen.getByRole("button", { name: "导出" }));
  await user.click(screen.getByRole("menuitem", { name: "TXT" }));
  await waitFor(() =>
    expect(toastError).toHaveBeenCalledWith(
      "音频导出失败，请重试。",
      expect.objectContaining({ id: "audio-export" }),
    ),
  );
  expect(screen.queryByRole("status", { name: "音频工作区状态" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("已取消导出")).not.toBeInTheDocument();
});

it("reopens an edited segment with the authoritative text after undo", async () => {
  const edited = {
    ...snapshot,
    revision: 4,
    segments: snapshot.segments.map((segment, index) =>
      index === 0 ? { ...segment, text: "修订文本" } : segment,
    ),
  };
  const desktop = api({
    editAudioSegment: vi.fn(async () => edited),
    undoAudioEdit: vi.fn(async () => snapshot),
  });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  const editor = screen.getByRole("textbox", { name: "片段 1 文本" });
  await user.clear(editor);
  await user.type(editor, "修订文本");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(desktop.editAudioSegment).toHaveBeenCalled());

  await user.click(screen.getByRole("button", { name: "撤销" }));
  await waitFor(() =>
    expect(desktop.undoAudioEdit).toHaveBeenCalledWith(4, 9, 4),
  );
  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  expect(screen.getByRole("textbox", { name: "片段 1 文本" })).toHaveValue(
    "确认下周发布。",
  );
});

it("keeps segment editing height stable and commits on Enter or blur", async () => {
  const desktop = api();
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  let editor = screen.getByRole("textbox", { name: "片段 1 文本" });
  expect(editor).toHaveClass(
    "h-20",
    "max-h-20",
    "field-sizing-fixed",
    "overflow-y-auto",
  );
  await user.clear(editor);
  await user.type(editor, "Shift 保存");
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  await waitFor(() =>
    expect(desktop.editAudioSegment).toHaveBeenCalledTimes(1),
  );
  expect(desktop.editAudioSegment).toHaveBeenCalledWith(
    expect.objectContaining({ text: "Shift 保存" }),
  );
  expect(screen.queryByRole("textbox", { name: "片段 1 文本" })).toBeNull();
  expect(screen.getByText("确认下周发布。")).toHaveClass("h-20");

  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  editor = screen.getByRole("textbox", { name: "片段 1 文本" });
  await user.clear(editor);
  await user.type(editor, "失焦保存");
  await user.click(screen.getByLabelText("可滚动音频转写"));
  await waitFor(() =>
    expect(desktop.editAudioSegment).toHaveBeenCalledTimes(2),
  );
  expect(screen.queryByRole("textbox", { name: "片段 1 文本" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  editor = screen.getByRole("textbox", { name: "片段 1 文本" });
  await user.clear(editor);
  await user.click(screen.getByLabelText("可滚动音频转写"));
  expect(desktop.editAudioSegment).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("textbox", { name: "片段 1 文本" })).toBeNull();
});

it("resets the merge source after a speaker is merged", async () => {
  const threeSpeakers = {
    ...snapshot,
    speakers: [
      snapshot.speakers[0]!,
      {
        ...snapshot.speakers[0]!,
        id: 8,
        stableKey: "speaker-b",
        displayName: "说话人 2",
      },
      {
        ...snapshot.speakers[0]!,
        id: 9,
        stableKey: "speaker-c",
        displayName: "说话人 3",
      },
    ],
  };
  const afterMerge = {
    ...threeSpeakers,
    revision: 4,
    speakers: [threeSpeakers.speakers[0]!, threeSpeakers.speakers[2]!],
  };
  const desktop = api({
    openAudio: vi.fn(async () => threeSpeakers),
    mergeAudioSpeakers: vi.fn(async () => afterMerge),
  });
  const user = userEvent.setup();
  render(<AudioWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "合并说话人" }));
  await waitFor(() =>
    expect(desktop.mergeAudioSpeakers).toHaveBeenCalledTimes(1),
  );
  expect(
    screen.getByRole("combobox", { name: "合并来源说话人" }),
  ).toHaveTextContent("说话人 3");
  expect(screen.getByRole("button", { name: "合并说话人" })).toBeEnabled();
});

async function selectRadixOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}
