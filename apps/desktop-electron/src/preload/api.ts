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
  });
}
