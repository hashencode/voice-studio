// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { MeetingWorkspaceFeature } from "../../../src/renderer/features/meetings/meeting-workspace-feature";
import type {
  MeetingWorkspaceSnapshot,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const snapshot: MeetingWorkspaceSnapshot = {
  revision: 3,
  summary: {
    meetingId: 4,
    displayName: "项目周会.wav",
    durationMs: 6_000,
    createdAtMs: 1,
    processingState: "completed",
    generationId: 9,
    generationKind: "formal",
    segmentCount: 3,
  },
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

function api(overrides: Partial<Voice2TextDesktopApi> = {}) {
  return {
    listMeetings: vi.fn(async () => [snapshot.summary]),
    openMeeting: vi.fn(async () => snapshot),
    searchTranscript: vi.fn(async () => [snapshot.segments[0]!]),
    editMeetingSegment: vi.fn(async () => ({ ...snapshot, revision: 4 })),
    undoMeetingEdit: vi.fn(async () => snapshot),
    redoMeetingEdit: vi.fn(async () => snapshot),
    renameMeetingSpeaker: vi.fn(async () => snapshot),
    mergeMeetingSpeakers: vi.fn(async () => snapshot),
    assignMeetingSpeaker: vi.fn(async () => snapshot),
    controlMeetingPlayback: vi.fn(async () => ({
      meetingId: 4,
      initialized: true,
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    })),
    exportMeeting: vi.fn(async () => ({
      state: "saved",
      fileName: "项目周会.wav.txt",
    })),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}

it("supports keyboard open, search, edit, playback, speaker and export with semantic status", async () => {
  const desktop = api();
  const user = userEvent.setup();
  render(<MeetingWorkspaceFeature api={desktop} />);

  const meeting = await screen.findByRole("button", { name: /打开 项目周会/ });
  meeting.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("heading", { name: "项目周会.wav" }),
  ).toBeVisible();

  await user.type(
    screen.getByRole("searchbox", { name: "搜索会议转写" }),
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
  await user.clear(editor);
  await user.type(editor, "修订：确认下周发布。");
  await user.keyboard("{Control>}{Enter}{/Control}");
  await waitFor(() => expect(desktop.editMeetingSegment).toHaveBeenCalled());

  await user.click(screen.getByRole("button", { name: "播放会议音频" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "播放速度" }),
    "1.5",
  );
  await user.click(screen.getByRole("button", { name: "导出 TXT" }));
  expect(desktop.controlMeetingPlayback).toHaveBeenCalledWith(4, {
    action: "play",
  });
  expect(desktop.controlMeetingPlayback).toHaveBeenCalledWith(4, {
    action: "speed",
    speed: 1.5,
  });
  expect(desktop.exportMeeting).toHaveBeenCalledWith(4, "txt");
  expect(
    screen.getByRole("status", { name: "会议工作区状态" }),
  ).toHaveTextContent("已导出 项目周会.wav.txt");
  expect(screen.getByRole("status", { name: "会议工作区状态" })).toBeVisible();

  const name = screen.getByRole("textbox", { name: "说话人 1 名称" });
  await user.clear(name);
  await user.type(name, "主持人");
  await user.click(screen.getByRole("button", { name: "重命名" }));
  expect(desktop.renameMeetingSpeaker).toHaveBeenCalledWith(
    expect.objectContaining({ speakerId: 7, name: "主持人" }),
  );

  await user.selectOptions(
    screen.getByRole("combobox", { name: "片段 2 说话人" }),
    "speaker:7",
  );
  expect(desktop.assignMeetingSpeaker).toHaveBeenCalledWith(
    expect.objectContaining({ segmentId: 12, state: "assigned", speakerId: 7 }),
  );

  await user.click(screen.getByRole("button", { name: "返回资料库" }));
  const restoredMeeting = await screen.findByRole("button", {
    name: /打开 项目周会/,
  });
  await waitFor(() => expect(restoredMeeting).toHaveFocus());
});

it("shows a recoverable list error and then the explicit empty state", async () => {
  const listMeetings = vi
    .fn()
    .mockRejectedValueOnce(new Error("数据库暂时忙碌"))
    .mockResolvedValueOnce([]);
  render(<MeetingWorkspaceFeature api={api({ listMeetings })} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("数据库暂时忙碌");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "重新载入" }));
  expect(
    await screen.findByRole("heading", { name: "还没有可复核的会议" }),
  ).toBeVisible();
  expect(listMeetings).toHaveBeenCalledTimes(2);
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
  const desktop = api({ openMeeting: vi.fn(async () => large) });
  render(<MeetingWorkspaceFeature api={desktop} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: /打开 项目周会/ }));

  await screen.findByRole("list", { name: "会议转写片段" });
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
    openMeeting: vi.fn(async () => large),
    searchTranscript: vi.fn(async () => [segments[100]!, segments[2999]!]),
  });
  const user = userEvent.setup();
  render(<MeetingWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  await user.type(
    screen.getByRole("searchbox", { name: "搜索会议转写" }),
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
  const controlMeetingPlayback = vi.fn(async (_meetingId, command) => {
    if (command.action === "close" && closeAttempts++ === 0)
      throw new Error("无法关闭私有音频");
    return {
      meetingId: 4,
      initialized: command.action !== "close",
      playing: false,
      positionMs: 0,
      durationMs: 6_000,
      speed: 1,
      error: null,
    };
  });
  const desktop = api({ controlMeetingPlayback });
  const user = userEvent.setup();
  render(<MeetingWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "播放会议音频" }));

  await user.click(screen.getByRole("button", { name: "返回资料库" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法关闭私有音频",
  );
  expect(screen.getByRole("heading", { name: "项目周会.wav" })).toBeVisible();

  await user.click(screen.getByRole("button", { name: "返回资料库" }));
  await screen.findByRole("heading", { name: "会议资料库" });
  await waitFor(() =>
    expect(controlMeetingPlayback).toHaveBeenCalledWith(4, {
      action: "close",
    }),
  );
  expect(
    controlMeetingPlayback.mock.calls.filter(
      ([, command]) => command.action === "close",
    ),
  ).toHaveLength(2);
});

it("surfaces a typed export write failure instead of reporting cancellation", async () => {
  const desktop = api({
    exportMeeting: vi.fn(async () => ({
      state: "failed" as const,
      code: "export-write-failed" as const,
      message: "所选位置不可写，请选择其他位置",
    })),
  });
  const user = userEvent.setup();
  render(<MeetingWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );

  await user.click(screen.getByRole("button", { name: "导出 TXT" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "所选位置不可写，请选择其他位置",
  );
  expect(
    screen.getByRole("status", { name: "会议工作区状态" }),
  ).toHaveTextContent("会议导出失败");
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
    editMeetingSegment: vi.fn(async () => edited),
    undoMeetingEdit: vi.fn(async () => snapshot),
  });
  const user = userEvent.setup();
  render(<MeetingWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  const editor = screen.getByRole("textbox", { name: "片段 1 文本" });
  await user.clear(editor);
  await user.type(editor, "修订文本");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存片段 1");

  await user.click(screen.getByRole("button", { name: "撤销" }));
  await screen.findByText("已撤销上次文本修改");
  expect(desktop.undoMeetingEdit).toHaveBeenCalledWith(4, 9, 4);
  await user.click(screen.getByRole("button", { name: "编辑片段 1" }));
  expect(screen.getByRole("textbox", { name: "片段 1 文本" })).toHaveValue(
    "确认下周发布。",
  );
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
    openMeeting: vi.fn(async () => threeSpeakers),
    mergeMeetingSpeakers: vi.fn(async () => afterMerge),
  });
  const user = userEvent.setup();
  render(<MeetingWorkspaceFeature api={desktop} />);
  await user.click(
    await screen.findByRole("button", { name: /打开 项目周会/ }),
  );
  await user.click(screen.getByRole("button", { name: "合并说话人" }));
  await waitFor(() =>
    expect(desktop.mergeMeetingSpeakers).toHaveBeenCalledTimes(1),
  );
  expect(screen.getByRole("combobox", { name: "合并来源说话人" })).toHaveValue(
    "9",
  );
  expect(screen.getByRole("button", { name: "合并说话人" })).toBeEnabled();
});
