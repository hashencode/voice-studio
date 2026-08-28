// @vitest-environment jsdom

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../../../src/renderer/App";
import type {
  ApplicationSnapshot,
  CompanionSnapshot,
  Voice2TextDesktopApi,
} from "../../../src/shared/contracts";

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

const baseSnapshot: CompanionSnapshot = {
  protocolVersion: 2,
  revision: 1,
  optIn: true,
  discovery: {
    state: "ready",
    manualFallbackAvailable: true,
    errorCode: null,
  },
  pairing: { state: "idle", errorCode: null },
  identity: {
    deviceId: "desktop-01",
    deviceName: "Voice2Text Mac",
    fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    port: 42_424,
  },
  pairingInvite: null,
  peers: [],
  transfers: [],
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("Companion route composition", () => {
  it("lists non-revoked devices and changes viewed detail without connecting", async () => {
    const connectCompanionPeer = vi.fn();
    const snapshot: CompanionSnapshot = {
      ...baseSnapshot,
      peers: [
        peer("phone-a", "Alpha Phone", "active"),
        peer("phone-b", "Beta Phone", "credential-missing"),
        peer("phone-revoked", "Revoked Phone", "revoked"),
      ],
      transfers: [
        transfer("transfer-a", "Alpha.wav", "phone-a", "transferring"),
        transfer("transfer-b", "Beta.wav", "phone-b", "interrupted"),
      ],
    };
    installApi(snapshot, { connectCompanionPeer });
    const user = userEvent.setup();
    render(<App />);

    const pane = await screen.findByRole("complementary", {
      name: "互联上下文面板",
    });
    expect(
      await within(pane).findByRole("button", { name: /Alpha Phone/ }),
    ).toBeVisible();
    expect(
      within(pane).queryByRole("button", { name: "配对设备" }),
    ).not.toBeInTheDocument();
    expect(
      within(pane).queryByText("选择只会切换查看内容，不会主动连接设备。"),
    ).not.toBeInTheDocument();
    const list = within(pane).getByRole("list", { name: "已信任设备列表" });
    expect(list).toHaveAttribute("data-flat-row-list", "true");
    const alphaRow = within(list).getByRole("button", { name: /Alpha Phone/ });
    expect(alphaRow).toHaveAttribute("data-flat-row", "true");
    expect(alphaRow).toHaveAttribute("data-slot", "item");
    expect(alphaRow).not.toHaveClass("rounded-lg", "border");
    expect(
      within(pane).getByRole("button", { name: /Beta Phone/ }),
    ).toHaveTextContent("需要重新配对");
    expect(within(pane).queryByText("Revoked Phone")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "手机接收器已就绪" }),
    ).toBeVisible();

    await user.click(within(pane).getByRole("button", { name: /Alpha Phone/ }));
    expect(
      screen.getByRole("heading", { name: "Alpha Phone", level: 1 }),
    ).toBeVisible();
    const pairingAction = within(pane).getByRole("button", {
      name: "配对设备",
    });
    expect(
      pairingAction.closest("[data-context-pane-fixed-footer]"),
    ).not.toBeNull();
    expect(screen.getByText("Alpha.wav")).toBeVisible();
    expect(
      screen.getByRole("progressbar", {
        name: "Alpha.wav 接收进度 40%",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Beta.wav")).not.toBeInTheDocument();
    expect(connectCompanionPeer).not.toHaveBeenCalled();

    await user.click(within(pane).getByRole("button", { name: /Beta Phone/ }));
    expect(
      screen.getByRole("heading", { name: "Beta Phone", level: 1 }),
    ).toBeVisible();
    expect(screen.getAllByText("需要重新配对")).toHaveLength(2);
    expect(screen.getByText("Beta.wav")).toBeVisible();
    expect(screen.queryByText("Alpha.wav")).not.toBeInTheDocument();
    expect(connectCompanionPeer).not.toHaveBeenCalled();
  });

  it("keeps pairing primary with no trusted device and reveals durable history secondarily", async () => {
    const snapshot: CompanionSnapshot = {
      ...baseSnapshot,
      peers: [peer("phone-revoked", "Old Phone", "revoked")],
      transfers: [
        transfer("transfer-old", "历史录音.wav", "phone-revoked", "committed"),
      ],
    };
    installApi(snapshot);
    const user = userEvent.setup();
    render(<App />);

    const pane = await screen.findByRole("complementary", {
      name: "互联上下文面板",
    });
    const emptyHeading = await within(pane).findByRole("heading", {
      name: "没有已信任设备",
    });
    const empty = emptyHeading.parentElement!;
    expect(empty).toHaveClass("flex-1", "min-h-0");
    expect(
      within(empty).getByRole("heading", { name: "没有已信任设备" }),
    ).toBeVisible();
    expect(within(pane).queryByText("Old Phone")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "手机接收器已就绪" }),
    ).toBeVisible();
    expect(screen.queryByText("历史录音.wav")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看传输历史" }));
    expect(
      screen.getByRole("heading", { name: "传输历史", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText("历史录音.wav")).toBeVisible();
    expect(screen.getByText("已签收，可由发送端删除原件")).toBeVisible();
  });

  it("never auto-selects one device and restores a still-valid explicit selection", async () => {
    const first: CompanionSnapshot = {
      ...baseSnapshot,
      revision: 3,
      peers: [peer("phone-a", "Alpha Phone", "active")],
    };
    const { emitCompanion } = installApi(first);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: /Alpha Phone/ });
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();

    act(() =>
      emitCompanion({
        ...first,
        revision: 4,
        peers: [
          peer("phone-a", "Alpha Phone", "active"),
          peer("phone-b", "Beta Phone", "active"),
        ],
      }),
    );
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();

    const pane = screen.getByRole("complementary", { name: "互联上下文面板" });
    await user.click(within(pane).getByRole("button", { name: /Beta Phone/ }));
    expect(
      screen.getByRole("heading", { name: "Beta Phone", level: 1 }),
    ).toBeVisible();

    act(() =>
      emitCompanion({
        ...first,
        revision: 5,
        peers: [
          peer("phone-a", "Alpha Phone", "active"),
          peer("phone-b", "Beta Phone renamed", "active"),
        ],
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Beta Phone renamed", level: 1 }),
    ).toBeVisible();
  });
});

function peer(
  deviceId: string,
  displayName: string,
  trustState: "active" | "revoked" | "credential-missing",
): CompanionSnapshot["peers"][number] {
  return {
    deviceId,
    displayName,
    identityFingerprint: "BCDEFGHIJKLMNOPQRSTUVWXYZ234567A",
    trustState,
    availability: "unknown",
    pairedAtMs: 1,
    lastSeenAtMs: null,
  };
}

function transfer(
  transferId: string,
  displayName: string,
  peerDeviceId: string,
  state: "transferring" | "interrupted" | "committed",
): CompanionSnapshot["transfers"][number] {
  return {
    transferId,
    peerDeviceId,
    displayName,
    wholeFileSha256: "a".repeat(64),
    sizeBytes: 10_000,
    receivedBytes: state === "committed" ? 10_000 : 4_000,
    missingChunkCount: state === "committed" ? 0 : 3,
    state,
    revision: 3,
    errorCode: state === "interrupted" ? "APP_RESTARTED" : null,
    receipt:
      state === "committed"
        ? {
            schema: "companion-audio-transfer/v2",
            receiptId: "receipt-old",
            transferId,
            wholeFileSha256: "a".repeat(64),
            sizeBytes: 10_000,
            desktopDeviceId: "desktop-01",
            desktopDeviceName: "Voice2Text Mac",
            desktopRecordingId: 42,
            committedAtMs: 20,
            signature: "c2lnbmF0dXJl",
          }
        : null,
    senderDeleteAllowed: state === "committed",
    updatedAtMs: 20,
  };
}

function installApi(
  initial: CompanionSnapshot,
  additions: Record<string, unknown> = {},
) {
  let companionListener: ((snapshot: CompanionSnapshot) => void) | undefined;
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
    getCompanionSnapshot: vi.fn(async () => initial),
    setCompanionOptIn: vi.fn(async () => initial),
    createCompanionPairingInvite: vi.fn(async () => initial),
    revokeCompanionPeer: vi.fn(async () => initial),
    cancelCompanionTransfer: vi.fn(async () => initial),
    retryCompanionTransfer: vi.fn(async () => initial),
    onCompanionSnapshot: vi.fn(
      (listener: (snapshot: CompanionSnapshot) => void) => {
        companionListener = listener;
        return () => undefined;
      },
    ),
    ...additions,
  } as unknown as Voice2TextDesktopApi;
  Object.defineProperty(window, "voice2text", {
    configurable: true,
    value: api,
  });
  return {
    emitCompanion(snapshot: CompanionSnapshot) {
      companionListener?.(snapshot);
    },
  };
}
