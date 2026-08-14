export type SecretReadResult =
  | { state: "available"; secret: string }
  | { state: "missing" | "denied" | "corrupt" };

export interface DesktopSecretStorePort {
  read(providerId: string): Promise<SecretReadResult>;
  replace(providerId: string, secret: string): Promise<void>;
  delete(providerId: string): Promise<"deleted" | "missing" | "denied">;
  fileVaultStatus(): Promise<"enabled" | "disabled" | "unknown">;
}

export class UnavailableDesktopSecretStore implements DesktopSecretStorePort {
  async read(): Promise<SecretReadResult> {
    return { state: "denied" };
  }
  async replace(): Promise<void> {
    throw new Error(
      "KEYCHAIN_UNAVAILABLE: secure secret storage is unavailable",
    );
  }
  async delete(): Promise<"denied"> {
    return "denied";
  }
  async fileVaultStatus(): Promise<"unknown"> {
    return "unknown";
  }
}

export function assertProviderSecretInput(
  providerId: string,
  secret?: string,
): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(providerId)) {
    throw new TypeError("provider identity is invalid");
  }
  if (secret !== undefined) {
    const normalized = secret.trim();
    if (normalized.length === 0 || normalized.length > 4_096) {
      throw new TypeError("provider secret length is invalid");
    }
  }
}
