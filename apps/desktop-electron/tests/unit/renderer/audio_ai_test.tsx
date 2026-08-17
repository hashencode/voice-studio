// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AudioAiFeature } from "../../../src/renderer/features/audio-ai/audio-ai-feature";
import type { Voice2TextDesktopApi } from "../../../src/shared/contracts";
import type { AudioAiSnapshot } from "../../../src/shared/contracts";

const preview = {
  audioId: 4,
  generationId: 9,
  providerId: "deepseek" as const,
  modelId: "deepseek-chat",
  audioTitle: "项目周会",
  endpointOrigin: "https://api.deepseek.com",
  endpointIdentitySha256: "c".repeat(64),
  transcriptScopeSha256: "a".repeat(64),
  segmentCount: 2,
  inputStartMs: 0,
  inputEndMs: 5_000,
  requiresConsent: true as const,
};

const completed: AudioAiSnapshot = {
  revision: 4,
  jobId: 41,
  audioId: 4,
  generationId: 9,
  providerId: "deepseek" as const,
  modelId: "deepseek-chat",
  endpointOrigin: "https://api.deepseek.com",
  endpointIdentitySha256: "c".repeat(64),
  transcriptScopeSha256: "a".repeat(64),
  attempt: 0,
  state: "completed" as const,
  errorCode: null,
  note: {
    noteId: 71,
    schemaVersion: "audio_intelligence_output/v1" as const,
    suggestedTitle: "项目周会",
    audioType: "weekly",
    items: [
      {
        insightId: 81,
        kind: "action",
        body: "准备发布清单",
        evidence: [{ segmentId: 12, startMs: 1_500, endMs: 3_000 }],
        actionOwner: "主持人",
        actionDueAtMs: null,
      },
    ],
  },
};

function api(overrides: Record<string, unknown> = {}) {
  return {
    getAudioAiSnapshot: vi.fn(async () => null),
    prepareAudioAi: vi.fn(async () => preview),
    generateAudioAi: vi.fn(async () => completed),
    retryAudioAi: vi.fn(async () => ({
      ...completed,
      revision: 6,
      attempt: 2,
    })),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}

describe("per-generation audio AI consent", () => {
  it("cancels with Escape, restores focus, and sends no transcript", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);
    const generate = await screen.findByRole("button", {
      name: "生成云端会议草稿",
    });

    generate.focus();
    await user.keyboard("{Enter}");
    expect(desktop.prepareAudioAi).toHaveBeenCalledWith({
      audioId: 4,
      generationId: 9,
      templateId: "default",
    });
    const dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    expect(dialog).toHaveTextContent("2 个转写片段");
    expect(dialog).toHaveTextContent("会议标题“项目周会”");
    expect(dialog).toHaveTextContent("https://api.deepseek.com");
    expect(
      within(dialog).getByRole("button", { name: "同意并生成草稿" }),
    ).toBeDisabled();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(generate).toHaveFocus();
    expect(desktop.generateAudioAi).not.toHaveBeenCalled();
  });

  it("passes the exact prepared scope and requires fresh consent each time", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);

    await user.click(
      await screen.findByRole("button", { name: "生成云端会议草稿" }),
    );
    let dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "我同意仅针对本次会议发送会议标题与上述转写文本",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "同意并生成草稿" }),
    );

    await waitFor(() =>
      expect(desktop.generateAudioAi).toHaveBeenCalledWith(
        expect.objectContaining({
          audioId: 4,
          generationId: 9,
          templateId: "default",
          consent: {
            version: 1,
            providerId: "deepseek",
            endpointOrigin: "https://api.deepseek.com",
            endpointIdentitySha256: "c".repeat(64),
            transcriptScopeSha256: "a".repeat(64),
          },
        }),
      ),
    );
    expect(await screen.findByText("准备发布清单")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "重新生成云端会议草稿" }),
    );
    dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    expect(
      within(dialog).getByRole("checkbox", {
        name: "我同意仅针对本次会议发送会议标题与上述转写文本",
      }),
    ).not.toBeChecked();
    expect(desktop.prepareAudioAi).toHaveBeenCalledTimes(2);
    expect(desktop.generateAudioAi).toHaveBeenCalledTimes(1);
  });

  it("shows provider failure without automatic fallback or retry", async () => {
    const failure = Object.assign(new Error("DeepSeek 暂时不可用"), {
      code: "AI_SERVICE_UNAVAILABLE",
    });
    const desktop = api({
      generateAudioAi: vi.fn(async () => Promise.reject(failure)),
    });
    const user = userEvent.setup();
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);

    await user.click(
      await screen.findByRole("button", { name: "生成云端会议草稿" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(
      within(dialog).getByRole("button", { name: "同意并生成草稿" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "DeepSeek 暂时不可用",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "不会自动切换提供商或重试",
    );
    expect(desktop.generateAudioAi).toHaveBeenCalledTimes(1);
    expect(desktop.retryAudioAi).not.toHaveBeenCalled();
  });

  it("retries an interrupted attempt once with fresh exact-scope consent", async () => {
    const interrupted: AudioAiSnapshot = {
      ...completed,
      revision: 5,
      attempt: 1,
      state: "interrupted",
      errorCode: "AI_PROCESS_INTERRUPTED",
      note: null,
    };
    const desktop = api({
      getAudioAiSnapshot: vi.fn(async () => interrupted),
    });
    const user = userEvent.setup();
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);

    await user.click(
      await screen.findByRole("button", { name: "重试云端会议草稿" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(
      within(dialog).getByRole("button", { name: "同意并生成草稿" }),
    );

    await waitFor(() =>
      expect(desktop.retryAudioAi).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 41,
          expectedAttempt: 1,
          consent: expect.objectContaining({
            transcriptScopeSha256: "a".repeat(64),
          }),
        }),
      ),
    );
    expect(desktop.retryAudioAi).toHaveBeenCalledTimes(1);
    expect(desktop.generateAudioAi).not.toHaveBeenCalled();
  });

  it("offers a fresh generation when a failed attempt's prior scope can no longer be retried", async () => {
    const interrupted: AudioAiSnapshot = {
      ...completed,
      revision: 5,
      attempt: 1,
      state: "interrupted",
      errorCode: "AI_PROCESS_INTERRUPTED",
      note: null,
    };
    const desktop = api({
      getAudioAiSnapshot: vi.fn(async () => interrupted),
    });
    const user = userEvent.setup();
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);

    await user.click(
      await screen.findByRole("button", {
        name: "按当前内容重新生成云端会议草稿",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(
      within(dialog).getByRole("button", { name: "同意并生成草稿" }),
    );

    await waitFor(() =>
      expect(desktop.generateAudioAi).toHaveBeenCalledWith(
        expect.objectContaining({ audioId: 4, generationId: 9 }),
      ),
    );
    expect(desktop.retryAudioAi).not.toHaveBeenCalled();
  });

  it("keeps the retry job and attempt captured before the consent dialog opened", async () => {
    const interrupted: AudioAiSnapshot = {
      ...completed,
      revision: 5,
      attempt: 1,
      state: "interrupted",
      errorCode: "AI_PROCESS_INTERRUPTED",
      note: null,
    };
    let listener: ((snapshot: AudioAiSnapshot) => void) | undefined;
    const desktop = api({
      getAudioAiSnapshot: vi.fn(async () => interrupted),
      onAudioAiSnapshot: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    });
    const user = userEvent.setup();
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);

    await user.click(
      await screen.findByRole("button", { name: "重试云端会议草稿" }),
    );
    listener?.({
      ...interrupted,
      jobId: 42,
      revision: 0,
      attempt: 0,
    });
    const dialog = await screen.findByRole("dialog", {
      name: "本次会议云端处理同意",
    });
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(
      within(dialog).getByRole("button", { name: "同意并生成草稿" }),
    );

    await waitFor(() =>
      expect(desktop.retryAudioAi).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 41, expectedAttempt: 1 }),
      ),
    );
  });

  it("ignores stale full-snapshot events by job, attempt, and revision fences", async () => {
    let listener: ((snapshot: AudioAiSnapshot) => void) | undefined;
    const desktop = api({
      getAudioAiSnapshot: vi.fn(async () => completed),
      onAudioAiSnapshot: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    });
    render(<AudioAiFeature api={desktop} audioId={4} generationId={9} />);
    expect(await screen.findByText("准备发布清单")).toBeVisible();

    listener?.({
      ...completed,
      revision: 3,
      state: "failed",
      errorCode: "AI_SERVICE_UNAVAILABLE",
      note: null,
    });
    expect(screen.getByText("准备发布清单")).toBeVisible();
    expect(screen.queryByText("生成失败")).not.toBeInTheDocument();
  });
});
