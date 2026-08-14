import { describe, expect, it, vi } from "vitest";

import { MacOSHelperSecretStore } from "../../src/main/features/secrets/macos_helper_secret_store";
import type { MacOSNativeHelperSession } from "../../src/main/features/importing/macos_native_helper_client";

describe("U10 private Keychain helper adapter", () => {
  it("uses only allowlisted private helper commands and never returns a replaced secret", async () => {
    const invokeRaw = vi
      .fn()
      .mockResolvedValueOnce({ secret: { schemaVersion: 1, state: "stored" } })
      .mockResolvedValueOnce({
        secret: { schemaVersion: 1, state: "available", secret: "key" },
      })
      .mockResolvedValueOnce({ secret: { schemaVersion: 1, state: "deleted" } })
      .mockResolvedValueOnce({
        security: {
          schemaVersion: 1,
          kind: "device-security",
          capability: "filevault",
          state: "enabled",
          applicationLayerEncryption: "not-claimed",
        },
      });
    const store = new MacOSHelperSecretStore({
      invokeRaw,
    } as unknown as MacOSNativeHelperSession);

    expect(await store.replace("deepseek", " key ")).toBeUndefined();
    expect(await store.read("deepseek")).toEqual({
      state: "available",
      secret: "key",
    });
    expect(await store.delete("deepseek")).toBe("deleted");
    expect(await store.fileVaultStatus()).toBe("enabled");
    expect(invokeRaw.mock.calls).toEqual([
      [
        {
          command: "secret-replace",
          request: { providerId: "deepseek", secret: "key" },
        },
      ],
      [{ command: "secret-read", request: { providerId: "deepseek" } }],
      [{ command: "secret-delete", request: { providerId: "deepseek" } }],
      [{ command: "filevault-status" }],
    ]);
  });

  it("maps denied/corrupt reads to non-secret settings truth", async () => {
    const denied = new MacOSHelperSecretStore({
      invokeRaw: vi.fn(async () => {
        throw new Error("KEYCHAIN_ACCESS_DENIED: unavailable");
      }),
    } as unknown as MacOSNativeHelperSession);
    const corrupt = new MacOSHelperSecretStore({
      invokeRaw: vi.fn(async () => ({
        secret: { schemaVersion: 1, state: "corrupt" },
      })),
    } as unknown as MacOSNativeHelperSession);

    expect(await denied.read("deepseek")).toEqual({ state: "denied" });
    expect(await corrupt.read("deepseek")).toEqual({ state: "corrupt" });
  });
});
