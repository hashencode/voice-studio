import { contextBridge } from "electron";

import type {
  FloatingCaptureSnapshot,
  Voice2TextDesktopApi,
  Voice2TextFloatingApi,
} from "../../../src/shared/contracts";
import type { VisualRendererFixture } from "../fixtures/renderer-api";
import { localModelSnapshot } from "../../fixtures/companion";

const encodedFixture = process.env.VOICE2TEXT_VISUAL_FIXTURE;
if (!encodedFixture) {
  throw new Error("VOICE2TEXT_VISUAL_FIXTURE is required");
}

const fixture = JSON.parse(encodedFixture) as VisualRendererFixture;
let application = structuredClone(fixture.application);
const workspaceById = new Map(
  fixture.audioWorkspaces.map((workspace) => [
    workspace.summary.audioId,
    workspace,
  ]),
);

const api: Voice2TextDesktopApi = {
  async getApplicationSnapshot() {
    return structuredClone(application);
  },
  async navigate(section) {
    application = {
      ...application,
      revision: application.revision + 1,
      navigation: { section },
    };
    return structuredClone(application);
  },
  async requestBootstrapAction() {
    return structuredClone(application);
  },
  async markActivityRead() {
    return structuredClone(application);
  },
  async markAllActivityRead() {
    return structuredClone(application);
  },
  onApplicationSnapshot() {
    return () => undefined;
  },
  async workerHealth() {
    throw new Error("workerHealth is outside the visual fixture");
  },
  async cancelProcessing() {
    throw new Error("cancelProcessing is outside the visual fixture");
  },
  async retryProcessing() {
    throw new Error("retryProcessing is outside the visual fixture");
  },
  async startTranscription(audioId) {
    return { protocolVersion: 2, jobId: audioId, state: "queued" };
  },
  async listProcessingTasks() {
    return [];
  },
  async importAudio() {
    return { protocolVersion: 2, state: "canceled" };
  },
  onOperationEvent() {
    return () => undefined;
  },
  async listAudios(query = "") {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return fixture.audios.filter((audio) =>
      audio.displayName.toLocaleLowerCase("zh-CN").includes(normalized),
    );
  },
  async openAudio(audioId) {
    return structuredClone(workspaceById.get(audioId) ?? null);
  },
  async searchTranscript(audioId, query) {
    const workspace = workspaceById.get(audioId);
    if (!workspace) return [];
    return workspace.segments.filter((segment) => segment.text.includes(query));
  },
  async editAudioSegment(command) {
    return requiredWorkspace(command.audioId);
  },
  async undoAudioEdit(audioId) {
    return requiredWorkspace(audioId);
  },
  async redoAudioEdit(audioId) {
    return requiredWorkspace(audioId);
  },
  async renameAudioSpeaker(command) {
    return requiredWorkspace(command.audioId);
  },
  async mergeAudioSpeakers(command) {
    return requiredWorkspace(command.audioId);
  },
  async assignAudioSpeaker(command) {
    return requiredWorkspace(command.audioId);
  },
  async controlAudioPlayback(audioId, command) {
    const workspace = requiredWorkspace(audioId);
    return {
      audioId: command.action === "close" ? null : audioId,
      initialized: command.action !== "close",
      playing: command.action === "play",
      positionMs: command.action === "seek" ? command.positionMs : 36_000,
      durationMs: workspace.summary.durationMs,
      speed: command.action === "speed" ? command.speed : 1,
      error: null,
    };
  },
  async exportAudio() {
    return { state: "canceled" };
  },
  async preflightCapture() {
    return structuredClone(fixture.preflight);
  },
  async startCapture() {
    return activeCaptureSnapshot();
  },
  async controlCapture() {
    return activeCaptureSnapshot();
  },
  async listCaptureRecoveries() {
    return structuredClone(fixture.recoveries);
  },
  async actOnCaptureRecovery() {
    return null;
  },
  async getCaptionSnapshot() {
    return null;
  },
  async retryFormalTranscript() {
    throw new Error("retryFormalTranscript is outside the visual fixture");
  },
  onCaptionSnapshot() {
    return () => undefined;
  },
  async startMicrophoneTest() {
    return microphoneTestFixture("running");
  },
  async getMicrophoneTestSnapshot() {
    return microphoneTestFixture("running");
  },
  async finishMicrophoneTest() {
    return microphoneTestFixture("finished");
  },
  async cancelMicrophoneTest() {
    return microphoneTestFixture("cancelled");
  },
  async openMicrophoneSettings() {
    return { state: "opened" as const };
  },
  async getFloatingCapturePreference() {
    return { enabled: true };
  },
  async setFloatingCapturePreference(enabled) {
    return { enabled };
  },
  async getCompanionSnapshot() {
    return structuredClone(fixture.companion);
  },
  async setCompanionOptIn() {
    return structuredClone(fixture.companion);
  },
  async createCompanionPairingInvite() {
    return structuredClone(fixture.companion);
  },
  async revokeCompanionPeer() {
    return structuredClone(fixture.companion);
  },
  async cancelCompanionTransfer() {
    return structuredClone(fixture.companion);
  },
  async retryCompanionTransfer() {
    return structuredClone(fixture.companion);
  },
  onCompanionSnapshot() {
    return () => undefined;
  },
  async getLocalModelSnapshot() {
    return structuredClone(localModelSnapshot);
  },
  async sendLocalModelIntent() {
    return structuredClone(localModelSnapshot);
  },
  async changeLocalModelRoot() {
    return structuredClone(localModelSnapshot);
  },
  async openLocalModelRoot() {},
  onLocalModelSnapshot() {
    return () => undefined;
  },
  async getAiSettings() {
    return structuredClone(fixture.aiSettings);
  },
  async createAiProviderProfile() {
    return structuredClone(fixture.aiSettings);
  },
  async updateAiProviderProfile() {
    return structuredClone(fixture.aiSettings);
  },
  async selectAiProviderProfile() {
    return structuredClone(fixture.aiSettings);
  },
  async deleteAiProviderProfile() {
    return structuredClone(fixture.aiSettings);
  },
  async prepareAudioAi() {
    throw new Error("prepareAudioAi is outside the visual fixture");
  },
  async getAudioAiSnapshot() {
    return null;
  },
  async generateAudioAi() {
    throw new Error("generateAudioAi is outside the visual fixture");
  },
  async retryAudioAi() {
    throw new Error("retryAudioAi is outside the visual fixture");
  },
  onAudioAiSnapshot() {
    return () => undefined;
  },
};

function microphoneTestFixture(state: "running" | "finished" | "cancelled") {
  return {
    testId: "mic-test-123456789012",
    state,
    ...(state === "finished" ? { reason: "no-audio-frames" as const } : {}),
    elapsedMs: 0,
    normalizedRMS: 0,
    normalizedPeak: 0,
    observedFrames: 0,
    observedSound: false,
  };
}

contextBridge.exposeInMainWorld("voice2text", Object.freeze(api));

let floatingSnapshot: FloatingCaptureSnapshot = {
  revision: 9,
  sessionId: "session-visual-active-0001",
  phase: "recording" as const,
  elapsedMs: 72_000,
  allowedActions: ["pause", "stop"],
  attention: false,
};
const floatingApi: Voice2TextFloatingApi = {
  async getSnapshot() {
    return structuredClone(floatingSnapshot);
  },
  async control(command) {
    floatingSnapshot = {
      ...floatingSnapshot,
      revision: floatingSnapshot.revision + 1,
      phase: command.action === "pause" ? "paused" : "recording",
      allowedActions:
        command.action === "pause" ? ["resume", "stop"] : ["pause", "stop"],
    };
    return structuredClone(floatingSnapshot);
  },
  async windowAction() {
    return structuredClone(floatingSnapshot);
  },
  onSnapshot() {
    return () => undefined;
  },
};

contextBridge.exposeInMainWorld(
  "voice2textFloating",
  Object.freeze(floatingApi),
);

function requiredWorkspace(audioId: number) {
  const workspace = workspaceById.get(audioId);
  if (!workspace) throw new Error(`Missing visual workspace for ${audioId}`);
  return structuredClone(workspace);
}

function activeCaptureSnapshot() {
  return {
    sessionId: "session-visual-active-0001",
    state: "recording" as const,
    captureMode: "dual_track" as const,
    captureTimelineMs: 72_000,
    systemAudioHealthy: true,
    microphoneHealthy: true,
    partialCapture: false,
    finalizedChunkCount: 14,
    eventCount: 16,
    gapCount: 0,
    interruptionReason: null,
    recordingSha256: null,
  };
}
