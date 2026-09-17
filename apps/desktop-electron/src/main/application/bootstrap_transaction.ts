import type {
  ApplicationSnapshot,
  BootstrapAction,
} from "../../shared/contracts";

type BlockedProfile = Extract<
  ApplicationSnapshot["profile"],
  { phase: "blocked" }
>;

export class BootstrapActionRejectedError extends Error {
  constructor(message = "bootstrap action is not available") {
    super(message);
    this.name = "BootstrapActionRejectedError";
  }
}

export function createBootstrapActionRunner(options: {
  getSnapshot: () => ApplicationSnapshot;
  hasPublishedProfileResources: () => boolean;
  resetProfile: () => void;
  bootstrap: () => Promise<void>;
  restoreBlockedProfile: (profile: BlockedProfile) => void;
}): (action: BootstrapAction) => Promise<ApplicationSnapshot> {
  let active:
    | { action: BootstrapAction; promise: Promise<ApplicationSnapshot> }
    | undefined;

  return (action) => {
    if (active) {
      if (active.action === action) return active.promise;
      return Promise.reject(
        new BootstrapActionRejectedError(
          `bootstrap action ${active.action} is already running`,
        ),
      );
    }

    const operation = Promise.resolve().then(async () => {
      if (action === "recheck") {
        await options.bootstrap();
        return options.getSnapshot();
      }

      const snapshot = options.getSnapshot();
      const blockedProfile = snapshot.profile;
      if (
        blockedProfile.phase !== "blocked" ||
        blockedProfile.code !== "schema_invalid" ||
        options.hasPublishedProfileResources()
      ) {
        throw new BootstrapActionRejectedError();
      }

      try {
        options.resetProfile();
        await options.bootstrap();
        const freshSnapshot = options.getSnapshot();
        if (freshSnapshot.profile.phase !== "ready") {
          throw new Error("profile reset did not become ready");
        }
        return freshSnapshot;
      } catch (error) {
        if (options.getSnapshot().profile.phase !== "blocked") {
          options.restoreBlockedProfile(blockedProfile);
        }
        throw error;
      }
    });
    const promise = operation.finally(() => {
      if (active?.promise === promise) active = undefined;
    });
    active = { action, promise };
    return promise;
  };
}

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
