import {
  applicationSnapshotSchema,
  markActivityReadRequestSchema,
  markAllActivityReadRequestSchema,
  bootstrapActionSchema,
  cancelProcessingResponseSchema,
  retryProcessingResponseSchema,
  startTranscriptionResponseSchema,
  processingTasksResponseSchema,
  importAudioResponseSchema,
  desktopProtocolVersion,
  shellSectionSchema,
  ipcChannels,
  operationEventSchema,
  workerHealthResponseSchema,
  type ApplicationSnapshot,
  type BootstrapAction,
  type OperationEvent,
  type ShellSection,
  type Voice2TextDesktopApi,
  listAudiosRequestSchema,
  listAudiosResponseSchema,
  openAudioRequestSchema,
  openAudioResponseSchema,
  searchTranscriptRequestSchema,
  searchTranscriptResponseSchema,
  editAudioSegmentRequestSchema,
  audioHistoryRequestSchema,
  renameAudioSpeakerRequestSchema,
  mergeAudioSpeakersRequestSchema,
  assignAudioSpeakerRequestSchema,
  controlAudioPlaybackRequestSchema,
  audioPlaybackSnapshotSchema,
  exportAudioRequestSchema,
  exportAudioResponseSchema,
  audioWorkspaceSnapshotSchema,
  type AudioExportFormat,
  type PlaybackAction,
  capturePreflightRequestSchema,
  captureStartRequestSchema,
  captureControlRequestSchema,
  captureRecoveryActionRequestSchema,
  capturePreflightSchema,
  captureSnapshotSchema,
  microphoneTestStartRequestSchema,
  microphoneTestControlRequestSchema,
  microphoneTestSnapshotSchema,
  microphoneSettingsOpenRequestSchema,
  microphoneSettingsOpenResultSchema,
  floatingCapturePreferenceRequestSchema,
  floatingCapturePreferenceSchema,
  captionSnapshotRequestSchema,
  captionFormalRetryRequestSchema,
  captionSnapshotSchema,
  type CaptionSnapshot,
  getAiSettingsRequestSchema,
  createAiProviderProfileRequestSchema,
  updateAiProviderProfileRequestSchema,
  selectAiProviderProfileRequestSchema,
  deleteAiProviderProfileRequestSchema,
  prepareAudioAiRequestSchema,
  getAudioAiSnapshotRequestSchema,
  generateAudioAiRequestSchema,
  retryAudioAiRequestSchema,
  aiSettingsSnapshotSchema,
  audioAiConsentPreviewSchema,
  audioAiSnapshotSchema,
  type AudioAiSnapshot,
  companionSnapshotRequestSchema,
  companionOptInRequestSchema,
  companionPairingInviteRequestSchema,
  companionPeerRevokeRequestSchema,
  companionTransferCancelRequestSchema,
  companionTransferRetryRequestSchema,
  companionSnapshotSchema,
  type CompanionSnapshot,
  localModelSnapshotRequestSchema,
  localModelSnapshotSchema,
  localModelIntentSchema,
  changeLocalModelRootRequestSchema,
  openLocalModelRootRequestSchema,
  type LocalModelSnapshot,
} from "../shared/contracts";

export interface PreloadIpcBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): void;
  off(channel: string, listener: (payload: unknown) => void): void;
}

export function createDesktopApi(
  bridge: PreloadIpcBridge,
): Voice2TextDesktopApi {
  const captureDetailsListeners = new Set<() => void>();
  let captureDetailsPending = false;
  bridge.on(ipcChannels.captureDetailsRequestedEvent, () => {
    if (captureDetailsListeners.size === 0) {
      captureDetailsPending = true;
      return;
    }
    for (const listener of captureDetailsListeners) listener();
  });
  return Object.freeze({
    async getLocalModelSnapshot() {
      return localModelSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.localModelsSnapshotGet,
          localModelSnapshotRequestSchema.parse({}),
        ),
      );
    },
    async sendLocalModelIntent(
      options: Parameters<Voice2TextDesktopApi["sendLocalModelIntent"]>[0],
    ) {
      return localModelSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.localModelsIntent,
          localModelIntentSchema.parse(options),
        ),
      );
    },
    async changeLocalModelRoot(
      options: Parameters<Voice2TextDesktopApi["changeLocalModelRoot"]>[0],
    ) {
      return localModelSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.localModelsChangeRoot,
          changeLocalModelRootRequestSchema.parse(options),
        ),
      );
    },
    async openLocalModelRoot() {
      await bridge.invoke(
        ipcChannels.localModelsOpenRoot,
        openLocalModelRootRequestSchema.parse({}),
      );
    },
    onLocalModelSnapshot(listener: (snapshot: LocalModelSnapshot) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(localModelSnapshotSchema.parse(payload));
      };
      bridge.on(ipcChannels.localModelsSnapshotEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.localModelsSnapshotEvent, validatedListener);
      };
    },
    async getCompanionSnapshot() {
      return companionSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.companionSnapshotGet,
          companionSnapshotRequestSchema.parse({}),
        ),
      );
    },
    async setCompanionOptIn(
      options: Parameters<Voice2TextDesktopApi["setCompanionOptIn"]>[0],
    ) {
      return companionSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.companionOptInSet,
          companionOptInRequestSchema.parse(options),
        ),
      );
    },
    async createCompanionPairingInvite(
      options: Parameters<
        Voice2TextDesktopApi["createCompanionPairingInvite"]
      >[0],
    ) {
      return companionSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.companionPairingInviteCreate,
          companionPairingInviteRequestSchema.parse(options),
        ),
      );
    },
    async revokeCompanionPeer(
      options: Parameters<Voice2TextDesktopApi["revokeCompanionPeer"]>[0],
    ) {
      return companionSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.companionPeerRevoke,
          companionPeerRevokeRequestSchema.parse(options),
        ),
      );
    },
    async cancelCompanionTransfer(
      options: Parameters<Voice2TextDesktopApi["cancelCompanionTransfer"]>[0],
    ) {
      return companionSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.companionTransferCancel,
          companionTransferCancelRequestSchema.parse(options),
        ),
      );
    },
    async retryCompanionTransfer(
      options: Parameters<Voice2TextDesktopApi["retryCompanionTransfer"]>[0],
    ) {
      return companionSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.companionTransferRetry,
          companionTransferRetryRequestSchema.parse(options),
        ),
      );
    },
    onCompanionSnapshot(listener: (snapshot: CompanionSnapshot) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(companionSnapshotSchema.parse(payload));
      };
      bridge.on(ipcChannels.companionSnapshotEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.companionSnapshotEvent, validatedListener);
      };
    },
    async getAiSettings() {
      const payload = getAiSettingsRequestSchema.parse({});
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiSettingsGet, payload),
      );
    },
    async createAiProviderProfile(
      options: Parameters<Voice2TextDesktopApi["createAiProviderProfile"]>[0],
    ) {
      const payload = createAiProviderProfileRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiProviderProfileCreate, payload),
      );
    },
    async updateAiProviderProfile(
      options: Parameters<Voice2TextDesktopApi["updateAiProviderProfile"]>[0],
    ) {
      const payload = updateAiProviderProfileRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiProviderProfileUpdate, payload),
      );
    },
    async selectAiProviderProfile(
      options: Parameters<Voice2TextDesktopApi["selectAiProviderProfile"]>[0],
    ) {
      const payload = selectAiProviderProfileRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiProviderProfileSelect, payload),
      );
    },
    async deleteAiProviderProfile(
      options: Parameters<Voice2TextDesktopApi["deleteAiProviderProfile"]>[0],
    ) {
      const payload = deleteAiProviderProfileRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiProviderProfileDelete, payload),
      );
    },
    async prepareAudioAi(
      options: Parameters<Voice2TextDesktopApi["prepareAudioAi"]>[0],
    ) {
      const payload = prepareAudioAiRequestSchema.parse(options);
      return audioAiConsentPreviewSchema.parse(
        await bridge.invoke(ipcChannels.audioAiPrepare, payload),
      );
    },
    async getAudioAiSnapshot(
      options: Parameters<Voice2TextDesktopApi["getAudioAiSnapshot"]>[0],
    ) {
      const payload = getAudioAiSnapshotRequestSchema.parse(options);
      const response = await bridge.invoke(
        ipcChannels.audioAiSnapshotGet,
        payload,
      );
      return response === null ? null : audioAiSnapshotSchema.parse(response);
    },
    async generateAudioAi(
      options: Parameters<Voice2TextDesktopApi["generateAudioAi"]>[0],
    ) {
      const payload = generateAudioAiRequestSchema.parse(options);
      return audioAiSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioAiGenerate, payload),
      );
    },
    async retryAudioAi(
      options: Parameters<Voice2TextDesktopApi["retryAudioAi"]>[0],
    ) {
      const payload = retryAudioAiRequestSchema.parse(options);
      return audioAiSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioAiRetry, payload),
      );
    },
    onAudioAiSnapshot(listener: (snapshot: AudioAiSnapshot) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(audioAiSnapshotSchema.parse(payload));
      };
      bridge.on(ipcChannels.audioAiSnapshotEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.audioAiSnapshotEvent, validatedListener);
      };
    },
    async getApplicationSnapshot() {
      const response = await bridge.invoke(ipcChannels.applicationSnapshot, {
        expectedProtocolVersion: desktopProtocolVersion,
      });
      return applicationSnapshotSchema.parse(response);
    },
    async navigate(section: ShellSection) {
      const response = await bridge.invoke(ipcChannels.applicationNavigate, {
        section: shellSectionSchema.parse(section),
      });
      return applicationSnapshotSchema.parse(response);
    },
    async requestBootstrapAction(action: BootstrapAction) {
      const response = await bridge.invoke(
        ipcChannels.applicationBootstrapAction,
        { action: bootstrapActionSchema.parse(action) },
      );
      return applicationSnapshotSchema.parse(response);
    },
    async markActivityRead(activityId: string) {
      const response = await bridge.invoke(
        ipcChannels.applicationActivityMarkRead,
        markActivityReadRequestSchema.parse({ activityId }),
      );
      return applicationSnapshotSchema.parse(response);
    },
    async markAllActivityRead() {
      const response = await bridge.invoke(
        ipcChannels.applicationActivityMarkAllRead,
        markAllActivityReadRequestSchema.parse({}),
      );
      return applicationSnapshotSchema.parse(response);
    },
    async getFloatingCapturePreference() {
      return floatingCapturePreferenceSchema.parse(
        await bridge.invoke(
          ipcChannels.floatingCapturePreferenceGet,
          floatingCapturePreferenceRequestSchema.parse({}),
        ),
      );
    },
    async setFloatingCapturePreference(enabled: boolean) {
      return floatingCapturePreferenceSchema.parse(
        await bridge.invoke(
          ipcChannels.floatingCapturePreferenceSet,
          floatingCapturePreferenceSchema.parse({ enabled }),
        ),
      );
    },
    onApplicationSnapshot(listener: (snapshot: ApplicationSnapshot) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(applicationSnapshotSchema.parse(payload));
      };
      bridge.on(ipcChannels.applicationSnapshotEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.applicationSnapshotEvent, validatedListener);
      };
    },
    onCaptureDetailsRequested(listener: () => void) {
      captureDetailsListeners.add(listener);
      if (captureDetailsPending) {
        captureDetailsPending = false;
        queueMicrotask(() => {
          if (captureDetailsListeners.has(listener)) listener();
        });
      }
      return () => captureDetailsListeners.delete(listener);
    },
    async workerHealth() {
      const response = await bridge.invoke(ipcChannels.workerHealth, {
        expectedProtocolVersion: desktopProtocolVersion,
      });
      return workerHealthResponseSchema.parse(response);
    },
    async cancelProcessing(jobId: number) {
      const response = await bridge.invoke(ipcChannels.cancelProcessing, {
        jobId,
      });
      return cancelProcessingResponseSchema.parse(response);
    },
    async retryProcessing(jobId: number, expectedAttempt: number) {
      const response = await bridge.invoke(ipcChannels.retryProcessing, {
        jobId,
        expectedAttempt,
      });
      return retryProcessingResponseSchema.parse(response);
    },
    async startTranscription(audioId: number) {
      const response = await bridge.invoke(ipcChannels.startTranscription, {
        audioId,
      });
      return startTranscriptionResponseSchema.parse(response);
    },
    async listProcessingTasks() {
      const response = await bridge.invoke(ipcChannels.processingTasks, {
        expectedProtocolVersion: desktopProtocolVersion,
      });
      return processingTasksResponseSchema.parse(response).tasks;
    },
    async importAudio() {
      const response = await bridge.invoke(ipcChannels.importAudio, {});
      return importAudioResponseSchema.parse(response);
    },
    async preflightCapture(
      options: Parameters<Voice2TextDesktopApi["preflightCapture"]>[0],
    ) {
      const payload = capturePreflightRequestSchema.parse(options);
      return capturePreflightSchema.parse(
        await bridge.invoke(ipcChannels.capturePreflight, payload),
      );
    },
    async startCapture(
      options: Parameters<Voice2TextDesktopApi["startCapture"]>[0],
    ) {
      const payload = captureStartRequestSchema.parse(options);
      return captureSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.captureStart, payload),
      );
    },
    async controlCapture(
      options: Parameters<Voice2TextDesktopApi["controlCapture"]>[0],
    ) {
      const payload = captureControlRequestSchema.parse(options);
      return captureSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.captureControl, payload),
      );
    },
    async listCaptureRecoveries() {
      return captureSnapshotSchema
        .array()
        .max(256)
        .parse(await bridge.invoke(ipcChannels.captureRecoveryList, {}));
    },
    async actOnCaptureRecovery(
      options: Parameters<Voice2TextDesktopApi["actOnCaptureRecovery"]>[0],
    ) {
      const payload = captureRecoveryActionRequestSchema.parse(options);
      const response = await bridge.invoke(
        ipcChannels.captureRecoveryAction,
        payload,
      );
      return response === null ? null : captureSnapshotSchema.parse(response);
    },
    async startMicrophoneTest(
      options: Parameters<Voice2TextDesktopApi["startMicrophoneTest"]>[0],
    ) {
      return microphoneTestSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.microphoneTestStart,
          microphoneTestStartRequestSchema.parse(options),
        ),
      );
    },
    async getMicrophoneTestSnapshot(testId: string) {
      return microphoneTestSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.microphoneTestSnapshot,
          microphoneTestControlRequestSchema.parse({ testId }),
        ),
      );
    },
    async finishMicrophoneTest(testId: string) {
      return microphoneTestSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.microphoneTestFinish,
          microphoneTestControlRequestSchema.parse({ testId }),
        ),
      );
    },
    async cancelMicrophoneTest(testId: string) {
      return microphoneTestSnapshotSchema.parse(
        await bridge.invoke(
          ipcChannels.microphoneTestCancel,
          microphoneTestControlRequestSchema.parse({ testId }),
        ),
      );
    },
    async openMicrophoneSettings() {
      return microphoneSettingsOpenResultSchema.parse(
        await bridge.invoke(
          ipcChannels.microphoneSettingsOpen,
          microphoneSettingsOpenRequestSchema.parse({}),
        ),
      );
    },
    async getCaptionSnapshot(
      options: Parameters<Voice2TextDesktopApi["getCaptionSnapshot"]>[0],
    ) {
      const payload = captionSnapshotRequestSchema.parse(options);
      const response = await bridge.invoke(
        ipcChannels.captionSnapshotGet,
        payload,
      );
      return response === null ? null : captionSnapshotSchema.parse(response);
    },
    async retryFormalTranscript(
      options: Parameters<Voice2TextDesktopApi["retryFormalTranscript"]>[0],
    ) {
      const payload = captionFormalRetryRequestSchema.parse(options);
      return captionSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.captionFormalRetry, payload),
      );
    },
    onCaptionSnapshot(listener: (snapshot: CaptionSnapshot) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(captionSnapshotSchema.parse(payload));
      };
      bridge.on(ipcChannels.captionSnapshotEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.captionSnapshotEvent, validatedListener);
      };
    },
    onOperationEvent(listener: (event: OperationEvent) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(operationEventSchema.parse(payload));
      };
      bridge.on(ipcChannels.operationEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.operationEvent, validatedListener);
      };
    },
    async listAudios(query = "", limit = 200, offset = 0) {
      const payload = listAudiosRequestSchema.parse({ query, limit, offset });
      const response = await bridge.invoke(ipcChannels.audioList, payload);
      return listAudiosResponseSchema.parse(response).audios;
    },
    async openAudio(audioId: number) {
      const payload = openAudioRequestSchema.parse({ audioId });
      return openAudioResponseSchema.parse(
        await bridge.invoke(ipcChannels.audioOpen, payload),
      );
    },
    async searchTranscript(audioId: number, query: string, limit = 200) {
      const payload = searchTranscriptRequestSchema.parse({
        audioId,
        query,
        limit,
      });
      const response = await bridge.invoke(ipcChannels.audioSearch, payload);
      return searchTranscriptResponseSchema.parse(response).segments;
    },
    async editAudioSegment(
      command: Parameters<Voice2TextDesktopApi["editAudioSegment"]>[0],
    ) {
      const payload = editAudioSegmentRequestSchema.parse(command);
      return audioWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioEditSegment, payload),
      );
    },
    async undoAudioEdit(
      audioId: number,
      generationId: number,
      expectedRevision: number,
    ) {
      const payload = audioHistoryRequestSchema.parse({
        audioId,
        generationId,
        expectedRevision,
      });
      return audioWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioUndo, payload),
      );
    },
    async redoAudioEdit(
      audioId: number,
      generationId: number,
      expectedRevision: number,
    ) {
      const payload = audioHistoryRequestSchema.parse({
        audioId,
        generationId,
        expectedRevision,
      });
      return audioWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioRedo, payload),
      );
    },
    async renameAudioSpeaker(
      command: Parameters<Voice2TextDesktopApi["renameAudioSpeaker"]>[0],
    ) {
      const payload = renameAudioSpeakerRequestSchema.parse(command);
      return audioWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioRenameSpeaker, payload),
      );
    },
    async mergeAudioSpeakers(
      command: Parameters<Voice2TextDesktopApi["mergeAudioSpeakers"]>[0],
    ) {
      const payload = mergeAudioSpeakersRequestSchema.parse(command);
      return audioWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioMergeSpeakers, payload),
      );
    },
    async assignAudioSpeaker(
      command: Parameters<Voice2TextDesktopApi["assignAudioSpeaker"]>[0],
    ) {
      const payload = assignAudioSpeakerRequestSchema.parse(command);
      return audioWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioAssignSpeaker, payload),
      );
    },
    async controlAudioPlayback(audioId: number, command: PlaybackAction) {
      const payload = controlAudioPlaybackRequestSchema.parse({
        audioId,
        command,
      });
      return audioPlaybackSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.audioPlayback, payload),
      );
    },
    async exportAudio(audioId: number, format: AudioExportFormat) {
      const payload = exportAudioRequestSchema.parse({ audioId, format });
      return exportAudioResponseSchema.parse(
        await bridge.invoke(ipcChannels.audioExport, payload),
      );
    },
  });
}
