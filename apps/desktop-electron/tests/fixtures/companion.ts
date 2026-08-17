import type {
  CompanionSnapshot,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";

export const disabledCompanionSnapshot: CompanionSnapshot = {
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

export function companionCommandStubs() {
  return {
    getCompanionSnapshot: async () => disabledCompanionSnapshot,
    setCompanionOptIn: async () => disabledCompanionSnapshot,
    createCompanionPairingInvite: async () => disabledCompanionSnapshot,
    revokeCompanionPeer: async () => disabledCompanionSnapshot,
    cancelCompanionTransfer: async () => disabledCompanionSnapshot,
    retryCompanionTransfer: async () => disabledCompanionSnapshot,
  } satisfies Pick<
    Voice2TextDesktopApi,
    | "getCompanionSnapshot"
    | "setCompanionOptIn"
    | "createCompanionPairingInvite"
    | "revokeCompanionPeer"
    | "cancelCompanionTransfer"
    | "retryCompanionTransfer"
  >;
}

export function companionRendererStubs() {
  return {
    ...companionCommandStubs(),
    onCompanionSnapshot: () => () => undefined,
  } satisfies Pick<
    Voice2TextDesktopApi,
    | "getCompanionSnapshot"
    | "setCompanionOptIn"
    | "createCompanionPairingInvite"
    | "revokeCompanionPeer"
    | "cancelCompanionTransfer"
    | "retryCompanionTransfer"
    | "onCompanionSnapshot"
  >;
}
