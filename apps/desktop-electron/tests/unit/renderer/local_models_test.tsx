// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
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

it("shows Runtime and both bundles without exposing file-location or unavailable model actions", async () => {
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
  expect(screen.getByText("Worker Runtime")).toBeVisible();
  expect(screen.getByText("本地转写")).toBeVisible();
  expect(screen.getByText("实时字幕")).toBeVisible();
  const list = screen.getByRole("list");
  expect(list).toHaveAttribute("data-slot", "item-group");
  expect(list.querySelectorAll('[data-slot="item"]')).toHaveLength(3);
  expect(list.querySelectorAll('[data-slot="item-separator"]')).toHaveLength(2);
  expect(list).toHaveClass(
    "[&_[data-slot=item-title]]:text-sm",
    "[&_[data-slot=item-title]]:leading-5",
    "[&_[data-slot=item-description]]:line-clamp-1",
    "[&_[data-slot=item-description]]:text-xs",
    "[&_[data-slot=item-description]]:leading-4",
  );
  expect(list.querySelector('[data-slot="item-description"]')).toHaveClass(
    "text-sm",
    "leading-5",
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
  expect(
    screen.getByText("正常").closest('[data-slot="item-actions"]'),
  ).not.toBeNull();
  for (const status of screen.getAllByText("未安装")) {
    expect(status.closest('[data-slot="item-actions"]')).not.toBeNull();
  }
});
