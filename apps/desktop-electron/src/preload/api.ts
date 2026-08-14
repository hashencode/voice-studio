import {
  applicationSnapshotSchema,
  bootstrapActionSchema,
  cancelProcessingResponseSchema,
  retryProcessingResponseSchema,
  processingTasksResponseSchema,
  importMeetingResponseSchema,
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
  listMeetingsRequestSchema,
  listMeetingsResponseSchema,
  openMeetingRequestSchema,
  openMeetingResponseSchema,
  searchTranscriptRequestSchema,
  searchTranscriptResponseSchema,
  editMeetingSegmentRequestSchema,
  meetingHistoryRequestSchema,
  renameMeetingSpeakerRequestSchema,
  mergeMeetingSpeakersRequestSchema,
  assignMeetingSpeakerRequestSchema,
  controlMeetingPlaybackRequestSchema,
  meetingPlaybackSnapshotSchema,
  exportMeetingRequestSchema,
  exportMeetingResponseSchema,
  meetingWorkspaceSnapshotSchema,
  type MeetingExportFormat,
  type PlaybackAction,
  capturePreflightRequestSchema,
  captureStartRequestSchema,
  captureControlRequestSchema,
  captureRecoveryActionRequestSchema,
  capturePreflightSchema,
  captureSnapshotSchema,
  captionSnapshotRequestSchema,
  captionFormalRetryRequestSchema,
  captionSnapshotSchema,
  type CaptionSnapshot,
  getAiSettingsRequestSchema,
  saveAiSettingsRequestSchema,
  replaceAiProviderSecretRequestSchema,
  deleteAiProviderSecretRequestSchema,
  prepareMeetingAiRequestSchema,
  getMeetingAiSnapshotRequestSchema,
  generateMeetingAiRequestSchema,
  retryMeetingAiRequestSchema,
  aiSettingsSnapshotSchema,
  meetingAiConsentPreviewSchema,
  meetingAiSnapshotSchema,
  type MeetingAiSnapshot,
  companionSnapshotRequestSchema,
  companionOptInRequestSchema,
  companionPairingInviteRequestSchema,
  companionPeerRevokeRequestSchema,
  companionTransferCancelRequestSchema,
  companionTransferRetryRequestSchema,
  companionSnapshotSchema,
  type CompanionSnapshot,
} from "../shared/contracts";

export interface PreloadIpcBridge {
  invoke(channel: string, payload: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): void;
  off(channel: string, listener: (payload: unknown) => void): void;
}

export function createDesktopApi(
  bridge: PreloadIpcBridge,
): Voice2TextDesktopApi {
  return Object.freeze({
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
    async saveAiSettings(
      options: Parameters<Voice2TextDesktopApi["saveAiSettings"]>[0],
    ) {
      const payload = saveAiSettingsRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiSettingsSave, payload),
      );
    },
    async replaceAiProviderSecret(
      options: Parameters<Voice2TextDesktopApi["replaceAiProviderSecret"]>[0],
    ) {
      const payload = replaceAiProviderSecretRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiSecretReplace, payload),
      );
    },
    async deleteAiProviderSecret(
      options: Parameters<Voice2TextDesktopApi["deleteAiProviderSecret"]>[0],
    ) {
      const payload = deleteAiProviderSecretRequestSchema.parse(options);
      return aiSettingsSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.aiSecretDelete, payload),
      );
    },
    async prepareMeetingAi(
      options: Parameters<Voice2TextDesktopApi["prepareMeetingAi"]>[0],
    ) {
      const payload = prepareMeetingAiRequestSchema.parse(options);
      return meetingAiConsentPreviewSchema.parse(
        await bridge.invoke(ipcChannels.meetingAiPrepare, payload),
      );
    },
    async getMeetingAiSnapshot(
      options: Parameters<Voice2TextDesktopApi["getMeetingAiSnapshot"]>[0],
    ) {
      const payload = getMeetingAiSnapshotRequestSchema.parse(options);
      const response = await bridge.invoke(
        ipcChannels.meetingAiSnapshotGet,
        payload,
      );
      return response === null ? null : meetingAiSnapshotSchema.parse(response);
    },
    async generateMeetingAi(
      options: Parameters<Voice2TextDesktopApi["generateMeetingAi"]>[0],
    ) {
      const payload = generateMeetingAiRequestSchema.parse(options);
      return meetingAiSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingAiGenerate, payload),
      );
    },
    async retryMeetingAi(
      options: Parameters<Voice2TextDesktopApi["retryMeetingAi"]>[0],
    ) {
      const payload = retryMeetingAiRequestSchema.parse(options);
      return meetingAiSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingAiRetry, payload),
      );
    },
    onMeetingAiSnapshot(listener: (snapshot: MeetingAiSnapshot) => void) {
      let subscribed = true;
      const validatedListener = (payload: unknown) => {
        listener(meetingAiSnapshotSchema.parse(payload));
      };
      bridge.on(ipcChannels.meetingAiSnapshotEvent, validatedListener);
      return () => {
        if (!subscribed) return;
        subscribed = false;
        bridge.off(ipcChannels.meetingAiSnapshotEvent, validatedListener);
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
    async listProcessingTasks() {
      const response = await bridge.invoke(ipcChannels.processingTasks, {
        expectedProtocolVersion: desktopProtocolVersion,
      });
      return processingTasksResponseSchema.parse(response).tasks;
    },
    async importMeeting() {
      const response = await bridge.invoke(ipcChannels.importMeeting, {});
      return importMeetingResponseSchema.parse(response);
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
    async listMeetings(query = "", limit = 200, offset = 0) {
      const payload = listMeetingsRequestSchema.parse({ query, limit, offset });
      const response = await bridge.invoke(ipcChannels.meetingList, payload);
      return listMeetingsResponseSchema.parse(response).meetings;
    },
    async openMeeting(meetingId: number) {
      const payload = openMeetingRequestSchema.parse({ meetingId });
      return openMeetingResponseSchema.parse(
        await bridge.invoke(ipcChannels.meetingOpen, payload),
      );
    },
    async searchTranscript(meetingId: number, query: string, limit = 200) {
      const payload = searchTranscriptRequestSchema.parse({
        meetingId,
        query,
        limit,
      });
      const response = await bridge.invoke(ipcChannels.meetingSearch, payload);
      return searchTranscriptResponseSchema.parse(response).segments;
    },
    async editMeetingSegment(
      command: Parameters<Voice2TextDesktopApi["editMeetingSegment"]>[0],
    ) {
      const payload = editMeetingSegmentRequestSchema.parse(command);
      return meetingWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingEditSegment, payload),
      );
    },
    async undoMeetingEdit(
      meetingId: number,
      generationId: number,
      expectedRevision: number,
    ) {
      const payload = meetingHistoryRequestSchema.parse({
        meetingId,
        generationId,
        expectedRevision,
      });
      return meetingWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingUndo, payload),
      );
    },
    async redoMeetingEdit(
      meetingId: number,
      generationId: number,
      expectedRevision: number,
    ) {
      const payload = meetingHistoryRequestSchema.parse({
        meetingId,
        generationId,
        expectedRevision,
      });
      return meetingWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingRedo, payload),
      );
    },
    async renameMeetingSpeaker(
      command: Parameters<Voice2TextDesktopApi["renameMeetingSpeaker"]>[0],
    ) {
      const payload = renameMeetingSpeakerRequestSchema.parse(command);
      return meetingWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingRenameSpeaker, payload),
      );
    },
    async mergeMeetingSpeakers(
      command: Parameters<Voice2TextDesktopApi["mergeMeetingSpeakers"]>[0],
    ) {
      const payload = mergeMeetingSpeakersRequestSchema.parse(command);
      return meetingWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingMergeSpeakers, payload),
      );
    },
    async assignMeetingSpeaker(
      command: Parameters<Voice2TextDesktopApi["assignMeetingSpeaker"]>[0],
    ) {
      const payload = assignMeetingSpeakerRequestSchema.parse(command);
      return meetingWorkspaceSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingAssignSpeaker, payload),
      );
    },
    async controlMeetingPlayback(meetingId: number, command: PlaybackAction) {
      const payload = controlMeetingPlaybackRequestSchema.parse({
        meetingId,
        command,
      });
      return meetingPlaybackSnapshotSchema.parse(
        await bridge.invoke(ipcChannels.meetingPlayback, payload),
      );
    },
    async exportMeeting(meetingId: number, format: MeetingExportFormat) {
      const payload = exportMeetingRequestSchema.parse({ meetingId, format });
      return exportMeetingResponseSchema.parse(
        await bridge.invoke(ipcChannels.meetingExport, payload),
      );
    },
  });
}
