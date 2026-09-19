// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";

import { LocalModelsFeature } from "../../../src/renderer/features/settings/local-models-feature";
import type { Voice2TextDesktopApi } from "../../../src/shared/contracts";
import {
  companionRendererStubs,
  localModelSnapshot,
} from "../../fixtures/companion";

afterEach(() => vi.restoreAllMocks());

it("keeps the grouped-list geometry while the snapshot is loading", async () => {
  let resolveSnapshot!: (snapshot: typeof localModelSnapshot) => void;
  const api = {
    ...companionRendererStubs(),
    getLocalModelSnapshot: vi.fn(
      () =>
        new Promise<typeof localModelSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    ),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });

  const { container } = render(<LocalModelsFeature />);

  expect(screen.getByRole("status", { name: "正在读取设置" })).toHaveClass(
    "rounded-xl",
    "border",
  );
  expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(9);
  expect(screen.queryByText("正在读取本地模型…")).toBeNull();

  await act(async () => resolveSnapshot(localModelSnapshot));
  expect(
    await screen.findByRole("region", { name: "本地模型设置" }),
  ).toBeVisible();
});

it("shows both bundles without exposing Runtime, file-location, or unavailable model actions", async () => {
  const api = {
    ...companionRendererStubs(),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });

  render(<LocalModelsFeature />);

  expect(
    await screen.findByRole("region", { name: "本地模型设置" }),
  ).toBeVisible();
  expect(screen.queryByRole("heading", { name: "本地模型" })).toBeNull();
  expect(screen.queryByText(localModelSnapshot.storage.displayPath)).toBeNull();
  expect(screen.queryByText("本地模型文件所在位置")).toBeNull();
  expect(screen.queryByText("本地处理组件")).toBeNull();
  expect(screen.getByText("本地转写")).toBeVisible();
  expect(screen.getByText("实时字幕")).toBeVisible();
  const list = screen.getByRole("list");
  expect(list).toHaveAttribute("data-slot", "item-group");
  expect(list.querySelectorAll('[data-slot="item"]')).toHaveLength(2);
  expect(list.querySelectorAll('[data-slot="item-separator"]')).toHaveLength(1);
  expect(list).toHaveClass(
    "[&_[data-slot=item-title]]:text-sm",
    "[&_[data-slot=item-title]]:leading-5",
    "[&_[data-slot=item-description]]:line-clamp-1",
    "[&_[data-slot=item-description]]:text-xs",
    "[&_[data-slot=item-description]]:leading-4",
  );
  expect(list.querySelector('[data-slot="item-description"]')).toHaveClass(
    "text-sm",
    "leading-normal",
    "text-muted-foreground",
  );
  expect(screen.getAllByText("正式下载尚未开放")).toHaveLength(2);
  expect(
    screen.queryByRole("button", { name: /修复/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "下载" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开文件位置" })).toBeNull();
  expect(screen.queryByRole("button", { name: "修改默认路径" })).toBeNull();
  expect(list.querySelectorAll('[data-slot="item-media"]')).toHaveLength(0);
  for (const status of screen.getAllByText("未安装")) {
    expect(status.closest('[data-slot="item-actions"]')).not.toBeNull();
  }
});

it("keeps raw local-model failures out of the rendered settings", async () => {
  const api = {
    ...companionRendererStubs(),
    getLocalModelSnapshot: vi.fn(async () => {
      throw new Error("raw /private/models failure");
    }),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });

  render(<LocalModelsFeature />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "无法读取本地模型，请重试。",
  );
  expect(screen.queryByText(/private\/models/)).not.toBeInTheDocument();
});

it("uses an operation-specific fallback without exposing mutation errors", async () => {
  const toastError = vi.spyOn(toast, "error");
  const installed = {
    ...localModelSnapshot,
    bundles: localModelSnapshot.bundles.map((bundle, index) =>
      index === 0
        ? {
            ...bundle,
            state: "installed" as const,
            version: "1.0.0",
          }
        : bundle,
    ),
  };
  const api = {
    ...companionRendererStubs(),
    getLocalModelSnapshot: vi.fn(async () => installed),
    sendLocalModelIntent: vi.fn(async () => {
      throw new Error("raw /private/models mutation failure");
    }),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });

  render(<LocalModelsFeature />);
  await userEvent
    .setup()
    .click(await screen.findByRole("button", { name: "删除" }));

  await vi.waitFor(() =>
    expect(toastError).toHaveBeenCalledWith(
      "本地模型操作未完成，请重试。",
      expect.objectContaining({
        id: "local-model:delete:formal-transcription",
      }),
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/private\/models/)).not.toBeInTheDocument();
});

it("shows confirmed bytes, progress, speed, pause, and cancel while downloading", async () => {
  const downloading = {
    ...localModelSnapshot,
    bundles: localModelSnapshot.bundles.map((bundle, index) =>
      index === 0
        ? {
            ...bundle,
            state: "downloading" as const,
            distributionEligible: true,
            expectedBytes: 8 * 1024 * 1024,
            progressBytes: 2 * 1024 * 1024,
          }
        : bundle,
    ),
    operation: {
      id: "download-fixture",
      kind: "download" as const,
      bundleId: "formal-transcription" as const,
      phase: null,
      cancelable: true,
      copiedBytes: 2 * 1024 * 1024,
      totalBytes: 8 * 1024 * 1024,
      bytesPerSecond: 1024 * 1024,
      message: null,
    },
  };
  const api = {
    ...companionRendererStubs(),
    getLocalModelSnapshot: vi.fn(async () => downloading),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });

  render(<LocalModelsFeature />);

  expect(await screen.findByText(/2\.0 MB/)).toHaveTextContent(
    "2.0 MB / 8.0 MB · 1.0 MB/s",
  );
  expect(screen.getByText("25%")).toBeVisible();
  expect(screen.getByRole("button", { name: "暂停" })).toBeVisible();
  expect(screen.getByRole("button", { name: "取消" })).toBeVisible();
});
