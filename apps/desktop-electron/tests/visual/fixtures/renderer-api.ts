import type {
  AiSettingsSnapshot,
  ApplicationSnapshot,
  AudioSummary,
  AudioWorkspaceSnapshot,
  CapturePreflight,
  CaptureSnapshot,
  CompanionSnapshot,
} from "../../../src/shared/contracts";

export type VisualScenario =
  | "audio-active"
  | "audio-closed"
  | "settings"
  | "audio-recovery"
  | "companion-devices";

export interface VisualRendererFixture {
  application: ApplicationSnapshot;
  audios: AudioSummary[];
  audioWorkspaces: AudioWorkspaceSnapshot[];
  companion: CompanionSnapshot;
  recoveries: CaptureSnapshot[];
  preflight: CapturePreflight;
  aiSettings: AiSettingsSnapshot;
}

export const VISUAL_NOW_MS = Date.UTC(2026, 7, 19, 3, 20, 0);

export function buildVisualFixture(
  scenario: VisualScenario,
): VisualRendererFixture {
  const activeCapture = scenario === "audio-active";
  const recovery = scenario === "audio-recovery";
  const companion = companionFixture();
  const audios = audioFixtures();

  return {
    application: {
      protocolVersion: 2,
      revision: 42,
      navigation: {
        section:
          scenario === "settings"
            ? "settings"
            : scenario === "companion-devices"
              ? "companion"
              : "library",
      },
      profile: { phase: "ready", legacyDatabaseArchived: false },
      connectivity: "online",
      capability: { processing: "available" },
      library: { phase: "ready", audioCount: audios.length },
      reconciliation: [],
      capture: activeCapture
        ? {
            phase: "recording",
            sessionId: "session-visual-active-0001",
            title: "产品设计评审",
            elapsedMs: 72_000,
            captureMode: "dual_track",
            systemAudioHealthy: true,
            microphoneHealthy: true,
            partialCapture: false,
            gapCount: 0,
            interruptionReason: null,
          }
        : { phase: "idle" },
    },
    audios,
    audioWorkspaces: audios.map(audioWorkspace),
    companion,
    recoveries: recovery ? recoveryFixtures() : [],
    preflight: {
      minimumMacosVersion: "13.0",
      systemAudioMinimumMacosVersion: "13.0",
      captureMode: "dual_track",
      systemAudioPermission: "granted",
      microphonePermission: "granted",
      microphones: [
        { id: "mic-default", name: "MacBook 麦克风", isDefault: true },
      ],
      availableBytes: 16 * 1024 ** 3,
      requiredBytes: 2 * 1024 ** 3,
      captionModelAvailable: true,
      canStart: true,
      blockingReasons: [],
    },
    aiSettings: {
      revision: 8,
      config: {
        providerId: "deepseek",
        displayName: "DeepSeek",
        modelId: "deepseek-chat",
        endpoint: "https://api.deepseek.com",
        endpointOrigin: "https://api.deepseek.com",
        processingLocation: "cloudDirect",
        requiresConsent: true,
      },
      secretState: "available",
      deviceSecurity: {
        kind: "device-security",
        fileVaultState: "enabled",
        applicationLayerEncryption: "not-claimed",
      },
    },
  };
}

function audioFixtures(): AudioSummary[] {
  return [
    audioSummary(
      101,
      "产品设计评审.wav",
      48 * 60_000,
      VISUAL_NOW_MS - 90 * 60_000,
    ),
    audioSummary(
      102,
      "移动端同步讨论.m4a",
      23 * 60_000,
      VISUAL_NOW_MS - 86_400_000,
    ),
    audioSummary(
      103,
      "周会行动项.wav",
      37 * 60_000,
      VISUAL_NOW_MS - 172_800_000,
    ),
    audioSummary(
      104,
      "用户访谈 08-16.mp3",
      54 * 60_000,
      VISUAL_NOW_MS - 259_200_000,
    ),
  ];
}

function audioSummary(
  audioId: number,
  displayName: string,
  durationMs: number,
  createdAtMs: number,
): AudioSummary {
  return {
    audioId,
    displayName,
    durationMs,
    createdAtMs,
    processingState: "completed",
    generationId: audioId + 1_000,
    generationKind: "formal",
    segmentCount: 3,
  };
}

function audioWorkspace(summary: AudioSummary): AudioWorkspaceSnapshot {
  const generationId = summary.generationId ?? summary.audioId + 1_000;
  return {
    revision: 7,
    summary,
    speakers: [
      {
        id: 1,
        stableKey: `${summary.audioId}:speaker:1`,
        displayName: "林然",
        source: "manual",
        mergedIntoSpeakerId: null,
      },
      {
        id: 2,
        stableKey: `${summary.audioId}:speaker:2`,
        displayName: "陈遥",
        source: "machine",
        mergedIntoSpeakerId: null,
      },
    ],
    segments: [
      segment(
        1,
        generationId,
        0,
        "我们先确认桌面工作台的导航层级。",
        1,
        "林然",
      ),
      segment(
        2,
        generationId,
        1,
        "音频列表保持紧凑，正文区域用于审阅和编辑。",
        2,
        "陈遥",
      ),
      segment(
        3,
        generationId,
        2,
        "录制控制器需要在最小窗口内保持可操作。",
        1,
        "林然",
      ),
    ],
    canUndo: true,
    canRedo: false,
  };
}

function segment(
  id: number,
  generationId: number,
  sequenceId: number,
  text: string,
  speakerId: number,
  speakerName: string,
): AudioWorkspaceSnapshot["segments"][number] {
  const startMs = sequenceId * 8_000;
  return {
    id,
    stableKey: `${generationId}:${startMs}:${startMs + 6_000}`,
    sequenceId,
    text,
    machineText: text,
    startMs,
    endMs: startMs + 6_000,
    reviewState: sequenceId === 0 ? "reviewed" : "unreviewed",
    speakerState: "assigned",
    speakerId,
    speakerName,
    speakerSource: sequenceId === 0 ? "manual" : "machine",
  };
}

function companionFixture(): CompanionSnapshot {
  return {
    protocolVersion: 2,
    revision: 12,
    optIn: true,
    discovery: {
      state: "ready",
      manualFallbackAvailable: true,
      errorCode: null,
    },
    pairing: { state: "idle", errorCode: null },
    identity: {
      deviceId: "desktop-visual",
      deviceName: "Voice2Text Mac",
      fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      port: 42_424,
    },
    pairingInvite: null,
    peers: [
      peer("phone-studio", "Studio 的 iPhone", "online"),
      peer("phone-field", "外勤录音机", "offline"),
      {
        ...peer("phone-archive", "旧设备", "unknown"),
        trustState: "credential-missing",
      },
    ],
    transfers: [
      {
        transferId: "transfer-visual-01",
        peerDeviceId: "phone-studio",
        displayName: "移动访谈录音.wav",
        wholeFileSha256: "a".repeat(64),
        sizeBytes: 24_000_000,
        receivedBytes: 15_600_000,
        missingChunkCount: 12,
        state: "transferring",
        revision: 3,
        errorCode: null,
        receipt: null,
        senderDeleteAllowed: false,
        updatedAtMs: VISUAL_NOW_MS - 30_000,
      },
    ],
  };
}

function peer(
  deviceId: string,
  displayName: string,
  availability: "online" | "offline" | "unknown",
): CompanionSnapshot["peers"][number] {
  return {
    deviceId,
    displayName,
    identityFingerprint: "BCDEFGHIJKLMNOPQRSTUVWXYZ234567A",
    trustState: "active",
    availability,
    pairedAtMs: VISUAL_NOW_MS - 604_800_000,
    lastSeenAtMs: availability === "unknown" ? null : VISUAL_NOW_MS - 60_000,
  };
}

function recoveryFixtures(): CaptureSnapshot[] {
  return [0, 1, 2, 3, 4, 5].map((index) => ({
    sessionId: `session-visual-recovery-000${index + 1}`,
    state: "recoverable",
    captureMode: "dual_track",
    captureTimelineMs: (index + 2) * 15 * 60_000,
    systemAudioHealthy: true,
    microphoneHealthy: true,
    partialCapture: index === 1,
    finalizedChunkCount: 18 + index * 7,
    eventCount: 22 + index * 9,
    gapCount: index,
    interruptionReason: "renderer_reloaded",
    recordingSha256: null,
  }));
}
