import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto";

import type {
  CompanionCredentialRequest,
  CompanionDiscoveryPort,
  CompanionIdentityPort,
  CompanionNativeSecurityPort,
} from "../../domain/companion/companion_service";
import { companionFingerprint } from "../../domain/companion/companion_crypto";
import {
  MacOSNativeHelperClient,
  type MacOSNativeHelperSession,
} from "../importing/macos_native_helper_client";
import { MacOSHelperCompanionNativePort } from "./macos_helper_companion_native_port";

export class MacOSCompanionNativeAdapter
  implements
    CompanionNativeSecurityPort,
    CompanionDiscoveryPort,
    CompanionIdentityPort
{
  private session: MacOSNativeHelperSession | null = null;
  private port: MacOSHelperCompanionNativePort | null = null;
  private identityCache: {
    deviceId: string;
    deviceName: string;
    fingerprint: string;
    publicKey: Buffer;
    seed: Buffer;
  } | null = null;

  constructor(
    private readonly helper: MacOSNativeHelperClient,
    private readonly deviceName = "Voice2Text Mac",
  ) {}

  async readCredential(request: CompanionCredentialRequest) {
    return await (await this.requirePort()).readCredential(request);
  }

  async replaceCredential(
    request: CompanionCredentialRequest,
    credential: Uint8Array,
  ) {
    const state = await (
      await this.requirePort()
    ).replaceCredential(request, credential);
    if (state !== "stored")
      throw new Error("companion credential was not stored");
    return state;
  }

  async deleteCredential(request: CompanionCredentialRequest) {
    return await (await this.requirePort()).deleteCredential(request);
  }

  async register(request: {
    userInitiated: true;
    port: number;
    deviceId: string;
    deviceName: string;
    fingerprint: string;
  }) {
    return normalizeDiscovery(
      await (await this.requirePort()).registerDiscovery(request),
    );
  }

  async status() {
    return normalizeDiscovery(
      await (await this.requirePort()).discoveryStatus(),
    );
  }

  async unregister(): Promise<void> {
    if (!this.session) return;
    await this.port?.unregisterDiscovery();
  }

  async ensureIdentity() {
    if (this.identityCache) return publicIdentity(this.identityCache);
    const receipt = await this.readCredential({ kind: "identity-seed" });
    let seed: Buffer;
    if (receipt.state === "available") {
      seed = Buffer.from(receipt.credential);
      receipt.credential.fill(0);
    } else if (receipt.state === "missing") {
      seed = randomBytes(32);
      await this.replaceCredential({ kind: "identity-seed" }, seed);
    } else {
      throw Object.assign(new Error("companion identity is unavailable"), {
        code: `COMPANION_IDENTITY_${receipt.state.toUpperCase()}`,
      });
    }
    const publicKeyDer = createPublicKey(ed25519PrivateKey(seed)).export({
      format: "der",
      type: "spki",
    });
    const publicKey = Buffer.from(publicKeyDer.subarray(-32));
    const fingerprint = companionFingerprint(publicKey);
    this.identityCache = {
      deviceId: `desktop-${fingerprint.toLowerCase().slice(0, 20)}`,
      deviceName: this.deviceName,
      fingerprint,
      publicKey,
      seed,
    };
    return publicIdentity(this.identityCache);
  }

  async identityPublicKey(): Promise<Buffer> {
    await this.ensureIdentity();
    return Buffer.from(this.identityCache!.publicKey);
  }

  async signBytes(payload: Uint8Array): Promise<Buffer> {
    await this.ensureIdentity();
    return sign(
      null,
      Buffer.from(payload),
      ed25519PrivateKey(this.identityCache!.seed),
    );
  }

  async signReceipt(
    unsignedReceipt: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const canonical = Buffer.from(JSON.stringify(unsignedReceipt));
    return (await this.signBytes(canonical)).toString("base64");
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    const port = this.port;
    this.port = null;
    try {
      if (port) await port.unregisterDiscovery();
    } finally {
      await session?.close();
      this.identityCache?.seed.fill(0);
      this.identityCache = null;
    }
  }

  private async requireSession(): Promise<MacOSNativeHelperSession> {
    if (this.session) return this.session;
    this.session = await this.helper.openSession({
      exactSourcePaths: [],
      destinationRoots: [],
      companionDiscovery: true,
    });
    return this.session;
  }

  private async requirePort(): Promise<MacOSHelperCompanionNativePort> {
    if (this.port) return this.port;
    this.port = new MacOSHelperCompanionNativePort(await this.requireSession());
    return this.port;
  }
}

function ed25519PrivateKey(seed: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      seed,
    ]),
    format: "der",
    type: "pkcs8",
  });
}

function publicIdentity(identity: {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
}) {
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    fingerprint: identity.fingerprint,
  };
}

function normalizeDiscovery(receipt: {
  state:
    | "registered"
    | "permission-denied"
    | "permission-pending"
    | "unavailable"
    | "stopped";
  manualFallbackAvailable: boolean;
  registeredName: string | null;
}): {
  state:
    "registered" | "permission-denied" | "permission-pending" | "unavailable";
  manualFallbackAvailable: boolean;
  systemName?: string;
} {
  if (receipt.state === "stopped") {
    return {
      state: "unavailable" as const,
      manualFallbackAvailable: receipt.manualFallbackAvailable,
      systemName: receipt.registeredName ?? undefined,
    };
  }
  return {
    state: receipt.state as
      "registered" | "permission-denied" | "permission-pending" | "unavailable",
    manualFallbackAvailable: receipt.manualFallbackAvailable,
    systemName: receipt.registeredName ?? undefined,
  };
}
