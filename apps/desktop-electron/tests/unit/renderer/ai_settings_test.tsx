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
    saveAiSettings: vi.fn(async () => configured),
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
      await screen.findByRole("heading", { name: "可选音频智能" }),
    ).toBeVisible();
    expect(screen.getByText("DeepSeek · deepseek-chat")).toBeVisible();
    expect(
      screen.getByText(/每次生成都需要针对当前音频单独同意/),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "配置提供商" }));
    const dialog = screen.getByRole("dialog", { name: "配置音频智能提供商" });
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "音频智能提供商" }),
      "openai-compatible",
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
    await user.click(within(dialog).getByRole("button", { name: "保存配置" }));

    await waitFor(() =>
      expect(desktop.saveAiSettings).toHaveBeenCalledWith({
        providerId: "openai-compatible",
        modelId: "custom-model",
        endpoint: "https://ai.example.com",
      }),
    );
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
      render(<AiSettingsFeature api={desktop} />);

      expect(await screen.findByText(copy)).toBeVisible();
      expect(
        screen.getByRole("button", { name: /输入.*密钥|重新输入密钥/ }),
      ).toBeEnabled();
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
      name: "输入 DeepSeek 密钥",
    });

    open.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "输入 DeepSeek 密钥" });
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
      await screen.findByRole("button", { name: "输入 DeepSeek 密钥" }),
    );
    const secret = screen.getByLabelText("API 密钥");
    await user.type(secret, "keychain-only-secret");
    await user.click(screen.getByRole("button", { name: "保存到钥匙串" }));

    await waitFor(() =>
      expect(desktop.replaceAiProviderSecret).toHaveBeenCalledWith({
        providerId: "deepseek",
        secret: "keychain-only-secret",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("keychain-only-secret")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "替换 DeepSeek 密钥" }),
    ).toBeVisible();
  });

  it.each([
    ["enabled", "FileVault 磁盘加密已启用"],
    ["disabled", "FileVault 磁盘加密未启用"],
    ["unknown", "无法确认 FileVault 状态"],
  ] as const)(
    "describes FileVault %s without claiming app database encryption",
    async (fileVault, title) => {
      const desktop = api({
        getAiSettings: vi.fn(async () => ({
          ...configured,
          deviceSecurity: {
            ...configured.deviceSecurity,
            fileVaultState: fileVault,
          },
        })),
      });
      render(<AiSettingsFeature api={desktop} />);

      expect(await screen.findByText(title)).toBeVisible();
      expect(
        screen.getByText(/没有应用层整库加密|未宣称.*应用层.*加密/),
      ).toBeVisible();
      expect(screen.queryByText(/数据库已由应用加密/)).not.toBeInTheDocument();
    },
  );
});
