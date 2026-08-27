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
