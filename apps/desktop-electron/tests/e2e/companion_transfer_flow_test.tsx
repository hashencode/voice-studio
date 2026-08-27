// @vitest-environment jsdom

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../src/renderer/App";
import type {
  ApplicationSnapshot,
  CompanionSnapshot,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";

const application: ApplicationSnapshot = {
  protocolVersion: 2,
  revision: 12,
  navigation: { section: "companion" },
  profile: { phase: "ready", legacyDatabaseArchived: false },
  connectivity: "online",
  capability: { processing: "available" },
  library: { phase: "empty" },
  reconciliation: [],
  capture: { phase: "idle" },
};

const disabledSnapshot: CompanionSnapshot = {
  protocolVersion: 2,
  revision: 1,
  optIn: false,
  discovery: {
    state: "disabled",
    manualFallbackAvailable: true,
    errorCode: null,
  },
  pairing: { state: "idle", errorCode: null },
  identity: null,
  pairingInvite: null,
  peers: [],
  transfers: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("companion Renderer flow", () => {
  it("requires explicit opt-in before starting receiver discovery", async () => {
    const enabled: CompanionSnapshot = {
      ...disabledSnapshot,
      revision: 2,
      optIn: true,
      discovery: {
        state: "ready",
        manualFallbackAvailable: true,
        errorCode: null,
      },
      identity: {
        deviceId: "desktop-01",
        deviceName: "Voice2Text Mac",
        fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        port: 42_424,
      },
    };
    const { api, getCompanionSnapshot, setCompanionOptIn } = installApi({
      initial: disabledSnapshot,
      enableResult: enabled,
    });
    const user = userEvent.setup();
    render(<App />);

    const enable = await screen.findByRole("button", {
      name: "启用手机接收",
    });
    expect(getCompanionSnapshot).toHaveBeenCalledTimes(1);
    expect(setCompanionOptIn).not.toHaveBeenCalled();
    expect(screen.getByText(/只有启用后才会开始局域网广播/)).toBeVisible();

    enable.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(setCompanionOptIn).toHaveBeenCalledWith({
        enabled: true,
        idempotencyKey: expect.stringMatching(/^companion-opt-in:/),
      }),
    );
    expect(api.getCompanionSnapshot).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("status", { name: "手机接收器已就绪" }),
    ).toHaveTextContent("Voice2Text Mac");
  });

  it("keeps pairing unavailable when receiver startup fails", async () => {
    const unavailable: CompanionSnapshot = {
      ...disabledSnapshot,
      revision: 3,
      optIn: true,
      discovery: {
        state: "error",
        manualFallbackAvailable: true,
        errorCode: "COMPANION_RECEIVER_UNAVAILABLE",
      },
    };
    const { createCompanionPairingInvite } = installApi({
      initial: unavailable,
    });
    const user = userEvent.setup();
    render(<App />);

    expect(
      await screen.findByRole("alert", { name: "局域网接收器启动失败" }),
    ).toHaveTextContent("发送端保留原件");
    const createInvite = screen.getByRole("button", {
      name: "生成手动配对邀请",
    });
    expect(createInvite).toBeDisabled();
    expect(
      screen.getByText("接收器可用后才能生成新的配对邀请。"),
    ).toBeVisible();
    await user.click(createInvite);
    expect(createCompanionPairingInvite).not.toHaveBeenCalled();
  });

  it("keeps permission denial recoverable with manual pairing and peer truth", async () => {
    const denied: CompanionSnapshot = {
      ...disabledSnapshot,
      revision: 4,
      optIn: true,
      discovery: {
        state: "permission-denied",
        manualFallbackAvailable: true,
        errorCode: "LOCAL_NETWORK_PERMISSION_DENIED",
      },
      identity: {
        deviceId: "desktop-01",
        deviceName: "Voice2Text Mac",
        fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        port: null,
      },
      pairing: { state: "code-mismatch", errorCode: "PAIRING_CODE_MISMATCH" },
      peers: [
        {
          deviceId: "android-offline",
          displayName: "Offline Phone",
          identityFingerprint: "BCDEFGHIJKLMNOPQRSTUVWXYZ234567A",
          trustState: "active",
          availability: "offline",
          pairedAtMs: 1,
          lastSeenAtMs: 2,
        },
        {
          deviceId: "android-revoked",
          displayName: "Revoked Phone",
          identityFingerprint: "CDEFGHIJKLMNOPQRSTUVWXYZ234567AB",
          trustState: "revoked",
          availability: "unknown",
          pairedAtMs: 1,
          lastSeenAtMs: null,
        },
      ],
    };
    const inviteResult: CompanionSnapshot = {
      ...denied,
      revision: 5,
      pairing: { state: "awaiting-peer", errorCode: null },
      pairingInvite: {
        schema: "companion-audio-transfer/v2",
        pairingId: "pair-01",
        shortCode: "123456",
        displayHandle: "desktop:VOICE2TEXT:ABCD2345",
        responderEphemeralPublicKey: `${"A".repeat(43)}=`,
        responderIdentityPublicKey: `${"B".repeat(43)}=`,
        manualEndpoint: { host: "192.168.10.24", port: 45_678 },
        expiresAtMs: 120_000,
      },
    };
    const { createCompanionPairingInvite } = installApi({
      initial: denied,
      inviteResult,
    });
    const user = userEvent.setup();
    render(<App />);

    const pane = await screen.findByRole("complementary", {
      name: "互联上下文面板",
    });
    expect(await within(pane).findByText("Offline Phone")).toBeVisible();
    expect(within(pane).queryByText("Revoked Phone")).not.toBeInTheDocument();
    await user.click(
      within(pane).getByRole("button", { name: /Offline Phone/ }),
    );
    await user.click(within(pane).getByRole("button", { name: "配对设备" }));
    expect(
      await screen.findByRole("alert", { name: "局域网权限被拒绝" }),
    ).toHaveTextContent("仍可使用手动配对");
    expect(screen.getByText("短码不一致")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "生成手动配对邀请" }));
    await waitFor(() =>
      expect(createCompanionPairingInvite).toHaveBeenCalledWith({
        idempotencyKey: expect.stringMatching(/^companion-invite:/),
      }),
    );
    const pairing = await screen.findByRole("region", {
      name: "手动配对邀请",
    });
    expect(within(pairing).getByText("123456")).toBeVisible();
    expect(
      within(pairing).getByText("desktop:VOICE2TEXT:ABCD2345"),
    ).toBeVisible();
    expect(within(pairing).getByText("192.168.10.24:45678")).toBeVisible();
    expect(pairing).toHaveTextContent('"targetDeviceId":"desktop-01"');
    expect(pairing).toHaveTextContent('"targetDeviceName":"Voice2Text Mac"');
    expect(pairing).toHaveTextContent('"targetFingerprint"');
    expect(pairing).toHaveTextContent('"targetIdentityPublicKey"');
    expect(pairing).toHaveTextContent('"targetEphemeralPublicKey"');
    expect(pairing).toHaveTextContent(
      "长期配对凭据仅保存在两端的系统安全存储中",
    );
    const renderedPairing = pairing.textContent ?? "";
    expect(renderedPairing).not.toMatch(/credential|encodedPayload|token/i);
    const rendererSnapshot = JSON.stringify(inviteResult);
    expect(rendererSnapshot).toContain("responderIdentityPublicKey");
    expect(rendererSnapshot).toContain("responderEphemeralPublicKey");
    expect(rendererSnapshot).not.toMatch(
      /"(?:credential|encodedPayload|secret|token)"\s*:/i,
    );
  });

  it("restores transfer progress and receipt truth without color-only status", async () => {
    const snapshot: CompanionSnapshot = {
      ...disabledSnapshot,
      revision: 8,
      optIn: true,
      discovery: {
        state: "ready",
        manualFallbackAvailable: true,
        errorCode: null,
      },
      identity: {
        deviceId: "desktop-01",
        deviceName: "Voice2Text Mac",
        fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        port: 42_424,
      },
      transfers: [
        {
          transferId: "transfer-active",
          peerDeviceId: "android-history",
          displayName: "访谈.wav",
          wholeFileSha256: "a".repeat(64),
          sizeBytes: 10_000,
          receivedBytes: 4_000,
          missingChunkCount: 3,
          state: "transferring",
          revision: 3,
          errorCode: null,
          receipt: null,
          senderDeleteAllowed: false,
          updatedAtMs: 10,
        },
        {
          transferId: "transfer-committed",
          peerDeviceId: "android-history",
          displayName: "周会.wav",
          wholeFileSha256: "b".repeat(64),
          sizeBytes: 8_000,
          receivedBytes: 8_000,
          missingChunkCount: 0,
          state: "committed",
          revision: 5,
          errorCode: null,
          receipt: {
            schema: "companion-audio-transfer/v2",
            receiptId: "receipt-committed",
            transferId: "transfer-committed",
            wholeFileSha256: "b".repeat(64),
            sizeBytes: 8_000,
            desktopDeviceId: "desktop-01",
            desktopDeviceName: "Voice2Text Mac",
            desktopRecordingId: 42,
            committedAtMs: 20,
            signature: "c2lnbmF0dXJl",
          },
          senderDeleteAllowed: true,
          updatedAtMs: 20,
        },
        {
          transferId: "transfer-interrupted",
          peerDeviceId: "android-history",
          displayName: "复盘.wav",
          wholeFileSha256: "c".repeat(64),
          sizeBytes: 12_000,
          receivedBytes: 6_000,
          missingChunkCount: 2,
          state: "interrupted",
          revision: 2,
          errorCode: "APP_RESTARTED",
          receipt: null,
          senderDeleteAllowed: false,
          updatedAtMs: 30,
        },
      ],
    };
    const { cancelCompanionTransfer, retryCompanionTransfer } = installApi({
      initial: snapshot,
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "查看传输历史" }),
    );
    const progress = await screen.findByRole("progressbar", {
      name: "访谈.wav 接收进度：40%，还缺 3 个待验证分块",
    });
    expect(progress).toHaveValue(40);
    expect(screen.getAllByText("发送端必须保留原件")).toHaveLength(2);
    expect(screen.getByText("已签收，可由发送端删除原件")).toBeVisible();
    expect(screen.getByText(/recording 42/)).toBeVisible();

    const cancel = screen.getByRole("button", { name: "取消接收 访谈.wav" });
    cancel.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(cancelCompanionTransfer).toHaveBeenCalledWith({
        transferId: "transfer-active",
        expectedRevision: 3,
        idempotencyKey: expect.stringMatching(/^companion-cancel:/),
      }),
    );

    const retry = screen.getByRole("button", { name: "重试接收 复盘.wav" });
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(retryCompanionTransfer).toHaveBeenCalledWith({
        transferId: "transfer-interrupted",
        expectedRevision: 2,
        idempotencyKey: expect.stringMatching(/^companion-retry:/),
      }),
    );
  });

  it("rejects stale subscription snapshots after a restart snapshot", async () => {
    const restored: CompanionSnapshot = {
      ...disabledSnapshot,
      revision: 10,
      optIn: true,
      discovery: {
        state: "ready",
        manualFallbackAvailable: true,
        errorCode: null,
      },
      identity: {
        deviceId: "desktop-01",
        deviceName: "Voice2Text Mac",
        fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        port: 42_424,
      },
    };
    const { emitCompanion } = installApi({ initial: restored });
    render(<App />);
    expect(
      await screen.findByRole("status", { name: "手机接收器已就绪" }),
    ).toBeVisible();

    act(() => emitCompanion(disabledSnapshot));
    expect(
      screen.getByRole("status", { name: "手机接收器已就绪" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "启用手机接收" }),
    ).not.toBeInTheDocument();
  });
});

function installApi({
  initial,
  enableResult = initial,
  inviteResult = initial,
}: {
  initial: CompanionSnapshot;
  enableResult?: CompanionSnapshot;
  inviteResult?: CompanionSnapshot;
}) {
  let companionListener: ((snapshot: CompanionSnapshot) => void) | undefined;
  const getCompanionSnapshot = vi.fn(async () => initial);
  const setCompanionOptIn = vi.fn(async () => enableResult);
  const createCompanionPairingInvite = vi.fn(async () => inviteResult);
  const revokeCompanionPeer = vi.fn(async () => initial);
  const cancelCompanionTransfer = vi.fn(async () => initial);
  const retryCompanionTransfer = vi.fn(async () => initial);
  const api = {
    getApplicationSnapshot: vi.fn(async () => application),
    navigate: vi.fn(async () => application),
    requestBootstrapAction: vi.fn(async () => application),
    onApplicationSnapshot: vi.fn(() => () => undefined),
    listProcessingTasks: vi.fn(async () => []),
    onOperationEvent: vi.fn(() => () => undefined),
    listAudios: vi.fn(async () => []),
    listCaptureRecoveries: vi.fn(async () => []),
    getCaptionSnapshot: vi.fn(async () => null),
    onCaptionSnapshot: vi.fn(() => () => undefined),
    getCompanionSnapshot,
    setCompanionOptIn,
    createCompanionPairingInvite,
    revokeCompanionPeer,
    cancelCompanionTransfer,
    retryCompanionTransfer,
    onCompanionSnapshot: vi.fn(
      (listener: (snapshot: CompanionSnapshot) => void) => {
        companionListener = listener;
        return () => undefined;
      },
    ),
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return {
    api,
    getCompanionSnapshot,
    setCompanionOptIn,
    createCompanionPairingInvite,
    revokeCompanionPeer,
    cancelCompanionTransfer,
    retryCompanionTransfer,
    emitCompanion(snapshot: CompanionSnapshot) {
      companionListener?.(snapshot);
    },
  };
}
