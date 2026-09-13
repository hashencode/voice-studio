import { AiProviderFailure } from "../domain/audio-intelligence/provider_security";
import { ModelBusyError } from "../resources/model_lease_coordinator";
import { WorkspaceConflictError } from "../storage/repositories/audio_workspace_repository";
import { CompanionTransferFailure } from "../storage/repositories/transfer_repository";
import type {
  DesktopFailureAdapter,
  DesktopFailureAdapterRegistry,
} from "./desktop_ipc";

const adapters: readonly DesktopFailureAdapter[] = [
  (error) =>
    error instanceof ModelBusyError
      ? {
          errorKind: "model-busy",
          failure: {
            domain: "local-model",
            code: error.code,
            retryable: true,
            fallback: "try-again",
          },
        }
      : null,
  (error) =>
    error instanceof WorkspaceConflictError
      ? {
          errorKind: "workspace-conflict",
          failure: {
            domain: "audio-workspace",
            code: error.code,
            retryable: true,
            fallback: "reload",
          },
        }
      : null,
  (error, context) => {
    if (!(error instanceof AiProviderFailure)) return null;
    const retryable = isRetryableAiFailure(error.code);
    return {
      errorKind: "ai-provider",
      failure: {
        domain: "ai-provider",
        code: error.code,
        retryable,
        fallback: retryable ? "try-again" : "continue",
        ...(context.mutation
          ? {
              completionCertainty: "unknown" as const,
              dataDurability: "unchanged" as const,
            }
          : {}),
      },
    };
  },
  (error, context) => {
    if (!(error instanceof CompanionTransferFailure)) return null;
    return {
      errorKind: "companion-transfer",
      failure: {
        domain: "companion-transfer",
        code: error.code,
        retryable: error.code !== "COMPANION_RECEIPT_MISMATCH",
        fallback:
          error.code === "COMPANION_RECEIPT_MISMATCH"
            ? "continue"
            : "try-again",
        ...(context.mutation
          ? {
              completionCertainty: "unknown" as const,
              dataDurability: "unknown" as const,
            }
          : {}),
      },
    };
  },
];

export function createDesktopFailureAdapterRegistry(): DesktopFailureAdapterRegistry {
  return Object.freeze([...adapters]);
}

function isRetryableAiFailure(code: AiProviderFailure["code"]): boolean {
  return (
    code === "AI_RATE_LIMITED" ||
    code === "AI_SERVICE_UNAVAILABLE" ||
    code === "AI_NETWORK_UNAVAILABLE" ||
    code === "AI_PROCESS_INTERRUPTED"
  );
}
