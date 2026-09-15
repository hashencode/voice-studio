export async function runBootstrapTransaction(options: {
  isReady: () => boolean;
  initialize: () => Promise<void>;
  resetPartialInitialization: () => Promise<void>;
}): Promise<void> {
  if (options.isReady()) return;
  try {
    await options.initialize();
  } catch (error) {
    await options.resetPartialInitialization();
    throw error;
  }
}

export function publishReadyLibrary(options: {
  countAudios: () => number;
  completeBootstrap: () => void;
  setLibraryCount: (audioCount: number) => void;
}): void {
  const audioCount = options.countAudios();
  options.completeBootstrap();
  options.setLibraryCount(audioCount);
}

export function publishStartupCaptureReconciliation(options: {
  result: { projected: number; failed: number };
  countAudios: () => number;
  setLibraryCount: (audioCount: number) => void;
  recordFailure: () => void;
}): void {
  if (options.result.projected > 0) {
    options.setLibraryCount(options.countAudios());
  }
  if (options.result.failed > 0) options.recordFailure();
}
