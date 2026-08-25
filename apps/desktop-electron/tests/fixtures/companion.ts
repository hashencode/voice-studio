import type {
  CompanionSnapshot,
  LocalModelSnapshot,
  Voice2TextDesktopApi,
} from "../../src/shared/contracts";

export const localModelSnapshot: LocalModelSnapshot = {
  schemaVersion: 1,
  revision: 1,
  runtime: {
    state: "ready",
    message: "Worker Runtime 正常",
    identity: "runtime",
  },
  storage: {
    state: "ready",
    displayPath: "/private/test-models",
    storeId: "store-123456789012",
    usedBytes: 0,
  },
  bundles: [
    {
      id: "formal-transcription",
      displayName: "本地转写",
      state: "not-installed",
      version: null,
      installedBytes: 0,
      expectedBytes: 0,
      progressBytes: 0,
      message: null,
      distributionEligible: false,
    },
    {
      id: "live-caption",
      displayName: "实时字幕",
      state: "not-installed",
      version: null,
      installedBytes: 0,
      expectedBytes: 0,
      progressBytes: 0,
      message: null,
      distributionEligible: false,
    },
  ],
  operation: null,
  leaseCount: 0,
  processingTaskCount: 0,
  canChangeRoot: true,
};

const microphoneSnapshot = {
  testId: "mic-test-123456789012",
  state: "running" as const,
  elapsedMs: 0,
  remainingMs: 30_000,
  normalizedPeak: 0,
  observedFrames: 0,
  detectedInput: false,
};

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
    getLocalModelSnapshot: async () => localModelSnapshot,
    sendLocalModelIntent: async () => localModelSnapshot,
    changeLocalModelRoot: async () => localModelSnapshot,
    onLocalModelSnapshot: () => () => undefined,
    startTranscription: async (audioId: number) => ({
      protocolVersion: 2 as const,
      jobId: audioId,
      state: "queued" as const,
    }),
    startMicrophoneTest: async () => microphoneSnapshot,
    getMicrophoneTestSnapshot: async () => microphoneSnapshot,
    stopMicrophoneTest: async () => ({
      ...microphoneSnapshot,
      state: "stopped" as const,
    }),
  } satisfies Pick<
    Voice2TextDesktopApi,
    | "getCompanionSnapshot"
    | "setCompanionOptIn"
    | "createCompanionPairingInvite"
    | "revokeCompanionPeer"
    | "cancelCompanionTransfer"
    | "retryCompanionTransfer"
    | "getLocalModelSnapshot"
    | "sendLocalModelIntent"
    | "changeLocalModelRoot"
    | "onLocalModelSnapshot"
    | "startTranscription"
    | "startMicrophoneTest"
    | "getMicrophoneTestSnapshot"
    | "stopMicrophoneTest"
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
