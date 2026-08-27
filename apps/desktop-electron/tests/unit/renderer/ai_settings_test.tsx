// @vitest-environment jsdom

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AiSettingsFeature } from "../../../src/renderer/features/settings/ai-settings-feature";
import type {
  AiSettingsSnapshot,
  CustomAiProviderProfile,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

const deepseekProfile: CustomAiProviderProfile = {
  profileId: "profile-deepseek",
  kind: "custom",
  configurationName: null,
  displayName: "deepseek-chat",
  protocol: "deepseek",
  modelId: "deepseek-chat",
  modelSummary: "deepseek-chat",
  endpoint: "https://api.deepseek.com",
  endpointOrigin: "https://api.deepseek.com",
  processingLocation: "cloudDirect",
  requiresConsent: true,
  capabilities: { selectable: true, editable: false, deletable: false },
  secretState: "available",
};

const teamProfile: CustomAiProviderProfile = {
  profileId: "profile-team",
  kind: "custom",
  configurationName: "团队模型",
  displayName: "team-chat",
  protocol: "openai-compatible",
  modelId: "team-chat",
  modelSummary: "team-chat",
  endpoint: "https://ai.example.com",
  endpointOrigin: "https://ai.example.com",
  processingLocation: "cloudDirect",
  requiresConsent: true,
  capabilities: { selectable: true, editable: true, deletable: true },
  secretState: "missing",
};

const configured: AiSettingsSnapshot = {
  revision: 4,
  profiles: [deepseekProfile, teamProfile],
  selectedProfileId: deepseekProfile.profileId,
  deviceSecurity: {
    kind: "device-security",
    fileVaultState: "enabled",
    applicationLayerEncryption: "not-claimed",
  },
};

function changed(changes: Partial<AiSettingsSnapshot>): AiSettingsSnapshot {
  return { ...configured, revision: 5, ...changes };
}

function api(overrides: Record<string, unknown> = {}) {
  const desktop = {
    getAiSettings: vi.fn(async () => configured),
    createAiProviderProfile: vi.fn(async () =>
      changed({ selectedProfileId: "profile-new" }),
    ),
    updateAiProviderProfile: vi.fn(async () =>
      changed({
        profiles: configured.profiles.map((profile) =>
          profile.profileId === teamProfile.profileId
            ? { ...profile, configurationName: "团队新模型" }
            : profile,
        ),
      }),
    ),
    selectAiProviderProfile: vi.fn(async () =>
      changed({ selectedProfileId: teamProfile.profileId }),
    ),
    deleteAiProviderProfile: vi.fn(async () =>
      changed({ profiles: [deepseekProfile] }),
    ),
    generateAudioAi: vi.fn(),
    retryAudioAi: vi.fn(),
    ...overrides,
  };
  return desktop as typeof desktop & Voice2TextDesktopApi;
}

describe("cloud model settings", () => {
  it("separates branding, model identity, selection, and edit state", async () => {
    render(<AiSettingsFeature api={api()} settingsPage />);
    expect(
      await screen.findByRole("heading", { name: "云端模型" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "新增云端模型" })).toBeVisible();
    expect(screen.getByText("deepseek-chat")).toBeVisible();
    expect(screen.getByText("team-chat")).toBeVisible();
    expect(screen.getByText(/团队模型 · OpenAI-compatible/)).toBeVisible();
    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]?.querySelector("img")).not.toBeNull();
    expect(radios[1]?.querySelector("img")).toBeNull();
    const selectedEdit = screen.getByRole("button", {
      name: "编辑 deepseek-chat",
    });
    expect(selectedEdit).toBeDisabled();
    expect(selectedEdit).toHaveAttribute(
      "title",
      "当前模型正在使用，请先切换到其他模型。",
    );
    expect(
      screen.getByRole("button", { name: "编辑 team-chat" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
    expect(screen.queryByText(/钥匙串|FileVault/)).toBeNull();
  });

  it("keeps click, Space, and arrow-key radio selection", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    const radios = await screen.findAllByRole("radio");
    await user.click(radios[1]!);
    expect(desktop.selectAiProviderProfile).toHaveBeenLastCalledWith({
      profileId: teamProfile.profileId,
      expectedRevision: 4,
    });
    desktop.selectAiProviderProfile.mockClear();
    radios[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(radios[1]).toHaveFocus();
    expect(desktop.selectAiProviderProfile).toHaveBeenCalledTimes(1);
    desktop.selectAiProviderProfile.mockClear();
    await user.keyboard(" ");
    expect(desktop.selectAiProviderProfile).toHaveBeenCalledTimes(1);
  });

  it("shows deletion only in edit mode and restores focus after cancel", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "编辑 team-chat" }),
    );
    const edit = screen.getByRole("dialog", { name: "编辑 team-chat" });
    const remove = within(edit).getByRole("button", { name: "删除模型" });
    remove.focus();
    await user.click(remove);
    let alert = screen.getByRole("alertdialog", { name: "删除 team-chat？" });
    expect(within(alert).getByText("确定要删除“team-chat”吗？")).toBeVisible();
    await user.click(within(alert).getByRole("button", { name: "取消" }));
    expect(remove).toHaveFocus();
    expect(desktop.deleteAiProviderProfile).not.toHaveBeenCalled();
    await user.click(remove);
    alert = screen.getByRole("alertdialog", { name: "删除 team-chat？" });
    await user.click(within(alert).getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(desktop.deleteAiProviderProfile).toHaveBeenCalledWith({
        profileId: teamProfile.profileId,
        expectedRevision: 4,
      }),
    );
    await waitFor(() => expect(screen.getByRole("radio")).toHaveFocus());
  });

  it("creates with ordered fields, an optional name, and an ephemeral key", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "新增云端模型" }),
    );
    const dialog = screen.getByRole("dialog", { name: "新增云端模型" });
    expect(
      ["接口类型", "模型 ID", "API 地址", "配置名称（可选）", "API 密钥"].map(
        (label) => within(dialog).getByLabelText(label).id,
      ),
    ).toEqual([
      "ai-provider-protocol",
      "ai-provider-model",
      "ai-provider-endpoint",
      "ai-provider-name",
      "ai-provider-secret",
    ]);
    await user.click(
      within(dialog).getByRole("combobox", { name: "接口类型" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "OpenAI-compatible" }),
    );
    await user.clear(within(dialog).getByLabelText("模型 ID"));
    await user.type(within(dialog).getByLabelText("模型 ID"), "personal-chat");
    await user.clear(within(dialog).getByLabelText("API 地址"));
    await user.type(
      within(dialog).getByLabelText("API 地址"),
      "https://personal.example.com",
    );
    await user.type(within(dialog).getByLabelText("API 密钥"), "create-secret");
    await user.click(within(dialog).getByRole("button", { name: "新增" }));
    await waitFor(() =>
      expect(desktop.createAiProviderProfile).toHaveBeenCalledWith({
        expectedRevision: 4,
        configurationName: null,
        protocol: "openai-compatible",
        endpoint: "https://personal.example.com",
        modelId: "personal-chat",
        secret: "create-secret",
      }),
    );
    expect(screen.queryByText("create-secret")).toBeNull();
  });

  it("edits optional context without resending the saved key", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "编辑 team-chat" }),
    );
    const dialog = screen.getByRole("dialog", { name: "编辑 team-chat" });
    await user.clear(within(dialog).getByLabelText("配置名称（可选）"));
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(desktop.updateAiProviderProfile).toHaveBeenCalledWith({
        expectedRevision: 4,
        profileId: teamProfile.profileId,
        configurationName: null,
        protocol: "openai-compatible",
        endpoint: "https://ai.example.com",
        modelId: "team-chat",
      }),
    );
  });

  it("shows concise mutation blocks and clears replacement keys", async () => {
    const desktop = api({
      updateAiProviderProfile: vi
        .fn()
        .mockRejectedValueOnce(new Error("AI_SECRET_IN_USE")),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "编辑 team-chat" }),
    );
    const dialog = screen.getByRole("dialog", { name: "编辑 team-chat" });
    await user.type(within(dialog).getByLabelText("API 密钥"), "replacement");
    await user.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "当前密钥正被任务使用，暂时无法更换密钥或删除模型。",
    );
    expect(within(dialog).getByLabelText("API 密钥")).toHaveValue("");
    expect(screen.queryByText("replacement")).toBeNull();
  });

  it("keeps the empty state concise and clears secrets on Escape", async () => {
    const desktop = api({
      getAiSettings: vi.fn(async () => ({
        ...configured,
        profiles: [],
        selectedProfileId: null,
      })),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    expect(await screen.findByText("还没有云端模型")).toBeVisible();
    const add = screen.getByRole("button", { name: "新增云端模型" });
    add.focus();
    await user.keyboard("{Enter}");
    await user.type(screen.getByLabelText("API 密钥"), "discard-me");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("discard-me")).toBeNull();
    expect(add).toHaveFocus();
  });
});
