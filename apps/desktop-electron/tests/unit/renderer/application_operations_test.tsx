// @vitest-environment jsdom

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../../src/renderer/App";
import type {
  ApplicationSnapshot,
  OperationEvent,
  ProcessingTask,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";
import { companionRendererStubs } from "../../fixtures/companion";

const tasksSnapshot: ApplicationSnapshot = {
  protocolVersion: 2,
  revision: 1,
  navigation: { section: "tasks" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: { phase: "idle" },
};

const librarySnapshot: ApplicationSnapshot = {
  ...tasksSnapshot,
  navigation: { section: "library" },
};

const runningTask: ProcessingTask = {
  id: 7,
  audioId: 3,
  displayName: "项目周会.wav",
  state: "running",
  phase: "asr",
  progressFraction: 0.1,
  attempt: 2,
  errorCode: null,
};

const runningAudio = {
  audioId: 3,
  displayName: "项目周会.wav",
  durationMs: 6_000,
  createdAtMs: 1,
  processingState: "running" as const,
  generationId: null,
  generationKind: null,
  segmentCount: 0,
};

const runningWorkspace = {
  revision: 1,
  summary: runningAudio,
  segments: [],
  speakers: [],
  canUndo: false,
  canRedo: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function installOperationsApi(overrides: Partial<Voice2TextDesktopApi> = {}) {
  let operationListener: ((event: OperationEvent) => void) | undefined;
  const unsubscribeOperation = vi.fn();
  const api: Voice2TextDesktopApi = {
    ...companionRendererStubs(),
    getAiSettings: vi.fn(async () => testAiSettings()),
    saveAiSettings: vi.fn(async () => testAiSettings()),
    replaceAiProviderSecret: vi.fn(async () => testAiSettings()),
    deleteAiProviderSecret: vi.fn(async () => testAiSettings()),
    prepareAudioAi: vi.fn(),
    getAudioAiSnapshot: vi.fn(async () => null),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    onAudioAiSnapshot: vi.fn(() => () => undefined),
    workerHealth: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    listProcessingTasks: vi.fn(async () => [runningTask]),
    importAudio: vi.fn(),
    listAudios: vi.fn(async () => [runningAudio]),
    openAudio: vi.fn(async () => runningWorkspace),
    searchTranscript: vi.fn(async () => []),
    editAudioSegment: vi.fn(),
    undoAudioEdit: vi.fn(),
    redoAudioEdit: vi.fn(),
    renameAudioSpeaker: vi.fn(),
    mergeAudioSpeakers: vi.fn(),
    assignAudioSpeaker: vi.fn(),
    controlAudioPlayback: vi.fn(),
    exportAudio: vi.fn(),
    preflightCapture: vi.fn(),
    startCapture: vi.fn(),
    controlCapture: vi.fn(),
    listCaptureRecoveries: vi.fn(async () => []),
    actOnCaptureRecovery: vi.fn(),
    getCaptionSnapshot: vi.fn(async () => null),
    retryFormalTranscript: vi.fn(),
    onCaptionSnapshot: vi.fn(() => () => undefined),
    onOperationEvent: vi.fn((listener) => {
      operationListener = listener;
      return unsubscribeOperation;
    }),
    getApplicationSnapshot: vi.fn(async () => tasksSnapshot),
    navigate: vi.fn(async (section) => ({
      ...tasksSnapshot,
      revision: tasksSnapshot.revision + 1,
      navigation: { section },
    })),
    requestBootstrapAction: vi.fn(async () => tasksSnapshot),
    onApplicationSnapshot: vi.fn(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return {
    api,
    emit(event: OperationEvent) {
      act(() => operationListener?.(event));
    },
    unsubscribeOperation,
  };
}

function testAiSettings() {
  return {
    revision: 1,
    config: {
      providerId: "deepseek" as const,
      displayName: "DeepSeek",
      modelId: "deepseek-chat",
      endpoint: "https://api.deepseek.com",
      endpointOrigin: "https://api.deepseek.com",
      processingLocation: "cloudDirect" as const,
      requiresConsent: true as const,
    },
    secretState: "missing" as const,
    deviceSecurity: {
      kind: "device-security" as const,
      fileVaultState: "unknown" as const,
      applicationLayerEncryption: "not-claimed" as const,
    },
  };
}

describe("renderer processing operation races", () => {
  it("guards a double-clicked import and clears pending in finally", async () => {
    const request = deferred<never>();
    const importAudio = vi.fn(() => request.promise);
    installOperationsApi({
      importAudio,
      getApplicationSnapshot: vi.fn(async () => librarySnapshot),
    });
    const user = userEvent.setup();
    render(<App />);

    const action = await screen.findByRole("button", { name: "导入音频" });
    await user.dblClick(action);
    expect(importAudio).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "导入音频" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导入音频" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    request.reject(new Error("导入失败"));
    expect(await screen.findByRole("alert")).toHaveTextContent("导入失败");
    expect(screen.getByRole("button", { name: "导入音频" })).toBeEnabled();
  });

  it.each([
    {
      name: "cancel",
      state: "running" as const,
      button: "取消 项目周会.wav",
      pending: "正在取消 项目周会.wav",
      method: "cancelProcessing" as const,
      error: "取消失败",
    },
    {
      name: "retry",
      state: "interrupted" as const,
      button: "重试 项目周会.wav",
      pending: "正在重试 项目周会.wav",
      method: "retryProcessing" as const,
      error: "重试失败",
    },
  ])(
    "guards a double-clicked $name per job and clears pending in finally",
    async ({ state, button, pending, method, error }) => {
      const request = deferred<never>();
      const operation = vi.fn(() => request.promise);
      const { api } = installOperationsApi({
        listProcessingTasks: vi.fn(async () => [{ ...runningTask, state }]),
        [method]: operation,
      });
      const user = userEvent.setup();
      render(<App />);

      await user.click(
        await screen.findByRole("button", { name: /打开 项目周会/ }),
      );

      const action = await screen.findByRole("button", { name: button });
      await user.dblClick(action);
      expect(api[method]).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: pending })).toBeDisabled();

      request.reject(new Error(error));
      expect(await screen.findByRole("alert")).toHaveTextContent(error);
      expect(screen.getByRole("button", { name: button })).toBeEnabled();
    },
  );

  it("merges repeated known progress deltas without full-list IPC refresh", async () => {
    const { api, emit } = installOperationsApi();
    render(<App />);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /打开 项目周会/ }));
    expect(
      await screen.findByRole("progressbar", { name: "项目周会.wav 处理进度" }),
    ).toHaveValue(0.1);

    const progress: OperationEvent = {
      protocolVersion: 2,
      jobId: 7,
      attempt: 2,
      state: "running",
      phase: "asr",
      progressFraction: 0.6,
    };
    emit(progress);
    emit(progress);

    expect(
      screen.getByRole("progressbar", { name: "项目周会.wav 处理进度" }),
    ).toHaveValue(0.6);
    expect(api.listProcessingTasks).toHaveBeenCalledTimes(1);
  });

  it("coalesces structural reconciliation and rejects out-of-order terminal regressions", async () => {
    const first = deferred<ProcessingTask[]>();
    const second = deferred<ProcessingTask[]>();
    const third = deferred<ProcessingTask[]>();
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const responses = [first, second, third];
    const listProcessingTasks = vi.fn(() => {
      const response = responses[listProcessingTasks.mock.calls.length - 1];
      if (!response) throw new Error("unexpected processing task refresh");
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      return response.promise.finally(() => {
        activeRequests -= 1;
      });
    });
    const { api, emit } = installOperationsApi({ listProcessingTasks });
    render(<App />);
    await waitFor(() => expect(api.listProcessingTasks).toHaveBeenCalledOnce());
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: /打开 项目周会/ }));

    emit({
      protocolVersion: 2,
      jobId: 7,
      attempt: 2,
      state: "running",
      phase: "asr",
      progressFraction: 0.7,
    });
    emit({
      protocolVersion: 2,
      jobId: 7,
      attempt: 2,
      state: "completed",
      phase: "asr",
      progressFraction: 1,
    });
    first.resolve([runningTask]);

    expect(
      await screen.findByRole("heading", { name: "已完成" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(api.listProcessingTasks).toHaveBeenCalledTimes(2),
    );
    emit({
      protocolVersion: 2,
      jobId: 7,
      attempt: 2,
      state: "running",
      phase: "asr",
      progressFraction: 0.2,
    });
    const unknown: OperationEvent = {
      protocolVersion: 2,
      jobId: 8,
      attempt: 1,
      state: "queued",
      phase: "asr",
      progressFraction: 0,
    };
    emit(unknown);
    emit(unknown);
    expect(screen.getByRole("heading", { name: "已完成" })).toBeVisible();

    second.resolve([
      { ...runningTask, state: "completed", progressFraction: 1 },
      { ...runningTask, id: 8, displayName: "新任务.wav", state: "queued" },
    ]);
    await waitFor(() =>
      expect(api.listProcessingTasks).toHaveBeenCalledTimes(3),
    );
    third.resolve([
      { ...runningTask, state: "completed", progressFraction: 1 },
      { ...runningTask, id: 8, displayName: "新任务.wav", state: "queued" },
    ]);
    await waitFor(() => expect(activeRequests).toBe(0));
    expect(maximumActiveRequests).toBe(1);
    expect(api.listProcessingTasks).toHaveBeenCalledTimes(3);
  });

  it("unsubscribes and ignores operation events after unmount", async () => {
    const initial = deferred<ProcessingTask[]>();
    const { api, emit, unsubscribeOperation } = installOperationsApi({
      listProcessingTasks: vi.fn(() => initial.promise),
    });
    const view = render(<App />);
    await waitFor(() => expect(api.listProcessingTasks).toHaveBeenCalledOnce());
    view.unmount();
    emit({
      protocolVersion: 2,
      jobId: 7,
      attempt: 2,
      state: "running",
      phase: "asr",
      progressFraction: 0.8,
    });
    initial.resolve([runningTask]);
    await act(async () => await initial.promise);

    expect(unsubscribeOperation).toHaveBeenCalledOnce();
    expect(api.listProcessingTasks).toHaveBeenCalledOnce();
  });

  it("drops a late old-attempt event after retry reconciliation and accepts the new attempt", async () => {
    const interrupted = { ...runningTask, state: "interrupted" as const };
    const queuedNext = {
      ...runningTask,
      attempt: 3,
      state: "queued" as const,
      progressFraction: 0,
    };
    const listProcessingTasks = vi
      .fn<() => Promise<ProcessingTask[]>>()
      .mockResolvedValueOnce([interrupted])
      .mockResolvedValueOnce([queuedNext])
      .mockResolvedValue([queuedNext]);
    const retryProcessing = vi.fn(async () => ({
      protocolVersion: 2 as const,
      jobId: 7,
      state: "queued" as const,
    }));
    const { emit } = installOperationsApi({
      listProcessingTasks,
      retryProcessing,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /打开 项目周会/ }),
    );

    await user.click(
      await screen.findByRole("button", { name: "重试 项目周会.wav" }),
    );
    await waitFor(() => expect(listProcessingTasks).toHaveBeenCalledTimes(2));
    expect(screen.getByText("等待处理", { selector: "span" })).toBeVisible();

    emit({
      protocolVersion: 2,
      jobId: 7,
      attempt: 2,
      state: "interrupted",
      phase: "asr",
      progressFraction: 0.6,
    });
    expect(screen.getByText("等待处理", { selector: "span" })).toBeVisible();

    emit({
      protocolVersion: 2,
      jobId: 7,
      attempt: 3,
      state: "running",
      phase: "asr",
      progressFraction: 0.2,
    });
    expect(screen.getByText("正在处理", { selector: "span" })).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "项目周会.wav 处理进度" }),
    ).toHaveValue(0.2);
  });
});
