// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { LocalModelsFeature } from "../../../src/renderer/features/settings/local-models-feature";
import type { Voice2TextDesktopApi } from "../../../src/shared/contracts";
import {
  companionRendererStubs,
  localModelSnapshot,
} from "../../fixtures/companion";

afterEach(() => vi.restoreAllMocks());

it("shows one fixed root, Runtime and both bundles without exposing repair or production downloads", async () => {
  const api = {
    ...companionRendererStubs(),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });

  render(<LocalModelsFeature />);

  expect(
    await screen.findByRole("heading", { name: "本地模型" }),
  ).toBeVisible();
  expect(
    screen.getByText(localModelSnapshot.storage.displayPath),
  ).toBeVisible();
  expect(screen.getByText("Worker Runtime")).toBeVisible();
  expect(screen.getByText("本地转写")).toBeVisible();
  expect(screen.getByText("实时字幕")).toBeVisible();
  expect(screen.getAllByText("正式下载尚未开放")).toHaveLength(2);
  expect(
    screen.queryByRole("button", { name: /修复/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "下载" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "更换位置" })).toBeEnabled();
});
