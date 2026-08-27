import * as React from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AiSettingsSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";
import {
  SettingsItemGroup,
  SettingsListSkeleton,
  SettingsPageSection,
} from "@/features/settings/settings-page-section";

type ProviderId = AiSettingsSnapshot["config"]["providerId"];

const providerDefaults: Record<
  ProviderId,
  Pick<AiSettingsSnapshot["config"], "modelId" | "endpoint"> & {
    displayName: string;
  }
> = {
  deepseek: {
    displayName: "DeepSeek",
    modelId: "deepseek-chat",
    endpoint: "https://api.deepseek.com",
  },
  "openai-compatible": {
    displayName: "OpenAI-compatible",
    modelId: "",
    endpoint: "https://example.invalid",
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

  const load = React.useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      setSettings(await api.getAiSettings());
    } catch (cause) {
      setError(errorMessage(cause, "无法读取本机 AI 设置"));
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
        if (active) setError(errorMessage(cause, "无法读取本机 AI 设置"));
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  if (!settings && pending) {
    if (settingsPage) {
      return renderSettingsPageSection(<SettingsListSkeleton />);
    }
    return (
      <div
        role="status"
        className="flex min-h-52 items-center justify-center gap-2"
      >
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        正在读取本机 AI 设置
      </div>
    );
  }

  if (!settings) {
    if (settingsPage) {
      return renderSettingsPageSection(
        <AiSettingsUnavailable
          title="无法读取云端模型设置"
          error={error}
          onRetry={() => void load()}
        />,
      );
    }
    return (
      <section role="alert" className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">无法读取音频智能设置</h2>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4" variant="outline" onClick={() => void load()}>
          重新读取
        </Button>
      </section>
    );
  }

  const providerName = settings.config.displayName;
  const providerSettings = (
    <ProviderSettings
      settings={settings}
      providerName={providerName}
      api={api}
      error={error}
      onSaved={setSettings}
    />
  );
  if (settingsPage) {
    return renderSettingsPageSection(providerSettings);
  }
  return <section aria-label="音频智能设置">{providerSettings}</section>;
}

function renderSettingsPageSection(cloudModels: React.ReactNode) {
  return (
    <section aria-label="音频智能设置">
      <SettingsPageSection section="cloud-models" title="云端模型">
        {cloudModels}
      </SettingsPageSection>
    </section>
  );
}

function ProviderSettings({
  settings,
  providerName,
  api,
  error,
  onSaved,
}: {
  settings: AiSettingsSnapshot;
  providerName: string;
  api: Voice2TextDesktopApi;
  error: string | null;
  onSaved: (settings: AiSettingsSnapshot) => void;
}) {
  return (
    <>
      {error ? (
        <div
          role="alert"
          className="mb-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          {error}
        </div>
      ) : null}
      <SettingsItemGroup>
        <Item role="listitem" className="rounded-none">
          <ItemContent>
            <ItemTitle>AI 供应商</ItemTitle>
            <ItemDescription>
              {providerName} · {settings.config.modelId}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <ProviderSettingsDialog
              settings={settings}
              api={api}
              onSaved={onSaved}
            />
          </ItemActions>
        </Item>
      </SettingsItemGroup>
    </>
  );
}

function AiSettingsUnavailable({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <SettingsItemGroup>
      <Item role="listitem" className="rounded-none">
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          <ItemDescription>{error ?? "设置暂不可用"}</ItemDescription>
        </ItemContent>
        {onRetry ? (
          <ItemActions>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              重新读取
            </Button>
          </ItemActions>
        ) : null}
      </Item>
    </SettingsItemGroup>
  );
}

function ProviderSettingsDialog({
  settings,
  api,
  onSaved,
}: {
  settings: AiSettingsSnapshot;
  api: Voice2TextDesktopApi;
  onSaved: (settings: AiSettingsSnapshot) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [providerId, setProviderId] = React.useState<ProviderId>(
    settings.config.providerId,
  );
  const [modelId, setModelId] = React.useState(settings.config.modelId);
  const [endpoint, setEndpoint] = React.useState(settings.config.endpoint);
  const [secret, setSecret] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setProviderId(settings.config.providerId);
    setModelId(settings.config.modelId);
    setEndpoint(settings.config.endpoint);
    setSecret("");
    setError(null);
  };
  const selectedProviderName = providerDefaults[providerId].displayName;
  const editingConfiguredProvider = providerId === settings.config.providerId;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          reset();
        } else {
          setSecret("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          管理 AI 供应商
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI 供应商设置</DialogTitle>
          <DialogDescription>
            配置只作用于后续任务；运行中的任务保留原设置。
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4 space-y-2">
          <Label htmlFor="ai-provider">音频智能提供商</Label>
          <Select
            value={providerId}
            onValueChange={(value) => {
              const next = value as ProviderId;
              setProviderId(next);
              setModelId(providerDefaults[next].modelId);
              setEndpoint(providerDefaults[next].endpoint);
              setSecret("");
              setError(null);
            }}
          >
            <SelectTrigger id="ai-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="deepseek">
                {providerDefaults.deepseek.displayName}
              </SelectItem>
              <SelectItem value="openai-compatible">
                {providerDefaults["openai-compatible"].displayName}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="mt-4 block text-sm font-medium">
          模型 ID
          <Input
            className="mt-2"
            aria-label="模型 ID"
            maxLength={256}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          服务地址
          <Input
            className="mt-2"
            aria-label="服务地址"
            maxLength={2048}
            readOnly={providerId === "deepseek"}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          API 密钥
          <Input
            autoComplete="off"
            className="mt-2"
            type="password"
            aria-label="API 密钥"
            maxLength={4096}
            placeholder={
              editingConfiguredProvider && settings.secretState === "available"
                ? "已保存；留空表示不修改"
                : `输入 ${selectedProviderName} API 密钥`
            }
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          {editingConfiguredProvider
            ? secretStateCopy(settings.secretState)
            : "切换后将读取该供应商在 macOS 钥匙串中的密钥。"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          密钥只写入 macOS 钥匙串，保存后不会再次显示。
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="mt-6 flex-wrap">
          {editingConfiguredProvider && settings.secretState === "available" ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError(null);
                void api
                  .deleteAiProviderSecret({ providerId })
                  .then((next) => {
                    setSecret("");
                    onSaved(next);
                  })
                  .catch((cause: unknown) =>
                    setError(errorMessage(cause, "无法删除钥匙串密钥")),
                  )
                  .finally(() => setPending(false));
              }}
            >
              删除密钥
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              取消
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={pending || !modelId.trim() || !endpoint.trim()}
            onClick={() => {
              const secretValue = secret.trim();
              const nextConfig = {
                providerId,
                modelId: modelId.trim(),
                endpoint: endpoint.trim(),
              };
              const configChanged =
                nextConfig.providerId !== settings.config.providerId ||
                nextConfig.modelId !== settings.config.modelId ||
                nextConfig.endpoint !== settings.config.endpoint;
              setPending(true);
              setError(null);
              void (async () => {
                let next = settings;
                try {
                  if (configChanged) {
                    next = await api.saveAiSettings(nextConfig);
                  }
                  if (secretValue) {
                    next = await api.replaceAiProviderSecret({
                      providerId,
                      secret: secretValue,
                    });
                  }
                } catch (cause) {
                  if (next !== settings) onSaved(next);
                  throw cause;
                }
                if (next !== settings) onSaved(next);
                setSecret("");
                setError(null);
                setOpen(false);
              })()
                .catch((cause: unknown) => {
                  setSecret("");
                  setError(errorMessage(cause, "无法保存 AI 供应商设置"));
                })
                .finally(() => setPending(false));
            }}
          >
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function secretStateCopy(state: AiSettingsSnapshot["secretState"]): string {
  return {
    available: "密钥已配置并可由 macOS 钥匙串读取",
    missing: "尚未在 macOS 钥匙串中配置密钥",
    denied: "无法读取 macOS 钥匙串中的密钥",
    corrupt: "macOS 钥匙串中的密钥无法使用",
  }[state];
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
