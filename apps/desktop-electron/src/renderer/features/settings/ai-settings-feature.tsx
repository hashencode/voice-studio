import * as React from "react";
import { LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SettingsItemGroup,
  SettingsListSkeleton,
  SettingsPageSection,
} from "@/features/settings/settings-page-section";
import { userFacingError } from "@/lib/user-facing-error";
import type {
  AiProviderProfile,
  AiSettingsSnapshot,
  CustomAiProviderProfile,
  Voice2TextDesktopApi,
} from "@shared/contracts";
import { ModelProviderIcon } from "./model-provider-icons";

type ProviderProtocol = CustomAiProviderProfile["protocol"];
type DialogMode =
  { kind: "add" } | { kind: "edit"; profile: CustomAiProviderProfile };

const providerDefaults: Record<
  ProviderProtocol,
  { modelId: string; endpoint: string }
> = {
  deepseek: {
    modelId: "deepseek-chat",
    endpoint: "https://api.deepseek.com",
  },
  "openai-compatible": {
    modelId: "",
    endpoint: "https://example.com",
  },
};

export function AiSettingsFeature({
  api = window.voice2text,
  settingsPage = false,
}: {
  api?: Voice2TextDesktopApi;
  settingsPage?: boolean;
}) {
  const [settings, setSettings] = React.useState<AiSettingsSnapshot | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(true);
  const [mutationPending, setMutationPending] = React.useState(false);

  const load = React.useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const next = await api.getAiSettings();
      setSettings(next);
      return next;
    } catch (cause) {
      setError(userFacingError(cause, "无法读取云端模型设置"));
      return null;
    } finally {
      setPending(false);
    }
  }, [api]);

  React.useEffect(() => {
    let active = true;
    void api
      .getAiSettings()
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(userFacingError(cause, "无法读取云端模型设置"));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (!settings && pending) {
    return settingsPage ? (
      renderSettingsPageSection(<SettingsListSkeleton rows={2} />)
    ) : (
      <div
        role="status"
        className="flex min-h-52 items-center justify-center gap-2"
      >
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        正在读取云端模型
      </div>
    );
  }

  if (!settings) {
    const unavailable = (
      <SettingsItemGroup>
        <Item role="listitem" className="rounded-none">
          <ItemContent>
            <ItemTitle>无法读取云端模型设置</ItemTitle>
            <ItemDescription>{error ?? "设置暂不可用"}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
            >
              重新读取
            </Button>
          </ItemActions>
        </Item>
      </SettingsItemGroup>
    );
    return settingsPage ? renderSettingsPageSection(unavailable) : unavailable;
  }

  const add = (
    <ProviderProfileDialog
      mode={{ kind: "add" }}
      settings={settings}
      api={api}
      disabled={mutationPending}
      onPendingChange={setMutationPending}
      onSaved={setSettings}
      onReload={load}
    />
  );
  const content = (
    <ProviderProfileList
      settings={settings}
      api={api}
      error={error}
      mutationPending={mutationPending}
      onPendingChange={setMutationPending}
      onSaved={setSettings}
      onError={setError}
      onReload={load}
    />
  );

  if (settingsPage) {
    return renderSettingsPageSection(content, add);
  }
  return (
    <section aria-label="音频智能设置">
      <div className="mb-3 flex justify-end">{add}</div>
      {content}
    </section>
  );
}

function renderSettingsPageSection(
  cloudModels: React.ReactNode,
  action?: React.ReactNode,
) {
  return (
    <section aria-label="音频智能设置">
      <SettingsPageSection
        section="cloud-models"
        title="云端模型"
        action={action}
      >
        {cloudModels}
      </SettingsPageSection>
    </section>
  );
}

function ProviderProfileList({
  settings,
  api,
  error,
  mutationPending,
  onPendingChange,
  onSaved,
  onError,
  onReload,
}: {
  settings: AiSettingsSnapshot;
  api: Voice2TextDesktopApi;
  error: string | null;
  mutationPending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSaved: (settings: AiSettingsSnapshot) => void;
  onError: (error: string | null) => void;
  onReload: () => Promise<AiSettingsSnapshot | null>;
}) {
  const selectProfile = (profile: AiProviderProfile) => {
    if (mutationPending || !profile.capabilities.selectable) return;
    onPendingChange(true);
    onError(null);
    void api
      .selectAiProviderProfile({
        profileId: profile.profileId,
        expectedRevision: settings.revision,
      })
      .then(onSaved)
      .catch(async (cause: unknown) => {
        if (isStaleRevision(cause)) {
          await onReload();
          onError("设置已更新，请重试");
        } else {
          onError(userFacingError(cause, "无法切换模型"));
        }
      })
      .finally(() => onPendingChange(false));
  };

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {settings.profiles.length === 0 ? (
        <SettingsItemGroup>
          <Item role="listitem" className="rounded-none">
            <ItemContent>
              <ItemTitle>还没有云端模型</ItemTitle>
              <ItemDescription>新增一个云端模型即可开始使用</ItemDescription>
            </ItemContent>
          </Item>
        </SettingsItemGroup>
      ) : (
        <SettingsItemGroup role="radiogroup" aria-label="云端模型">
          {settings.profiles.map((profile, index) => {
            const selected = settings.selectedProfileId === profile.profileId;
            const custom = profile.kind === "custom" ? profile : null;
            const isRovingTabStop =
              selected || (settings.selectedProfileId === null && index === 0);
            return (
              <Item
                key={profile.profileId}
                className="rounded-none data-[selected=true]:bg-muted/50"
                data-selected={selected}
              >
                <div
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={mutationPending || undefined}
                  data-profile-radio={profile.profileId}
                  tabIndex={mutationPending || !isRovingTabStop ? -1 : 0}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-4 rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
                  onClick={() => selectProfile(profile)}
                  onKeyDown={(event) => {
                    if (event.key === " ") {
                      event.preventDefault();
                      selectProfile(profile);
                      return;
                    }
                    if (
                      ![
                        "ArrowDown",
                        "ArrowLeft",
                        "ArrowRight",
                        "ArrowUp",
                      ].includes(event.key)
                    )
                      return;
                    event.preventDefault();
                    const direction =
                      event.key === "ArrowDown" || event.key === "ArrowRight"
                        ? 1
                        : -1;
                    const nextIndex =
                      (index + direction + settings.profiles.length) %
                      settings.profiles.length;
                    const radios = event.currentTarget
                      .closest('[role="radiogroup"]')
                      ?.querySelectorAll<HTMLElement>('[role="radio"]');
                    radios?.[nextIndex]?.focus();
                    selectProfile(settings.profiles[nextIndex]!);
                  }}
                >
                  <ItemMedia aria-hidden="true">
                    {custom ? (
                      <ModelProviderIcon
                        protocol={custom.protocol}
                        active={selected}
                      />
                    ) : null}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{profile.modelSummary}</ItemTitle>
                    <ItemDescription
                      title={custom ? interfaceSummary(custom) : undefined}
                    >
                      {custom ? interfaceSummary(custom) : profile.displayName}
                    </ItemDescription>
                  </ItemContent>
                </div>
                {custom ? (
                  <ItemActions>
                    <ProviderProfileDialog
                      mode={{ kind: "edit", profile: custom }}
                      settings={settings}
                      api={api}
                      disabled={mutationPending}
                      onPendingChange={onPendingChange}
                      onSaved={onSaved}
                      onReload={onReload}
                      onDeleted={(deletedProfileId, next) => {
                        onSaved(next);
                        focusAfterProfileDeletion(
                          settings.profiles,
                          deletedProfileId,
                          next.profiles,
                        );
                      }}
                    />
                  </ItemActions>
                ) : null}
              </Item>
            );
          })}
        </SettingsItemGroup>
      )}
    </>
  );
}

function ProviderProfileDialog({
  mode,
  settings,
  api,
  disabled,
  onPendingChange,
  onSaved,
  onReload,
  onDeleted,
}: {
  mode: DialogMode;
  settings: AiSettingsSnapshot;
  api: Voice2TextDesktopApi;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onSaved: (settings: AiSettingsSnapshot) => void;
  onReload: () => Promise<AiSettingsSnapshot | null>;
  onDeleted?: (profileId: string, settings: AiSettingsSnapshot) => void;
}) {
  const profile = mode.kind === "edit" ? mode.profile : null;
  const [open, setOpen] = React.useState(false);
  const [protocol, setProtocol] = React.useState<ProviderProtocol>("deepseek");
  const [endpoint, setEndpoint] = React.useState(
    providerDefaults.deepseek.endpoint,
  );
  const [modelId, setModelId] = React.useState(
    providerDefaults.deepseek.modelId,
  );
  const [secret, setSecret] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const readOnly = Boolean(profile && !profile.capabilities.editable);

  const reset = React.useCallback(() => {
    const initialProtocol = profile?.protocol ?? "deepseek";
    const defaults = providerDefaults[initialProtocol];
    setProtocol(initialProtocol);
    setEndpoint(profile?.endpoint ?? defaults.endpoint);
    setModelId(profile?.modelId ?? defaults.modelId);
    setSecret("");
    setError(null);
  }, [profile]);

  const title = profile ? `编辑 ${profile.modelId}` : "新增云端模型";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) reset();
        else {
          setSecret("");
          setDeleteOpen(false);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || (mode.kind === "edit" && !profile)}
          aria-label={profile ? `编辑 ${profile.modelId}` : "新增云端模型"}
          data-add-model={profile ? undefined : "true"}
          data-profile-edit={profile?.profileId}
        >
          {profile ? <Pencil /> : <Plus />}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={readOnly ? undefined : "sr-only"}>
            {readOnly
              ? "该模型正在被任务使用，无法修改配置。"
              : "填写云端模型信息"}
          </DialogDescription>
        </DialogHeader>
        <ProviderFields
          protocol={protocol}
          endpoint={endpoint}
          modelId={modelId}
          secret={secret}
          editing={Boolean(profile)}
          pending={pending}
          readOnly={readOnly}
          onProtocolChange={(next) => {
            const defaults = providerDefaults[next];
            setProtocol(next);
            setEndpoint(defaults.endpoint);
            setModelId(defaults.modelId);
            setSecret("");
            setError(null);
          }}
          onEndpointChange={setEndpoint}
          onModelIdChange={setModelId}
          onSecretChange={setSecret}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className={readOnly ? undefined : "sm:justify-between"}>
          {readOnly ? null : (
            <div>
              {profile ? (
                <AlertDialog
                  open={deleteOpen}
                  onOpenChange={(next) => !pending && setDeleteOpen(next)}
                >
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={pending || !profile.capabilities.deletable}
                      aria-label="删除模型"
                      title="删除模型"
                    >
                      <Trash2 />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{`删除 ${profile.modelId}？`}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {`确定要删除“${profile.modelId}”吗？`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel asChild>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                        >
                          取消
                        </Button>
                      </AlertDialogCancel>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => {
                          setPending(true);
                          onPendingChange(true);
                          setError(null);
                          void api
                            .deleteAiProviderProfile({
                              profileId: profile.profileId,
                              expectedRevision: settings.revision,
                            })
                            .then((next) => {
                              setSecret("");
                              setDeleteOpen(false);
                              setOpen(false);
                              onDeleted?.(profile.profileId, next);
                            })
                            .catch(async (cause: unknown) => {
                              setSecret("");
                              if (isStaleRevision(cause)) {
                                const next = await onReload();
                                const refreshed = next?.profiles.find(
                                  (candidate) =>
                                    candidate.kind === "custom" &&
                                    candidate.profileId === profile.profileId,
                                );
                                if (!refreshed || refreshed.kind !== "custom") {
                                  setDeleteOpen(false);
                                  setOpen(false);
                                }
                                setError("设置已更新，请重试");
                              } else {
                                setError(
                                  mutationErrorMessage(cause, "无法删除模型"),
                                );
                              }
                            })
                            .finally(() => {
                              setPending(false);
                              onPendingChange(false);
                            });
                        }}
                      >
                        删除
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                取消
              </Button>
            </DialogClose>
            {readOnly ? null : (
              <Button
                type="button"
                disabled={
                  pending ||
                  !endpoint.trim() ||
                  !modelId.trim() ||
                  (protocol === "deepseek" &&
                    !modelId.trim().startsWith("deepseek-")) ||
                  (!profile && !secret.trim())
                }
                onClick={() => {
                  const secretValue = secret.trim();
                  const common = {
                    expectedRevision: settings.revision,
                    protocol,
                    endpoint: endpoint.trim(),
                    modelId: modelId.trim(),
                  };
                  setPending(true);
                  onPendingChange(true);
                  setError(null);
                  const request = profile
                    ? api.updateAiProviderProfile({
                        ...common,
                        profileId: profile.profileId,
                        ...(secretValue ? { secret: secretValue } : {}),
                      })
                    : api.createAiProviderProfile({
                        ...common,
                        secret: secretValue,
                      });
                  void request
                    .then((next) => {
                      setSecret("");
                      onSaved(next);
                      setOpen(false);
                    })
                    .catch(async (cause: unknown) => {
                      setSecret("");
                      if (isStaleRevision(cause)) {
                        await onReload();
                        setError("设置已更新，请重试");
                      } else {
                        setError(mutationErrorMessage(cause, "无法保存模型"));
                      }
                    })
                    .finally(() => {
                      setPending(false);
                      onPendingChange(false);
                    });
                }}
              >
                {profile ? "保存" : "新增"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderFields({
  protocol,
  endpoint,
  modelId,
  secret,
  editing,
  pending,
  readOnly,
  onProtocolChange,
  onEndpointChange,
  onModelIdChange,
  onSecretChange,
}: {
  protocol: ProviderProtocol;
  endpoint: string;
  modelId: string;
  secret: string;
  editing: boolean;
  pending: boolean;
  readOnly: boolean;
  onProtocolChange: (protocol: ProviderProtocol) => void;
  onEndpointChange: (value: string) => void;
  onModelIdChange: (value: string) => void;
  onSecretChange: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ai-provider-protocol">接口类型</Label>
        <Select
          value={protocol}
          open={readOnly ? false : undefined}
          disabled={pending}
          onValueChange={(value) => {
            if (!readOnly) onProtocolChange(value as ProviderProtocol);
          }}
        >
          <SelectTrigger
            id="ai-provider-protocol"
            className="w-full"
            aria-label="接口类型"
            aria-readonly={readOnly || undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deepseek">DeepSeek</SelectItem>
            <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <LabeledInput
        id="ai-provider-model"
        label="模型 ID"
        value={modelId}
        maxLength={256}
        disabled={pending}
        readOnly={readOnly}
        onChange={onModelIdChange}
      />
      {protocol === "deepseek" && !modelId.startsWith("deepseek-") ? (
        <p className="text-sm text-destructive">模型 ID 需以 deepseek- 开头</p>
      ) : null}
      <LabeledInput
        id="ai-provider-endpoint"
        label="API 地址"
        value={endpoint}
        maxLength={2048}
        disabled={pending}
        readOnly={readOnly || protocol === "deepseek"}
        onChange={onEndpointChange}
      />
      <LabeledInput
        id="ai-provider-secret"
        label="API 密钥"
        value={secret}
        maxLength={4096}
        disabled={pending}
        readOnly={readOnly}
        type="password"
        autoComplete="off"
        placeholder={editing ? "留空表示不修改" : "请输入 API 密钥"}
        onChange={onSecretChange}
      />
    </div>
  );
}

function LabeledInput({
  id,
  label,
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "onChange"> & {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...props}
      />
    </div>
  );
}

function interfaceSummary(profile: CustomAiProviderProfile): string {
  const type =
    profile.protocol === "deepseek" ? "DeepSeek" : "OpenAI-compatible";
  return `${type} · ${profile.endpoint}`;
}

function focusAfterProfileDeletion(
  previousProfiles: AiProviderProfile[],
  deletedProfileId: string,
  nextProfiles: AiProviderProfile[],
): void {
  const deletedIndex = previousProfiles.findIndex(
    (profile) => profile.profileId === deletedProfileId,
  );
  const target =
    nextProfiles[deletedIndex] ?? nextProfiles[Math.max(0, deletedIndex - 1)];
  requestAnimationFrame(() => {
    const focusTarget = target
      ? [
          ...document.querySelectorAll<HTMLElement>("[data-profile-radio]"),
        ].find(
          (candidate) => candidate.dataset.profileRadio === target.profileId,
        )
      : document.querySelector<HTMLButtonElement>("[data-add-model='true']");
    focusTarget?.focus();
  });
}

function mutationErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("AI_PROFILE_IN_USE")) {
    return "该模型正在被任务使用，无法修改配置。";
  }
  return fallback;
}

function isStaleRevision(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  return message.includes("stale") || message.includes("revision is stale");
}
