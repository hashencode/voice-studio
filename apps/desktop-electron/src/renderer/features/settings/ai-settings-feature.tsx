import * as React from "react";
import { KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  AiSettingsSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";

type ProviderId = AiSettingsSnapshot["config"]["providerId"];

const providerDefaults: Record<
  ProviderId,
  Pick<AiSettingsSnapshot["config"], "modelId" | "endpoint">
> = {
  deepseek: {
    modelId: "deepseek-chat",
    endpoint: "https://api.deepseek.com",
  },
  "openai-compatible": {
    modelId: "",
    endpoint: "https://example.invalid",
  },
};

export function AiSettingsFeature({
  api = window.voice2text,
}: {
  api?: Voice2TextDesktopApi;
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
  return (
    <section aria-labelledby="ai-settings-title" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ai-settings-title" className="text-xl font-semibold">
            可选音频智能
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            本地设置检查不会发送音频数据，也不会创建远程处理同意。
          </p>
        </div>
        <ProviderDialog settings={settings} api={api} onSaved={setSettings} />
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="font-semibold">
                {providerName} · {settings.config.modelId}
              </h3>
              <p className="mt-1 break-all text-sm text-muted-foreground">
                {settings.config.endpoint}
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm">
            云端直连；每次生成都需要针对当前音频单独同意，不自动切换提供商或重试。
          </p>
        </section>

        <section className="rounded-xl border bg-card p-5">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-5" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold">macOS 钥匙串</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {secretStateCopy(settings.secretState)}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <SecretDialog settings={settings} api={api} onSaved={setSettings} />
            {settings.secretState === "available" ? (
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError(null);
                  void api
                    .deleteAiProviderSecret({
                      providerId: settings.config.providerId,
                    })
                    .then(setSettings)
                    .catch((cause: unknown) =>
                      setError(errorMessage(cause, "无法删除钥匙串密钥")),
                    )
                    .finally(() => setPending(false));
                }}
              >
                删除密钥
              </Button>
            ) : null}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            密钥只写入 macOS 钥匙串；保存后不会再次显示，也不会写入
            SQLite、配置或诊断。
          </p>
        </section>
      </div>

      <FileVaultStatus settings={settings} />
    </section>
  );
}

function ProviderDialog({
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
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reset = () => {
    setProviderId(settings.config.providerId);
    setModelId(settings.config.modelId);
    setEndpoint(settings.config.endpoint);
    setError(null);
  };
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogPrimitive.Trigger asChild>
        <Button type="button" variant="outline">
          配置提供商
        </Button>
      </DialogPrimitive.Trigger>
      <DialogSurface title="配置音频智能提供商">
        <DialogPrimitive.Description className="text-sm text-muted-foreground">
          选择只作用于后续任务；运行中的任务保留原提供商和模型快照。
        </DialogPrimitive.Description>
        <label className="mt-4 block text-sm font-medium">
          音频智能提供商
          <select
            aria-label="音频智能提供商"
            className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={providerId}
            onChange={(event) => {
              const next = event.target.value as ProviderId;
              setProviderId(next);
              setModelId(providerDefaults[next].modelId);
              setEndpoint(providerDefaults[next].endpoint);
            }}
          >
            <option value="deepseek">DeepSeek</option>
            <option value="openai-compatible">OpenAI-compatible</option>
          </select>
        </label>
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
            disabled={providerId === "deepseek"}
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <DialogPrimitive.Close asChild>
            <Button type="button" variant="outline" disabled={pending}>
              取消
            </Button>
          </DialogPrimitive.Close>
          <Button
            type="button"
            disabled={pending || !modelId.trim() || !endpoint.trim()}
            onClick={() => {
              setPending(true);
              setError(null);
              void api
                .saveAiSettings({
                  providerId,
                  modelId: modelId.trim(),
                  endpoint: endpoint.trim(),
                })
                .then((next) => {
                  onSaved(next);
                  setOpen(false);
                })
                .catch((cause: unknown) =>
                  setError(errorMessage(cause, "提供商配置无效")),
                )
                .finally(() => setPending(false));
            }}
          >
            保存配置
          </Button>
        </div>
      </DialogSurface>
    </DialogPrimitive.Root>
  );
}

function SecretDialog({
  settings,
  api,
  onSaved,
}: {
  settings: AiSettingsSnapshot;
  api: Voice2TextDesktopApi;
  onSaved: (settings: AiSettingsSnapshot) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [secret, setSecret] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const providerName = settings.config.displayName;
  const title = `${settings.secretState === "available" ? "替换" : "输入"} ${providerName} 密钥`;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setSecret("");
        setError(null);
      }}
    >
      <DialogPrimitive.Trigger asChild>
        <Button type="button">{title}</Button>
      </DialogPrimitive.Trigger>
      <DialogSurface title={title}>
        <DialogPrimitive.Description className="text-sm text-muted-foreground">
          密钥写入 macOS 钥匙串；保存后不会再次显示。
        </DialogPrimitive.Description>
        <label className="mt-4 block text-sm font-medium">
          API 密钥
          <Input
            autoComplete="off"
            className="mt-2"
            type="password"
            aria-label="API 密钥"
            maxLength={4096}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <DialogPrimitive.Close asChild>
            <Button type="button" variant="outline" disabled={pending}>
              取消
            </Button>
          </DialogPrimitive.Close>
          <Button
            type="button"
            disabled={pending || !secret.trim()}
            onClick={() => {
              const value = secret;
              setPending(true);
              setError(null);
              void api
                .replaceAiProviderSecret({
                  providerId: settings.config.providerId,
                  secret: value,
                })
                .then((next) => {
                  setSecret("");
                  onSaved(next);
                  setOpen(false);
                })
                .catch((cause: unknown) => {
                  setSecret("");
                  setError(errorMessage(cause, "无法写入 macOS 钥匙串"));
                })
                .finally(() => setPending(false));
            }}
          >
            保存到钥匙串
          </Button>
        </div>
      </DialogSurface>
    </DialogPrimitive.Root>
  );
}

function DialogSurface({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border bg-background p-6 shadow-lg outline-none">
        <DialogPrimitive.Title className="text-lg font-semibold">
          {title}
        </DialogPrimitive.Title>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function FileVaultStatus({ settings }: { settings: AiSettingsSnapshot }) {
  const { title, description } = {
    enabled: {
      title: "FileVault 磁盘加密已启用",
      description:
        "FileVault 是设备磁盘保护。应用未宣称音频数据库或媒体文件具有应用层整库加密；API 密钥仍由 macOS 钥匙串保护。",
    },
    disabled: {
      title: "FileVault 磁盘加密未启用",
      description:
        "音频数据库和媒体文件没有应用层整库加密。建议在系统设置中启用 FileVault；API 密钥仍由 macOS 钥匙串保护。",
    },
    unknown: {
      title: "无法确认 FileVault 状态",
      description:
        "应用未宣称音频数据库或媒体文件具有应用层整库加密。请在系统设置中核对 FileVault；API 密钥仍由 macOS 钥匙串保护。",
    },
  }[settings.deviceSecurity.fileVaultState];
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-start gap-3">
        <LockKeyhole className="mt-0.5 size-5" aria-hidden="true" />
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </section>
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
