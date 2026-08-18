import * as React from "react";
import {
  CheckCircle2,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  RadioTower,
  RotateCcw,
  Smartphone,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  CompanionSnapshot,
  Voice2TextDesktopApi,
} from "@shared/contracts";

type Transfer = CompanionSnapshot["transfers"][number];
type Peer = CompanionSnapshot["peers"][number];

let requestSequence = 0;

type CompanionView =
  | { kind: "choose" }
  | { kind: "pairing" }
  | { kind: "history" }
  | { kind: "device"; deviceId: string };

export interface CompanionRouteController {
  snapshot: CompanionSnapshot | null;
  loading: boolean;
  error: string | null;
  pendingAction: string | null;
  peers: Peer[];
  selectedPeer: Peer | null;
  selectedTransfers: Transfer[];
  view: CompanionView;
  selectDevice: (deviceId: string) => void;
  showPairing: () => void;
  showHistory: () => void;
  setOptIn: () => void;
  createInvite: () => void;
  revoke: (peer: Peer) => void;
  cancel: (transfer: Transfer) => void;
  retry: (transfer: Transfer) => void;
}

// The route controller is colocated with its two surfaces so their state model
// cannot drift while the U4 composition remains a single feature boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function useCompanionRouteController({
  api = window.voice2text,
  enabled = true,
}: {
  api?: Voice2TextDesktopApi;
  enabled?: boolean;
} = {}): CompanionRouteController {
  const [snapshot, setSnapshot] = React.useState<CompanionSnapshot | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [view, setView] = React.useState<CompanionView>({ kind: "choose" });
  const acceptedRevisionRef = React.useRef(-1);
  const pendingActionRef = React.useRef(false);

  const accept = React.useCallback((next: CompanionSnapshot) => {
    if (next.revision <= acceptedRevisionRef.current) return;
    acceptedRevisionRef.current = next.revision;
    setError(null);
    setSnapshot(next);
    const nextPeers = next.peers.filter(
      (peer) => peer.trustState !== "revoked",
    );
    setView((current) => reconcileView(current, nextPeers));
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    const unsubscribe = api.onCompanionSnapshot((next) => {
      if (active) accept(next);
    });
    void api
      .getCompanionSnapshot()
      .then((next) => {
        if (active) accept(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause, "无法读取手机接收状态"));
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept, api, enabled]);

  const peers = React.useMemo(
    () => snapshot?.peers.filter((peer) => peer.trustState !== "revoked") ?? [],
    [snapshot],
  );

  const run = React.useCallback(
    async (key: string, operation: () => Promise<CompanionSnapshot>) => {
      if (pendingActionRef.current) return;
      pendingActionRef.current = true;
      setPendingAction(key);
      setError(null);
      try {
        accept(await operation());
      } catch (cause) {
        setError(errorMessage(cause, "手机接收操作未完成"));
      } finally {
        pendingActionRef.current = false;
        setPendingAction(null);
      }
    },
    [accept],
  );

  const selectedPeer =
    view.kind === "device"
      ? (peers.find((peer) => peer.deviceId === view.deviceId) ?? null)
      : null;
  const selectedTransfers = React.useMemo(
    () =>
      selectedPeer
        ? (snapshot?.transfers.filter(
            (transfer) => transfer.peerDeviceId === selectedPeer.deviceId,
          ) ?? [])
        : [],
    [selectedPeer, snapshot],
  );

  return {
    snapshot,
    loading: enabled && snapshot === null && error === null,
    error,
    pendingAction,
    peers,
    selectedPeer,
    selectedTransfers,
    view,
    selectDevice: (deviceId) => setView({ kind: "device", deviceId }),
    showPairing: () => setView({ kind: "pairing" }),
    showHistory: () => setView({ kind: "history" }),
    setOptIn: () => {
      if (!snapshot) return;
      void run("opt-in", () =>
        api.setCompanionOptIn({
          enabled: !snapshot.optIn,
          idempotencyKey: requestIdentity("companion-opt-in"),
        }),
      );
    },
    createInvite: () =>
      void run("invite", () =>
        api.createCompanionPairingInvite({
          idempotencyKey: requestIdentity("companion-invite"),
        }),
      ),
    revoke: (peer) =>
      void run(`revoke:${peer.deviceId}`, () =>
        api.revokeCompanionPeer({
          deviceId: peer.deviceId,
          idempotencyKey: requestIdentity("companion-revoke"),
        }),
      ),
    cancel: (transfer) =>
      void run(`cancel:${transfer.transferId}`, () =>
        api.cancelCompanionTransfer({
          transferId: transfer.transferId,
          expectedRevision: transfer.revision,
          idempotencyKey: requestIdentity("companion-cancel"),
        }),
      ),
    retry: (transfer) =>
      void run(`retry:${transfer.transferId}`, () =>
        api.retryCompanionTransfer({
          transferId: transfer.transferId,
          expectedRevision: transfer.revision,
          idempotencyKey: requestIdentity("companion-retry"),
        }),
      ),
  };
}

export function CompanionContextPane({
  controller,
}: {
  controller: CompanionRouteController;
}) {
  if (controller.loading && !controller.snapshot) {
    return <PaneStatus label="正在读取已信任设备" />;
  }
  if (!controller.snapshot) {
    return (
      <PaneStatus label={controller.error ?? "无法读取已信任设备"} alert />
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">已信任设备</p>
        <p className="mt-1 text-xs text-muted-foreground">
          选择只会切换查看内容，不会主动连接设备。
        </p>
      </div>
      {controller.peers.length === 0 ? (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">
          没有已信任设备
        </p>
      ) : (
        <ul className="space-y-2" aria-label="已信任设备列表">
          {controller.peers.map((peer) => (
            <li key={peer.deviceId}>
              <button
                type="button"
                className="w-full rounded-lg border p-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                aria-pressed={
                  controller.selectedPeer?.deviceId === peer.deviceId
                }
                onClick={() => controller.selectDevice(peer.deviceId)}
              >
                <span className="block font-medium">{peer.displayName}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {peer.trustState === "credential-missing"
                    ? "凭据缺失 · 需要重新配对"
                    : "已信任 · 在线状态未知"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={controller.showPairing}
      >
        添加或配对设备
      </Button>
    </div>
  );
}

export function CompanionMainWorkspace({
  controller,
  onOpenPane,
}: {
  controller: CompanionRouteController;
  onOpenPane: () => void;
}) {
  const { snapshot } = controller;
  return (
    <section aria-labelledby="companion-title" className="space-y-5">
      <div>
        <h1
          id="companion-title"
          className="text-2xl font-semibold tracking-tight"
        >
          互联
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          管理已信任设备、配对与安全传输记录。选择设备不会建立连接。
        </p>
      </div>

      {controller.error ? (
        <div
          role="alert"
          className="rounded-lg border bg-card px-4 py-3 text-sm"
        >
          {controller.error}
        </div>
      ) : null}

      {controller.loading && !snapshot ? (
        <div role="status" aria-label="正在读取手机接收状态">
          正在读取手机接收状态
        </div>
      ) : !snapshot ? (
        <div role="alert">无法读取手机接收状态</div>
      ) : controller.view.kind === "history" ? (
        <HistoryWorkspace controller={controller} />
      ) : controller.view.kind === "pairing" ||
        controller.peers.length === 0 ? (
        <PairingWorkspace controller={controller} />
      ) : controller.selectedPeer ? (
        <DeviceWorkspace
          controller={controller}
          peer={controller.selectedPeer}
        />
      ) : (
        <section className="grid min-h-72 place-items-center rounded-xl border bg-card p-6 text-center">
          <div>
            <Smartphone className="mx-auto size-8" aria-hidden="true" />
            <h2 className="mt-3 text-lg font-semibold">请选择要查看的设备</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              多个已信任设备是正常状态；选择仅切换管理视图。
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={onOpenPane}
            >
              打开设备列表
            </Button>
          </div>
        </section>
      )}
    </section>
  );
}

function PaneStatus({
  label,
  alert = false,
}: {
  label: string;
  alert?: boolean;
}) {
  return (
    <p
      role={alert ? "alert" : "status"}
      className="text-sm text-muted-foreground"
    >
      {label}
    </p>
  );
}

function PairingWorkspace({
  controller,
}: {
  controller: CompanionRouteController;
}) {
  const snapshot = controller.snapshot;
  if (!snapshot) return null;
  const pending = controller.pendingAction !== null;
  return (
    <section className="grid min-h-72 place-items-center rounded-xl border bg-card p-5">
      <div className="w-full max-w-3xl space-y-4">
        <div className="text-center">
          <KeyRound className="mx-auto size-8" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-semibold">配对手机</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            启用本机接收后生成邀请，并在两端核对相同的六位短码。
          </p>
          <Button
            type="button"
            variant={snapshot.optIn ? "outline" : "default"}
            className="mt-4"
            disabled={pending}
            aria-busy={controller.pendingAction === "opt-in"}
            onClick={controller.setOptIn}
          >
            {snapshot.optIn ? "停止手机接收" : "启用手机接收"}
          </Button>
        </div>

        {!snapshot.optIn ? (
          <section className="rounded-xl border p-4">
            <h3 className="font-semibold">手机接收当前关闭</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              只有启用后才会开始局域网广播、请求系统权限或接受手机连接；已有
              durable receipt 与历史不会被删除。
            </p>
          </section>
        ) : (
          <>
            <ReceiverStatus snapshot={snapshot} />
            <PairingPanel
              snapshot={snapshot}
              pending={pending}
              onCreateInvite={controller.createInvite}
            />
          </>
        )}

        {snapshot.transfers.length > 0 ? (
          <div className="text-center">
            <Button
              type="button"
              variant="ghost"
              onClick={controller.showHistory}
            >
              查看传输历史
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DeviceWorkspace({
  controller,
  peer,
}: {
  controller: CompanionRouteController;
  peer: Peer;
}) {
  const credentialMissing = peer.trustState === "credential-missing";
  return (
    <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{peer.displayName}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {credentialMissing
                ? "配对凭据缺失 · 必须重新配对"
                : "已信任 · 在线状态未知"}
            </p>
            <p className="mt-2 break-all text-xs text-muted-foreground">
              身份指纹 {peer.identityFingerprint}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              此处不显示或推断实时连接；选择设备不会主动连接。
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={controller.pendingAction !== null}
            onClick={() => controller.revoke(peer)}
          >
            撤销 {peer.displayName}
          </Button>
        </div>
        {credentialMissing ? (
          <Button
            type="button"
            className="mt-4"
            onClick={controller.showPairing}
          >
            重新配对
          </Button>
        ) : null}
      </section>
      {controller.selectedTransfers.length > 0 ? (
        <TransfersPanel
          transfers={controller.selectedTransfers}
          pendingAction={controller.pendingAction}
          onCancel={controller.cancel}
          onRetry={controller.retry}
          title="此设备的传输"
        />
      ) : (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">此设备的传输</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            暂无传输记录。发送端必须保留原件，直到本机返回 durable receipt。
          </p>
        </section>
      )}
    </div>
  );
}

function HistoryWorkspace({
  controller,
}: {
  controller: CompanionRouteController;
}) {
  const transfers = controller.snapshot?.transfers ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">传输历史</h2>
        <Button
          type="button"
          variant="outline"
          onClick={
            controller.peers.length === 0
              ? controller.showPairing
              : () => controller.selectDevice(controller.peers[0]!.deviceId)
          }
        >
          返回{controller.peers.length === 0 ? "配对" : "设备"}
        </Button>
      </div>
      <TransfersPanel
        transfers={transfers}
        pendingAction={controller.pendingAction}
        onCancel={controller.cancel}
        onRetry={controller.retry}
        title="全部传输记录"
      />
    </div>
  );
}

function reconcileView(current: CompanionView, peers: Peer[]): CompanionView {
  if (current.kind === "pairing" || current.kind === "history") return current;
  if (
    current.kind === "device" &&
    peers.some((peer) => peer.deviceId === current.deviceId)
  ) {
    return current;
  }
  if (peers.length === 1)
    return { kind: "device", deviceId: peers[0]!.deviceId };
  return peers.length === 0 ? { kind: "pairing" } : { kind: "choose" };
}

function ReceiverStatus({ snapshot }: { snapshot: CompanionSnapshot }) {
  const { discovery, identity } = snapshot;
  if (discovery.state === "permission-denied") {
    return (
      <section
        role="alert"
        aria-label="局域网权限被拒绝"
        className="rounded-xl border bg-card p-5"
      >
        <div className="flex items-start gap-3">
          <CircleAlert className="mt-0.5 size-5" aria-hidden="true" />
          <div>
            <h2 className="font-semibold">局域网权限被拒绝</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              macOS 未允许局域网广播。发送端必须保留原件；
              {discovery.manualFallbackAvailable
                ? "仍可使用手动配对。"
                : "当前没有可用的手动配对路径。"}
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (discovery.state === "ready" && identity) {
    return (
      <section
        role="status"
        aria-label="手机接收器已就绪"
        className="rounded-xl border bg-card p-5"
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="font-semibold">手机接收器已就绪</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {identity.deviceName} · 动态端口 {identity.port} · 已加密
            </p>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              本机公钥指纹 {identity.fingerprint}
            </p>
          </div>
        </div>
      </section>
    );
  }

  const status = discoveryStatus(discovery.state);
  const isError =
    discovery.state === "error" || discovery.state === "unavailable";
  return (
    <section
      role={isError ? "alert" : "status"}
      aria-label={status.title}
      className="rounded-xl border bg-card p-5"
    >
      <div className="flex items-start gap-3">
        {discovery.state === "starting" ||
        discovery.state === "permission-pending" ? (
          <LoaderCircle
            className="mt-0.5 size-5 animate-spin"
            aria-hidden="true"
          />
        ) : (
          <RadioTower className="mt-0.5 size-5" aria-hidden="true" />
        )}
        <div>
          <h2 className="font-semibold">{status.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {status.description}
          </p>
          {discovery.errorCode ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {discovery.errorCode}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PairingPanel({
  snapshot,
  pending,
  onCreateInvite,
}: {
  snapshot: CompanionSnapshot;
  pending: boolean;
  onCreateInvite: () => void;
}) {
  const pairing = pairingStatus(snapshot.pairing.state);
  const publicPairingArtifact =
    snapshot.pairingInvite && snapshot.identity
      ? JSON.stringify({
          schema: snapshot.pairingInvite.schema,
          pairingId: snapshot.pairingInvite.pairingId,
          targetDeviceId: snapshot.identity.deviceId,
          targetDeviceName: snapshot.identity.deviceName,
          targetFingerprint: snapshot.identity.fingerprint,
          targetIdentityPublicKey:
            snapshot.pairingInvite.responderIdentityPublicKey,
          targetEphemeralPublicKey:
            snapshot.pairingInvite.responderEphemeralPublicKey,
          host: snapshot.pairingInvite.manualEndpoint.host,
          port: snapshot.pairingInvite.manualEndpoint.port,
          expiresAtMs: snapshot.pairingInvite.expiresAtMs,
        })
      : null;
  return (
    <section
      aria-labelledby="pairing-title"
      className="rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-5" aria-hidden="true" />
          <div>
            <h2 id="pairing-title" className="font-semibold">
              配对与身份核对
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              邀请有效期为两分钟。请在两端核对相同的六位短码；错误短码不会建立信任。
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCreateInvite}
        >
          生成手动配对邀请
        </Button>
      </div>

      {snapshot.pairing.state !== "idle" ? (
        <div
          role={pairing.error ? "alert" : "status"}
          className="mt-4 rounded-lg border px-3 py-2 text-sm"
        >
          <span className="font-medium">{pairing.title}</span>
          <span className="text-muted-foreground">
            {" "}
            · {pairing.description}
          </span>
          {snapshot.pairing.errorCode ? (
            <span className="block text-xs text-muted-foreground">
              {snapshot.pairing.errorCode}
            </span>
          ) : null}
        </div>
      ) : null}

      {snapshot.pairingInvite ? (
        <div
          role="region"
          aria-label="手动配对邀请"
          className="mt-4 space-y-3 rounded-lg border p-4"
        >
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              双方确认六位短码
            </p>
            <p className="mt-1 font-mono text-3xl font-semibold tracking-[0.25em]">
              {snapshot.pairingInvite.shortCode}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              公开设备句柄
            </p>
            <code className="mt-1 block break-all rounded-md bg-muted p-3 text-xs">
              {snapshot.pairingInvite.displayHandle}
            </code>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              手动连接地址
            </p>
            <code className="mt-1 block break-all rounded-md bg-muted p-3 text-xs">
              {snapshot.pairingInvite.manualEndpoint.host}:
              {snapshot.pairingInvite.manualEndpoint.port}
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              此处只显示公开连接信息。长期配对凭据仅保存在两端的系统安全存储中。
            </p>
          </div>
          {publicPairingArtifact ? (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                手机端公开配对信息
              </p>
              <code className="mt-1 block break-all rounded-md bg-muted p-3 text-xs">
                {publicPairingArtifact}
              </code>
              <p className="mt-2 text-xs text-muted-foreground">
                在手机端导入此公开信息后，仍需核对上方六码；其中不包含长期凭据。
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function TransfersPanel({
  transfers,
  pendingAction,
  onCancel,
  onRetry,
  title = "接收历史与 receipt",
}: {
  transfers: CompanionSnapshot["transfers"];
  pendingAction: string | null;
  onCancel: (transfer: Transfer) => void;
  onRetry: (transfer: Transfer) => void;
  title?: string;
}) {
  return (
    <section aria-labelledby="transfers-title" className="space-y-3">
      <div>
        <h2 id="transfers-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          重启后从 durable checkpoint
          恢复；只重收缺失且尚未验证的分块，不重复创建音频。
        </p>
      </div>
      {transfers.length === 0 ? (
        <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          暂无手机传输。发送端会一直保留原件，直到本机返回 durable receipt。
        </div>
      ) : (
        <ul className="space-y-3">
          {transfers.map((transfer) => (
            <TransferItem
              key={transfer.transferId}
              transfer={transfer}
              pendingAction={pendingAction}
              onCancel={onCancel}
              onRetry={onRetry}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TransferItem({
  transfer,
  pendingAction,
  onCancel,
  onRetry,
}: {
  transfer: Transfer;
  pendingAction: string | null;
  onCancel: (transfer: Transfer) => void;
  onRetry: (transfer: Transfer) => void;
}) {
  const progress = transferProgress(transfer);
  const progressLabel = `${transfer.displayName} 接收进度：${progress}%，还缺 ${transfer.missingChunkCount} 个待验证分块`;
  const receiptAuthorizesDeletion =
    transfer.receipt !== null && transfer.senderDeleteAllowed;
  const canCancel = [
    "awaiting",
    "transferring",
    "verifying",
    "importing",
  ].includes(transfer.state);
  const canRetry =
    transfer.state === "failed" || transfer.state === "interrupted";
  const pending = pendingAction !== null;
  return (
    <li className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">{transfer.displayName}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {transferStateCopy(transfer.state)} ·{" "}
            {formatBytes(transfer.receivedBytes)} /{" "}
            {formatBytes(transfer.sizeBytes)}
          </p>
        </div>
        <span className="rounded-full border px-2.5 py-1 text-xs font-medium">
          {receiptAuthorizesDeletion
            ? "已签收，可由发送端删除原件"
            : "发送端必须保留原件"}
        </span>
      </div>

      {transfer.state !== "committed" ? (
        <div className="mt-3">
          <progress
            className="h-2 w-full"
            max={100}
            value={progress}
            aria-label={progressLabel}
          />
          <p className="mt-1 text-xs text-muted-foreground">{progressLabel}</p>
        </div>
      ) : null}

      {transfer.errorCode ? (
        <p role="alert" className="mt-2 text-sm">
          {transfer.errorCode}
        </p>
      ) : null}

      {transfer.receipt ? (
        <div className="mt-3 rounded-lg border p-3 text-xs text-muted-foreground">
          <p>receipt {transfer.receipt.receiptId}</p>
          <p>recording {transfer.receipt.desktopRecordingId}</p>
          <p>本机提交时间 {formatTimestamp(transfer.receipt.committedAtMs)}</p>
        </div>
      ) : null}

      {canCancel || canRetry ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {canCancel ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              aria-busy={pendingAction === `cancel:${transfer.transferId}`}
              onClick={() => onCancel(transfer)}
            >
              取消接收 {transfer.displayName}
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              type="button"
              disabled={pending}
              aria-busy={pendingAction === `retry:${transfer.transferId}`}
              onClick={() => onRetry(transfer)}
            >
              <RotateCcw aria-hidden="true" />
              重试接收 {transfer.displayName}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function discoveryStatus(state: CompanionSnapshot["discovery"]["state"]) {
  switch (state) {
    case "idle":
      return { title: "接收器等待启动", description: "尚未开始局域网广播。" };
    case "starting":
      return {
        title: "正在启动手机接收器",
        description: "正在创建私有接收会话并广播服务。",
      };
    case "permission-pending":
      return {
        title: "等待局域网权限",
        description: "请在 macOS 系统提示中允许局域网访问。",
      };
    case "unavailable":
      return {
        title: "局域网接收器不可用",
        description: "本机文件导入仍可继续；发送端保留原件。",
      };
    case "error":
      return {
        title: "局域网接收器启动失败",
        description: "可停止后再次启用；发送端保留原件。",
      };
    case "disabled":
      return { title: "手机接收当前关闭", description: "启用后才开始广播。" };
    case "permission-denied":
      return { title: "局域网权限被拒绝", description: "发送端保留原件。" };
    case "ready":
      return { title: "手机接收器已就绪", description: "等待手机连接。" };
  }
}

function pairingStatus(state: CompanionSnapshot["pairing"]["state"]) {
  switch (state) {
    case "idle":
      return { title: "尚未创建邀请", description: "", error: false };
    case "inviting":
      return {
        title: "正在创建配对邀请",
        description: "请稍候。",
        error: false,
      };
    case "awaiting-peer":
      return {
        title: "等待手机确认",
        description: "请核对两端六位短码。",
        error: false,
      };
    case "paired":
      return {
        title: "配对完成",
        description: "已保存设备信任。",
        error: false,
      };
    case "code-mismatch":
      return {
        title: "短码不一致",
        description: "未建立信任；请核对后重新生成邀请。",
        error: true,
      };
    case "expired":
      return {
        title: "配对邀请已过期",
        description: "旧邀请不可复用，请生成新邀请。",
        error: true,
      };
    case "locked":
      return {
        title: "配对尝试已锁定",
        description: "错误次数过多，请生成新邀请。",
        error: true,
      };
    case "error":
      return {
        title: "配对未完成",
        description: "未建立信任，请重试。",
        error: true,
      };
  }
}

function transferProgress(transfer: Transfer): number {
  return Math.max(
    0,
    Math.min(
      100,
      Math.round((transfer.receivedBytes / transfer.sizeBytes) * 100),
    ),
  );
}

function transferStateCopy(state: Transfer["state"]): string {
  switch (state) {
    case "awaiting":
      return "等待发送端";
    case "transferring":
      return "正在接收并校验分块";
    case "verifying":
      return "正在校验完整文件";
    case "importing":
      return "正在安全导入";
    case "committed":
      return "已完成 durable import commit";
    case "canceled":
      return "已取消";
    case "failed":
      return "接收失败，可重试";
    case "interrupted":
      return "应用重启后已中断，可重试";
    case "expired":
      return "checkpoint 已按七天规则过期";
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

const timestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatTimestamp(value: number): string {
  return timestampFormatter.format(new Date(value));
}

function requestIdentity(prefix: string): string {
  requestSequence += 1;
  return `${prefix}:${Date.now()}:${requestSequence}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
