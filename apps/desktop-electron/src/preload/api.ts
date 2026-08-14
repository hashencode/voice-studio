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
