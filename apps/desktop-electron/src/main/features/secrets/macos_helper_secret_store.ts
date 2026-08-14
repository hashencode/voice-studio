import { z } from "zod";

import type { MacOSNativeHelperSession } from "../importing/macos_native_helper_client";
import {
  assertProviderSecretInput,
  type DesktopSecretStorePort,
  type SecretReadResult,
} from "./secret_store_port";

const readReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["available", "missing", "denied", "corrupt"]),
    secret: z.string().min(1).max(4_096).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === "available") !== (value.secret !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "secret receipt state mismatch",
      });
    }
  });

const replaceReceiptSchema = z
  .object({ schemaVersion: z.literal(1), state: z.literal("stored") })
  .strict();
const deleteReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["deleted", "missing", "denied"]),
  })
  .strict();
const fileVaultReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("device-security"),
    capability: z.literal("filevault"),
    state: z.enum(["enabled", "disabled", "unknown"]),
    applicationLayerEncryption: z.literal("not-claimed"),
  })
  .strict();

export class MacOSHelperSecretStore implements DesktopSecretStorePort {
  constructor(private readonly session: MacOSNativeHelperSession) {}

  async read(providerId: string): Promise<SecretReadResult> {
    assertProviderSecretInput(providerId);
    try {
      const response = await this.session.invokeRaw({
        command: "secret-read",
        request: { providerId },
      });
      const receipt = readReceiptSchema.parse(response.secret);
      return receipt.state === "available"
        ? { state: "available", secret: receipt.secret! }
        : { state: receipt.state };
    } catch (error) {
      return { state: mapReadFailure(error) };
    }
  }

  async replace(providerId: string, secret: string): Promise<void> {
    assertProviderSecretInput(providerId, secret);
    const response = await this.session.invokeRaw({
      command: "secret-replace",
      request: { providerId, secret: secret.trim() },
    });
    replaceReceiptSchema.parse(response.secret);
  }

  async delete(providerId: string): Promise<"deleted" | "missing" | "denied"> {
    assertProviderSecretInput(providerId);
    try {
      const response = await this.session.invokeRaw({
        command: "secret-delete",
        request: { providerId },
      });
      return deleteReceiptSchema.parse(response.secret).state;
    } catch (error) {
      if (
        isHelperCode(error, "KEYCHAIN_ACCESS_DENIED") ||
        isHelperCode(error, "KEYCHAIN_UNAVAILABLE")
      ) {
        return "denied";
      }
      throw error;
    }
  }

  async fileVaultStatus(): Promise<"enabled" | "disabled" | "unknown"> {
    try {
      const response = await this.session.invokeRaw({
        command: "filevault-status",
      });
      return fileVaultReceiptSchema.parse(response.security).state;
    } catch {
      return "unknown";
    }
  }
}

function mapReadFailure(error: unknown): "denied" | "corrupt" {
  return isHelperCode(error, "KEYCHAIN_ACCESS_DENIED") ||
    isHelperCode(error, "KEYCHAIN_UNAVAILABLE")
    ? "denied"
    : "corrupt";
}

function isHelperCode(error: unknown, code: string): boolean {
  return error instanceof Error && error.message.startsWith(`${code}:`);
}
