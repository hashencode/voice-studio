import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { MacOSCompanionNativeAdapter } from "../../src/main/features/companion/macos_companion_native_adapter";
import { MacOSHelperCompanionNativePort } from "../../src/main/features/companion/macos_helper_companion_native_port";
import type {
  MacOSNativeHelperClient,
  MacOSNativeHelperSession,
} from "../../src/main/features/importing/macos_native_helper_client";

describe("U11 private companion native adapter", () => {
  it("uses fixed credential commands without exposing arbitrary Keychain accounts", async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const encoded = Buffer.from(bytes).toString("base64");
    const invokeRaw = vi
      .fn()
      .mockResolvedValueOnce({
        companionCredential: {
          schemaVersion: 1,
          state: "available",
          credentialBase64: encoded,
        },
      })
      .mockResolvedValueOnce({
        companionCredential: { schemaVersion: 1, state: "stored" },
      })
      .mockResolvedValueOnce({
        companionCredential: { schemaVersion: 1, state: "deleted" },
      });
    const port = new MacOSHelperCompanionNativePort({
      invokeRaw,
    } as unknown as MacOSNativeHelperSession);

    expect(await port.readCredential({ kind: "identity-seed" })).toEqual({
      state: "available",
      credential: bytes,
    });
    await expect(
      port.replaceCredential(
        { kind: "peer-shared", peerDeviceId: "android-01" },
        bytes,
      ),
    ).resolves.toBe("stored");
    await expect(
      port.deleteCredential({
        kind: "peer-shared",
        peerDeviceId: "android-01",
      }),
    ).resolves.toBe("deleted");

    expect(invokeRaw.mock.calls).toEqual([
      [
        {
          command: "companion-credential-read",
          request: { kind: "identity-seed" },
        },
      ],
      [
        {
          command: "companion-credential-replace",
          request: {
            kind: "peer-shared",
            peerDeviceId: "android-01",
            credentialBase64: encoded,
          },
        },
      ],
      [
        {
          command: "companion-credential-delete",
          request: { kind: "peer-shared", peerDeviceId: "android-01" },
        },
      ],
    ]);
  });

  it("uses user-initiated discovery frames and preserves manual fallback", async () => {
    const invokeRaw = vi
      .fn()
      .mockResolvedValueOnce({
        companionDiscovery: {
          schemaVersion: 1,
          state: "permission-pending",
          serviceType: "_voice2text-media._tcp.",
          port: 4242,
          registeredName: null,
          manualFallbackAvailable: true,
        },
      })
      .mockResolvedValueOnce({
        companionDiscovery: {
          schemaVersion: 1,
          state: "registered",
          serviceType: "_voice2text-media._tcp.",
          port: 4242,
          registeredName: "Voice2Text Mac (2)",
          manualFallbackAvailable: false,
        },
      })
      .mockResolvedValueOnce({
        companionDiscovery: {
          schemaVersion: 1,
          state: "stopped",
          serviceType: "_voice2text-media._tcp.",
          port: null,
          registeredName: null,
          manualFallbackAvailable: true,
        },
      });
    const port = new MacOSHelperCompanionNativePort({
      invokeRaw,
    } as unknown as MacOSNativeHelperSession);

    await expect(
      port.registerDiscovery({
        port: 4242,
        deviceId: "desktop-01",
        deviceName: "Voice2Text Mac",
        fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      }),
    ).resolves.toMatchObject({
      state: "permission-pending",
      manualFallbackAvailable: true,
    });
    await expect(port.discoveryStatus()).resolves.toMatchObject({
      state: "registered",
      registeredName: "Voice2Text Mac (2)",
    });
    await expect(port.unregisterDiscovery()).resolves.toMatchObject({
      state: "stopped",
    });

    expect(invokeRaw.mock.calls).toEqual([
      [
        {
          command: "companion-discovery-register",
          request: {
            userInitiated: true,
            port: 4242,
            deviceId: "desktop-01",
            deviceName: "Voice2Text Mac",
            fingerprint: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
          },
        },
      ],
      [{ command: "companion-discovery-status" }],
      [{ command: "companion-discovery-unregister" }],
    ]);
  });

  it("rejects inconsistent or secret-echoing helper receipts", async () => {
    const echoed = Buffer.alloc(32, 9).toString("base64");
    const invokeRaw = vi
      .fn()
      .mockResolvedValueOnce({
        companionCredential: { schemaVersion: 1, state: "available" },
      })
      .mockResolvedValueOnce({
        companionCredential: {
          schemaVersion: 1,
          state: "stored",
          credentialBase64: echoed,
        },
      })
      .mockResolvedValueOnce({
        companionDiscovery: {
          schemaVersion: 1,
          state: "registered",
          serviceType: "_voice2text-media._tcp.",
          port: null,
          registeredName: null,
          manualFallbackAvailable: true,
        },
      });
    const port = new MacOSHelperCompanionNativePort({
      invokeRaw,
    } as unknown as MacOSNativeHelperSession);

    await expect(
      port.readCredential({ kind: "identity-seed" }),
    ).rejects.toThrow();
    await expect(
      port.replaceCredential({ kind: "identity-seed" }, Buffer.alloc(32, 9)),
    ).rejects.toThrow();
    await expect(port.discoveryStatus()).rejects.toThrow();
  });

  it("derives the Dart-compatible Ed25519 identity and signs canonical receipts", async () => {
    const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const close = vi.fn().mockResolvedValue(undefined);
    const invokeRaw = vi.fn(async (command: Record<string, unknown>) => {
      if (command.command === "companion-credential-read") {
        return {
          companionCredential: {
            schemaVersion: 1,
            state: "available",
            credentialBase64: seed.toString("base64"),
          },
        };
      }
      if (command.command === "companion-discovery-unregister") {
        return {
          companionDiscovery: {
            schemaVersion: 1,
            state: "stopped",
            serviceType: "_voice2text-media._tcp.",
            port: null,
            registeredName: null,
            manualFallbackAvailable: true,
          },
        };
      }
      throw new Error("unexpected helper command");
    });
    const openSession = vi.fn().mockResolvedValue({ invokeRaw, close });
    const adapter = new MacOSCompanionNativeAdapter(
      { openSession } as unknown as MacOSNativeHelperClient,
      "Studio Mac",
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const identity = await adapter.ensureIdentity();
    expect(identity).toEqual({
      deviceId: "desktop-kzdvvj2umnduyauf35o3",
      deviceName: "Studio Mac",
      fingerprint: "KZDVVJ2UMNDUYAUF35O36K6KW462MUJV",
    });
    expect(JSON.stringify(identity)).not.toContain(seed.toString("base64"));
    expect(JSON.stringify(identity)).not.toContain(seed.toString("hex"));
    const identityPublicKey = await adapter.identityPublicKey();
    expect(identityPublicKey).toHaveLength(32);
    expect(identityPublicKey).toEqual(
      createPublicKey(
        createPrivateKey({
          key: Buffer.concat([
            Buffer.from("302e020100300506032b657004220420", "hex"),
            seed,
          ]),
          format: "der",
          type: "pkcs8",
        }),
      )
        .export({ format: "der", type: "spki" })
        .subarray(-32),
    );
    const pairingPayload = Buffer.from("signed pairing transcript", "utf8");
    expect(
      verify(
        null,
        pairingPayload,
        createPublicKey(
          createPrivateKey({
            key: Buffer.concat([
              Buffer.from("302e020100300506032b657004220420", "hex"),
              seed,
            ]),
            format: "der",
            type: "pkcs8",
          }),
        ),
        await adapter.signBytes(pairingPayload),
      ),
    ).toBe(true);

    const unsigned = {
      schema: "companion-media-transfer/v1",
      receiptId: "receipt-transfer-1",
      transferId: "transfer-1",
      wholeFileSha256: "a".repeat(64),
      sizeBytes: 8,
      desktopDeviceId: identity.deviceId,
      desktopDeviceName: identity.deviceName,
      desktopRecordingId: 99,
      committedAtMs: 2_000,
    };
    const signature = Buffer.from(
      await adapter.signReceipt(unsigned),
      "base64",
    );
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]),
      format: "der",
      type: "pkcs8",
    });
    expect(signature).toHaveLength(64);
    expect(
      verify(
        null,
        Buffer.from(JSON.stringify(unsigned)),
        createPublicKey(privateKey),
        signature,
      ),
    ).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();

    await adapter.close();
    expect(invokeRaw).toHaveBeenLastCalledWith({
      command: "companion-discovery-unregister",
    });
    expect(close).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
