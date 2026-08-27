// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AiSettingsFeature } from "../../../src/renderer/features/settings/ai-settings-feature";
import type { Voice2TextDesktopApi } from "../../../src/shared/contracts";

const configured = {
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
  secretState: "available" as const,
  deviceSecurity: {
    kind: "device-security" as const,
    fileVaultState: "enabled" as const,
    applicationLayerEncryption: "not-claimed" as const,
  },
};

function api(overrides: Record<string, unknown> = {}) {
  return {
    getAiSettings: vi.fn(async () => configured),
    saveAiSettings: vi.fn(
      async (
        options: Parameters<Voice2TextDesktopApi["saveAiSettings"]>[0],
      ) => ({
        ...configured,
        revision: configured.revision + 1,
        config: {
          ...configured.config,
          ...options,
          displayName:
            options.providerId === "deepseek"
              ? "DeepSeek"
              : "OpenAI-compatible",
          endpointOrigin: new URL(options.endpoint).origin,
        },
      }),
    ),
    replaceAiProviderSecret: vi.fn(async () => configured),
    deleteAiProviderSecret: vi.fn(async () => ({
      ...configured,
      secretState: "missing",
    })),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    ...overrides,
  } as unknown as Voice2TextDesktopApi;
}

describe("AI settings security boundary", () => {
  it("loads and saves local configuration without consent or generation calls", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} />);

    expect(
      await screen.findByRole("region", { name: "音频智能设置" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "可选音频智能" })).toBeNull();
    expect(screen.getByText("DeepSeek · deepseek-chat")).toBeVisible();
    const settingsRegion = screen.getByRole("region", {
      name: "音频智能设置",
    });
    expect(within(settingsRegion).getAllByRole("list")).toHaveLength(1);
    expect(settingsRegion.querySelectorAll('[data-slot="item"]')).toHaveLength(
      1,
    );
    expect(
      settingsRegion.querySelectorAll('[data-slot="item-media"]'),
    ).toHaveLength(0);
    expect(
      settingsRegion.querySelector('[data-slot="item-actions"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "管理 AI 供应商" }),
    ).toHaveAttribute("data-size", "sm");
    expect(
      settingsRegion.querySelectorAll('[data-slot="item-separator"]'),
    ).toHaveLength(0);
    expect(
      within(settingsRegion).getAllByText(/DeepSeek · deepseek-chat/),
    ).toHaveLength(1);
    expect(
      screen.queryByText("https://api.deepseek.com"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/每次生成都需要针对当前音频单独同意/),
    ).not.toBeInTheDocument();
    expect(
      settingsRegion.querySelectorAll('[data-slot="item-description"]'),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "管理 AI 供应商" }));
    const dialog = screen.getByRole("dialog", { name: "AI 供应商设置" });
    expect(dialog.querySelector('[data-slot="dialog-header"]')).not.toBeNull();
    expect(dialog.querySelector('[data-slot="dialog-footer"]')).not.toBeNull();
    expect(
      within(dialog).getByRole("textbox", { name: "服务地址" }),
    ).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText("API 密钥")).toHaveAttribute(
      "type",
      "password",
    );
    const provider = within(dialog).getByRole("combobox", {
      name: "音频智能提供商",
    });
    expect(provider).toHaveAttribute("data-slot", "select-trigger");
    await user.type(
      within(dialog).getByLabelText("API 密钥"),
      "must-not-cross-providers",
    );
    await user.click(provider);
    await user.click(
      await screen.findByRole("option", { name: "OpenAI-compatible" }),
    );
    await user.clear(within(dialog).getByRole("textbox", { name: "模型 ID" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "模型 ID" }),
      "custom-model",
    );
    await user.clear(within(dialog).getByRole("textbox", { name: "服务地址" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "服务地址" }),
      "https://ai.example.com",
    );
    await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(desktop.saveAiSettings).toHaveBeenCalledWith({
        providerId: "openai-compatible",
        modelId: "custom-model",
        endpoint: "https://ai.example.com",
      }),
    );
    expect(desktop.replaceAiProviderSecret).not.toHaveBeenCalled();
    expect(
      await screen.findByText("OpenAI-compatible · custom-model"),
    ).toBeVisible();
    expect(desktop.generateAudioAi).not.toHaveBeenCalled();
    expect(desktop.retryAudioAi).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "尚未在 macOS 钥匙串中配置密钥"],
    ["denied", "无法读取 macOS 钥匙串中的密钥"],
    ["corrupt", "macOS 钥匙串中的密钥无法使用"],
  ] as const)(
    "prompts for entry when the secret state is %s",
    async (secretState, copy) => {
      const desktop = api({
        getAiSettings: vi.fn(async () => ({ ...configured, secretState })),
      });
      const user = userEvent.setup();
      render(<AiSettingsFeature api={desktop} />);

      const manage = await screen.findByRole("button", {
        name: "管理 AI 供应商",
      });
      expect(manage).toBeEnabled();
      await user.click(manage);
      expect(await screen.findByText(copy)).toBeVisible();
    },
  );

  it("keeps secrets out of rendered state and restores focus after keyboard cancel", async () => {
    const desktop = api({
      getAiSettings: vi.fn(async () => ({
        ...configured,
        secretState: "missing",
      })),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} />);
    const open = await screen.findByRole("button", {
      name: "管理 AI 供应商",
    });

    open.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "AI 供应商设置" });
    const secret = within(dialog).getByLabelText("API 密钥");
    expect(secret).toHaveAttribute("type", "password");
    await user.type(secret, "never-render-this-secret");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
    expect(
      screen.queryByText("never-render-this-secret"),
    ).not.toBeInTheDocument();
    expect(desktop.replaceAiProviderSecret).not.toHaveBeenCalled();

    await user.click(open);
    expect(screen.getByLabelText("API 密钥")).toHaveValue("");
  });

  it("replaces a missing secret through the Keychain API without rendering it", async () => {
    const desktop = api({
      getAiSettings: vi.fn(async () => ({
        ...configured,
        secretState: "missing",
      })),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} />);

    await user.click(
      await screen.findByRole("button", { name: "管理 AI 供应商" }),
    );
    const secret = screen.getByLabelText("API 密钥");
    await user.type(secret, "keychain-only-secret");
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() =>
      expect(desktop.replaceAiProviderSecret).toHaveBeenCalledWith({
        providerId: "deepseek",
        secret: "keychain-only-secret",
      }),
    );
    expect(desktop.saveAiSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("keychain-only-secret")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "管理 AI 供应商" }));
    expect(
      await screen.findByText("密钥已配置并可由 macOS 钥匙串读取"),
    ).toBeVisible();
  });

  it("deletes the configured secret from the combined provider dialog", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} />);

    await user.click(
      await screen.findByRole("button", { name: "管理 AI 供应商" }),
    );
    const dialog = screen.getByRole("dialog", { name: "AI 供应商设置" });
    await user.click(within(dialog).getByRole("button", { name: "删除密钥" }));

    await waitFor(() =>
      expect(desktop.deleteAiProviderSecret).toHaveBeenCalledWith({
        providerId: "deepseek",
      }),
    );
    expect(
      await within(dialog).findByText("尚未在 macOS 钥匙串中配置密钥"),
    ).toBeVisible();
  });

  it("keeps a saved provider change when the Keychain write fails", async () => {
    const desktop = api({
      replaceAiProviderSecret: vi.fn(async () => {
        throw new Error("无法写入 macOS 钥匙串");
      }),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} />);

    await user.click(
      await screen.findByRole("button", { name: "管理 AI 供应商" }),
    );
    const dialog = screen.getByRole("dialog", { name: "AI 供应商设置" });
    await user.click(
      within(dialog).getByRole("combobox", { name: "音频智能提供商" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "OpenAI-compatible" }),
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "模型 ID" }),
      "custom-model",
    );
    await user.clear(within(dialog).getByRole("textbox", { name: "服务地址" }));
    await user.type(
      within(dialog).getByRole("textbox", { name: "服务地址" }),
      "https://ai.example.com",
    );
    await user.type(
      within(dialog).getByLabelText("API 密钥"),
      "one-time-secret",
    );
    await user.click(within(dialog).getByRole("button", { name: "保存设置" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "无法写入 macOS 钥匙串",
    );
    expect(screen.getByText("OpenAI-compatible · custom-model")).toBeVisible();
    expect(within(dialog).getByLabelText("API 密钥")).toHaveValue("");
  });
});
