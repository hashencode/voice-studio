import type { AudioProfilePaths } from "../../profile/profile_paths";
import type { DesktopDomainService } from "../desktop_domain_service";
import {
  validateFormalMediaAuthority,
  type FormalCaptureMedia,
} from "../captions/formal_capture_media";

export interface CaptureLibraryProjectionReceipt {
  sessionId: string;
  audioId: number;
  inserted: boolean;
}

export type CaptureLibraryProjectionFailure =
  "invalid_authority" | "commit_failed";

export class CaptureLibraryProjectionError extends Error {
  constructor(readonly code: CaptureLibraryProjectionFailure) {
    super(
      code === "invalid_authority"
        ? "Capture media authority could not be verified"
        : "Capture media could not be added to the library",
    );
    this.name = "CaptureLibraryProjectionError";
  }
}

export class CaptureLibraryProjectionService {
  constructor(
    private readonly options: {
      profile: AudioProfilePaths;
      domain: DesktopDomainService;
      prepareMedia(sessionId: string): Promise<FormalCaptureMedia>;
    },
  ) {}

  async project(command: {
    sessionId: string;
    displayName: string;
  }): Promise<CaptureLibraryProjectionReceipt> {
    return (await this.projectWithMedia(command)).receipt;
  }

  async projectWithMedia(command: {
    sessionId: string;
    displayName: string;
  }): Promise<{
    receipt: CaptureLibraryProjectionReceipt;
    media: FormalCaptureMedia;
  }> {
    let media: FormalCaptureMedia;
    try {
      media = await this.options.prepareMedia(command.sessionId);
      await validateFormalMediaAuthority(this.options.profile, media);
    } catch {
      throw new CaptureLibraryProjectionError("invalid_authority");
    }
    try {
      const committed = this.options.domain.commitValidatedImport({
        captureSessionId: command.sessionId,
        displayName: command.displayName,
        ...media,
      });
      return {
        media,
        receipt: {
          sessionId: command.sessionId,
          audioId: committed.audio.id,
          inserted: committed.inserted,
        },
      };
    } catch {
      throw new CaptureLibraryProjectionError("commit_failed");
    }
  }
}
