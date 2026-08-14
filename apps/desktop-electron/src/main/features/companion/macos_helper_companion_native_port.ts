import { z } from "zod";

import type { MacOSNativeHelperSession } from "../importing/macos_native_helper_client";

const credentialReceiptSchema = z.discriminatedUnion("state", [
  z
    .object({
      schemaVersion: z.literal(1),
      state: z.literal("available"),
      credentialBase64: z.string().length(44),
    })
    .strict(),
  ...(["missing", "denied", "corrupt", "stored", "deleted"] as const).map(
    (state) =>
      z
        .object({ schemaVersion: z.literal(1), state: z.literal(state) })
        .strict(),
  ),
]);
const discoveryBaseReceipt = {
  schemaVersion: z.literal(1),
  serviceType: z.literal("_voice2text-media._tcp."),
};
const discoveryReceiptSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...discoveryBaseReceipt,
      state: z.literal("registered"),
      port: z.number().int().min(1).max(65_535),
      registeredName: z.string().min(1).max(63),
      manualFallbackAvailable: z.literal(false),
    })
    .strict(),
  ...(["permission-denied", "permission-pending", "unavailable"] as const).map(
    (state) =>
      z
        .object({
          ...discoveryBaseReceipt,
          state: z.literal(state),
          port: z.number().int().min(1).max(65_535),
          registeredName: z.null(),
          manualFallbackAvailable: z.literal(true),
        })
        .strict(),
  ),
  z
    .object({
      ...discoveryBaseReceipt,
      state: z.literal("stopped"),
      port: z.null(),
      registeredName: z.null(),
      manualFallbackAvailable: z.literal(true),
    })
    .strict(),
]);

export type CompanionCredentialKey =
  { kind: "identity-seed" } | { kind: "peer-shared"; peerDeviceId: string };

export type CompanionCredentialRead =
  | { state: "available"; credential: Uint8Array }
  | { state: "missing" | "denied" | "corrupt" };

export interface CompanionDiscoveryRequest {
  port: number;
  deviceId: string;
  deviceName: string;
  fingerprint: string;
}

export type CompanionDiscoveryReceipt = z.infer<typeof discoveryReceiptSchema>;

export class MacOSHelperCompanionNativePort {
  constructor(private readonly session: MacOSNativeHelperSession) {}

  async readCredential(
    key: CompanionCredentialKey,
  ): Promise<CompanionCredentialRead> {
    const response = await this.session.invokeRaw({
      command: "companion-credential-read",
      request: credentialRequest(key),
    });
    const receipt = credentialReceiptSchema.parse(response.companionCredential);
    if (receipt.state !== "available") {
      if (
        receipt.state !== "missing" &&
        receipt.state !== "denied" &&
        receipt.state !== "corrupt"
      ) {
        throw new Error("companion credential read state is invalid");
      }
      return { state: receipt.state };
    }
    return {
      state: "available",
      credential: decodeCredential(receipt.credentialBase64),
    };
  }

  async replaceCredential(
    key: CompanionCredentialKey,
    credential: Uint8Array,
  ): Promise<"stored"> {
    assertCredential(credential);
    const response = await this.session.invokeRaw({
      command: "companion-credential-replace",
      request: {
        ...credentialRequest(key),
        credentialBase64: Buffer.from(credential).toString("base64"),
      },
    });
    const receipt = credentialReceiptSchema.parse(response.companionCredential);
    if (receipt.state !== "stored") {
      throw new Error("companion credential replace failed");
    }
    return "stored";
  }

  async deleteCredential(
    key: CompanionCredentialKey,
  ): Promise<"deleted" | "missing" | "denied"> {
    const response = await this.session.invokeRaw({
      command: "companion-credential-delete",
      request: credentialRequest(key),
    });
    const receipt = credentialReceiptSchema.parse(response.companionCredential);
    if (
      receipt.state !== "deleted" &&
      receipt.state !== "missing" &&
      receipt.state !== "denied"
    ) {
      throw new Error("companion credential delete state is invalid");
    }
    return receipt.state;
  }

  async registerDiscovery(
    request: CompanionDiscoveryRequest,
  ): Promise<CompanionDiscoveryReceipt> {
    assertDiscoveryRequest(request);
    const response = await this.session.invokeRaw({
      command: "companion-discovery-register",
      request: { userInitiated: true, ...request },
    });
    return discoveryReceiptSchema.parse(response.companionDiscovery);
  }

  async unregisterDiscovery(): Promise<CompanionDiscoveryReceipt> {
    const response = await this.session.invokeRaw({
      command: "companion-discovery-unregister",
    });
    return discoveryReceiptSchema.parse(response.companionDiscovery);
  }

  async discoveryStatus(): Promise<CompanionDiscoveryReceipt> {
    const response = await this.session.invokeRaw({
      command: "companion-discovery-status",
    });
    return discoveryReceiptSchema.parse(response.companionDiscovery);
  }
}

function credentialRequest(
  key: CompanionCredentialKey,
): Record<string, string> {
  if (key.kind === "identity-seed") return { kind: key.kind };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key.peerDeviceId)) {
    throw new TypeError("companion peer identifier is invalid");
  }
  return { kind: key.kind, peerDeviceId: key.peerDeviceId };
}

function assertCredential(value: Uint8Array): void {
  if (value.byteLength !== 32) {
    throw new TypeError("companion credential must contain exactly 32 bytes");
  }
}

function decodeCredential(encoded: string): Uint8Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64") !== encoded) {
    throw new Error("companion credential encoding is invalid");
  }
  return Uint8Array.from(bytes);
}

function assertDiscoveryRequest(request: CompanionDiscoveryRequest): void {
  if (
    !Number.isSafeInteger(request.port) ||
    request.port < 1 ||
    request.port > 65_535 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(request.deviceId) ||
    request.deviceName.trim().length === 0 ||
    Buffer.byteLength(request.deviceName, "utf8") > 63 ||
    hasAsciiControlCharacter(request.deviceName) ||
    !/^[A-Z2-7]{20,64}$/.test(request.fingerprint)
  ) {
    throw new TypeError("companion discovery request is invalid");
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint < 0x20) return true;
  }
  return false;
}
