import {
  cancelProcessingResponseSchema,
  desktopProtocolVersion,
  ipcChannels,
  operationEventSchema,
  workerHealthResponseSchema,
  type OperationEvent,
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
