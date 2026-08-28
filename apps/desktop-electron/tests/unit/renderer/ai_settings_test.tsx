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
  displayName: "deepseek-chat",
  protocol: "deepseek",
  modelId: "deepseek-chat",
  modelSummary: "deepseek-chat",
  endpoint: "https://api.deepseek.com",
  endpointOrigin: "https://api.deepseek.com",
  processingLocation: "cloudDirect",
  requiresConsent: true,
  capabilities: { selectable: true, editable: true, deletable: true },
  secretState: "available",
};

const teamProfile: CustomAiProviderProfile = {
  profileId: "profile-team",
  kind: "custom",
  displayName: "team-chat",
  protocol: "openai-compatible",
  modelId: "team-chat",
  modelSummary: "team-chat",
  endpoint: "https://ai.example.com/v1",
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
    updateAiProviderProfile: vi.fn(async () => changed({})),
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
  it("sanitizes an initial settings-load failure", async () => {
    const rawDiagnostic = "EACCES /private/credentials/provider.json";
    render(
      <AiSettingsFeature
        api={api({
          getAiSettings: vi.fn(async () => {
            throw new Error(rawDiagnostic);
          }),
        })}
        settingsPage
      />,
    );

    expect(
      (await screen.findAllByText("无法读取云端模型设置"))[0],
    ).toBeVisible();
    expect(screen.queryByText(rawDiagnostic)).not.toBeInTheDocument();
  });

  it("uses provider color for selection without locking the selected profile", async () => {
    render(<AiSettingsFeature api={api()} settingsPage />);
    expect(
      await screen.findByRole("heading", { name: "云端模型" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "新增云端模型" })).toBeVisible();
    expect(screen.getByText("deepseek-chat")).toBeVisible();
    expect(screen.getByText("team-chat")).toBeVisible();
    expect(
      screen.getByText("OpenAI-compatible · https://ai.example.com/v1"),
    ).toHaveAttribute("title", "OpenAI-compatible · https://ai.example.com/v1");
    expect(
      screen.getByText("DeepSeek · https://api.deepseek.com"),
    ).toBeVisible();
    expect(screen.queryByText("团队模型")).toBeNull();
    const radios = screen.getAllByRole("radio");
    const deepseekRow = screen
      .getByText("deepseek-chat")
      .closest<HTMLElement>('[data-slot="item"]');
    const teamRow = screen
      .getByText("team-chat")
      .closest<HTMLElement>('[data-slot="item"]');
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(deepseekRow?.querySelector("img")).toHaveClass("size-5");
    expect(deepseekRow?.querySelector("img")).not.toHaveClass("grayscale");
    expect(teamRow?.querySelector("svg")).toHaveClass("text-muted-foreground");
    expect(screen.queryByLabelText("当前模型")).toBeNull();
    expect(screen.queryByLabelText("未选择")).toBeNull();
    const selectedEdit = screen.getByRole("button", {
      name: "编辑 deepseek-chat",
    });
    expect(selectedEdit).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "编辑 team-chat" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
    expect(screen.queryByText(/钥匙串|FileVault/)).toBeNull();
  });

  it("shows task-locked profiles as read-only with only cancel available", async () => {
    const lockedProfile = {
      ...deepseekProfile,
      capabilities: {
        ...deepseekProfile.capabilities,
        editable: false,
        deletable: false,
      },
    };
    const desktop = api({
      getAiSettings: vi.fn(async () => ({
        ...configured,
        profiles: [lockedProfile],
      })),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "编辑 deepseek-chat" }),
    );
    const dialog = screen.getByRole("dialog", { name: "编辑 deepseek-chat" });
    expect(
      within(dialog).getByText("该模型正在被任务使用，无法修改配置。"),
    ).toBeVisible();
    expect(within(dialog).getByLabelText("接口类型")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    for (const label of ["模型 ID", "API 地址", "API 密钥"]) {
      const field = within(dialog).getByLabelText(label);
      expect(field).not.toBeDisabled();
      expect(field).toHaveAttribute("readonly");
    }
    expect(within(dialog).queryByRole("button", { name: "保存" })).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "删除模型" }),
    ).toBeNull();
    expect(within(dialog).getAllByRole("button")).toHaveLength(2);
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeVisible();
  });

  it("forwards controlled selection with the current revision and fences pending mutations", async () => {
    let resolveSelection!: (settings: AiSettingsSnapshot) => void;
    const desktop = api({
      selectAiProviderProfile: vi.fn(
        () =>
          new Promise<AiSettingsSnapshot>((resolve) => {
            resolveSelection = resolve;
          }),
      ),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    const radios = await screen.findAllByRole("radio");
    const deepseekRow = screen
      .getByText("deepseek-chat")
      .closest<HTMLElement>('[data-slot="item"]');
    const teamRow = screen
      .getByText("team-chat")
      .closest<HTMLElement>('[data-slot="item"]');
    await user.click(screen.getByText("team-chat"));
    expect(desktop.selectAiProviderProfile).toHaveBeenCalledOnce();
    expect(desktop.selectAiProviderProfile).toHaveBeenCalledWith({
      profileId: teamProfile.profileId,
      expectedRevision: 4,
    });
    await waitFor(() => expect(radios[0]).toBeDisabled());
    await user.click(radios[0]!);
    expect(desktop.selectAiProviderProfile).toHaveBeenCalledOnce();

    resolveSelection(changed({ selectedProfileId: teamProfile.profileId }));
    await waitFor(() => {
      expect(deepseekRow?.querySelector("img")).toHaveClass(
        "grayscale",
        "opacity-50",
      );
      expect(teamRow?.querySelector("svg")).toHaveClass("text-primary");
    });
  });

  it("shows deletion only in edit mode and restores focus after cancel", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "编辑 team-chat" }),
    );
    expect(desktop.selectAiProviderProfile).not.toHaveBeenCalled();
    const edit = screen.getByRole("dialog", { name: "编辑 team-chat" });
    const remove = within(edit).getByRole("button", { name: "删除模型" });
    expect(remove).not.toHaveTextContent("删除模型");
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
    expect(desktop.selectAiProviderProfile).not.toHaveBeenCalled();
  });

  it("focuses the next profile after deleting a middle row", async () => {
    const thirdProfile: CustomAiProviderProfile = {
      ...teamProfile,
      profileId: "profile-third",
      displayName: "third-chat",
      modelId: "third-chat",
      modelSummary: "third-chat",
    };
    const desktop = api({
      getAiSettings: vi.fn(async () => ({
        ...configured,
        profiles: [deepseekProfile, teamProfile, thirdProfile],
      })),
      deleteAiProviderProfile: vi.fn(async () =>
        changed({ profiles: [deepseekProfile, thirdProfile] }),
      ),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);

    await user.click(
      await screen.findByRole("button", { name: "编辑 team-chat" }),
    );
    await user.click(screen.getByRole("button", { name: "删除模型" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "third-chat" })).toHaveFocus(),
    );
  });

  it("focuses the add action after deleting the final profile", async () => {
    const desktop = api({
      getAiSettings: vi.fn(async () => ({
        ...configured,
        profiles: [deepseekProfile],
      })),
      deleteAiProviderProfile: vi.fn(async () =>
        changed({ profiles: [], selectedProfileId: null }),
      ),
    });
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);

    await user.click(
      await screen.findByRole("button", { name: "编辑 deepseek-chat" }),
    );
    await user.click(screen.getByRole("button", { name: "删除模型" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "新增云端模型" }),
      ).toHaveFocus(),
    );
  });

  it("creates with only operational fields and an ephemeral key", async () => {
    const desktop = api();
    const user = userEvent.setup();
    render(<AiSettingsFeature api={desktop} settingsPage />);
    await user.click(
      await screen.findByRole("button", { name: "新增云端模型" }),
    );
    const dialog = screen.getByRole("dialog", { name: "新增云端模型" });
    expect(
      ["接口类型", "模型 ID", "API 地址", "API 密钥"].map(
        (label) => within(dialog).getByLabelText(label).id,
      ),
    ).toEqual([
      "ai-provider-protocol",
      "ai-provider-model",
      "ai-provider-endpoint",
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
        protocol: "openai-compatible",
        endpoint: "https://personal.example.com",
        modelId: "personal-chat",
        secret: "create-secret",
      }),
    );
    expect(screen.queryByText("create-secret")).toBeNull();
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
