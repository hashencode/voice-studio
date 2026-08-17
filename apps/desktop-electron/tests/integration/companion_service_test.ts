import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
  verify,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompanionService,
  selectPrivateLanAddress,
  type CompanionDiscoveryPort,
  type CompanionIdentityPort,
  type CompanionImportCommitPort,
  type CompanionNativeSecurityPort,
  type CompanionReceiverPort,
} from "../../src/main/domain/companion/companion_service";
import {
  canonicalCompanionPairingTranscript,
  companionFingerprint,
  generateCompanionX25519KeyPair,
  type CompanionPairingTranscriptValue,
} from "../../src/main/domain/companion/companion_crypto";
import { openAudioDatabase } from "../../src/main/storage/audio_database";
import { TransferRepository } from "../../src/main/storage/repositories/transfer_repository";

describe("U11 companion service lifecycle", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => database?.close());

  it("selects only a stable RFC1918 manual endpoint", () => {
    expect(
      selectPrivateLanAddress([
        "203.0.113.4",
        "100.64.0.2",
        "169.254.1.1",
        "127.0.0.1",
        "192.168.2.9",
        "10.0.0.8",
        "172.32.0.1",
        "172.16.4.3",
      ]),
    ).toBe("10.0.0.8");
    expect(
      selectPrivateLanAddress([
        "203.0.113.4",
        "100.64.0.2",
        "169.254.1.1",
        "127.0.0.1",
      ]),
    ).toBeNull();
  });

  it("starts only after opt-in and explicit retry recovers registration failure", async () => {
    const fixture = createFixture();
    database = fixture.database;
    expect(fixture.receiver.start).not.toHaveBeenCalled();
    fixture.receiver.start
      .mockRejectedValueOnce(
        Object.assign(new Error("offline"), { code: "OFFLINE" }),
      )
      .mockResolvedValueOnce({ port: 43123 });
    expect((await fixture.service.setOptIn(true)).discovery.state).toBe(
      "error",
    );
    expect((await fixture.service.setOptIn(true)).discovery.state).toBe(
      "ready",
    );
    expect(fixture.receiver.start).toHaveBeenCalledTimes(2);
  });

  it("restores a persisted opt-in receiver after restart", async () => {
    const fixture = createFixture();
    database = fixture.database;
    fixture.repository.setReceiverEnabled(true, 1);
    expect((await fixture.service.reconcileStartup()).discovery.state).toBe(
      "ready",
    );
    expect(fixture.receiver.start).toHaveBeenCalledOnce();
  });

  it("expires and cleans seven-day staging on the first disabled restart", async () => {
    const fixture = createFixture({
      nowMs: () => 8 * 24 * 60 * 60 * 1_000,
    });
    database = fixture.database;
    fixture.repository.pairPeer({
      deviceId: "mobile-expiry",
      displayName: "Old Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    const manifest = {
      schema: "companion-audio-transfer/v2" as const,
      transferId: "transfer-expired-first-restart",
      sourceAssetId: "mobile-recording-expired",
      displayName: "old.wav",
      sizeBytes: 8,
      wholeFileSha256: "a".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 1,
      createdAtMs: 1,
    };
    fixture.repository.beginTransfer(manifest, "mobile-expiry", 1);
    fixture.security.readCredential.mockResolvedValue({ state: "denied" });
    fixture.receiver.cleanupPendingStaging.mockImplementation(() => {
      const pending = fixture.repository.pendingStagingCleanup();
      for (const item of pending) {
        fixture.repository.markStagingCleanupComplete(
          item.transferId,
          8 * 24 * 60 * 60 * 1_000,
        );
      }
      return pending.length;
    });

    const snapshot = await fixture.service.reconcileStartup();

    expect(snapshot.optIn).toBe(false);
    expect(fixture.receiver.start).not.toHaveBeenCalled();
    expect(fixture.repository.getTransfer(manifest.transferId)).toMatchObject({
      state: "expired",
      stagingCleanupState: "complete",
    });
  });

  it("pairs only after the signed transcript verifies and never exposes the derived credential", async () => {
    const fixture = createFixture();
    database = fixture.database;
    await fixture.service.setOptIn(true);
    const invitation = fixture.service.createPairingInvite().pairingInvite!;
    const peer = pairingPeer();
    const resolved = await fixture.service.resolveInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      initiatorEphemeralPublicKey: peer.ephemeral.publicKey,
    });
    expect(resolved?.temporaryCredential).toHaveLength(32);
    expect(resolved?.responderEphemeralPublicKey.toString("base64")).toBe(
      invitation.responderEphemeralPublicKey,
    );
    const transcript = pairingTranscript(
      invitation,
      fixture.identityValue,
      peer,
    );

    const confirmation = await fixture.service.confirmInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      shortCode: invitation.shortCode,
      transcript,
      initiatorIdentityPublicKey: peer.identityPublicKey,
      initiatorSignature: sign(
        null,
        canonicalCompanionPairingTranscript(transcript),
        peer.identityPrivateKey,
      ),
    });

    expect(confirmation.responderIdentityPublicKey).toEqual(
      fixture.identityPublicKey,
    );
    expect(confirmation.responderSignature).toHaveLength(64);
    expect(
      verify(
        null,
        canonicalCompanionPairingTranscript(transcript),
        fixture.identityPair.publicKey,
        confirmation.responderSignature,
      ),
    ).toBe(true);
    expect(fixture.security.replaceCredential).not.toHaveBeenCalled();
    expect(fixture.repository.peer(peer.deviceId)).toBeNull();
    const replayedConfirmation = await fixture.service.confirmInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      shortCode: invitation.shortCode,
      transcript,
      initiatorIdentityPublicKey: peer.identityPublicKey,
      initiatorSignature: sign(
        null,
        canonicalCompanionPairingTranscript(transcript),
        peer.identityPrivateKey,
      ),
    });
    expect(replayedConfirmation).toEqual(confirmation);

    const transcriptHash = createHash("sha256")
      .update(canonicalCompanionPairingTranscript(transcript))
      .digest("hex");
    await fixture.service.commitInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      transcript,
      transcriptHash,
    });
    expect(fixture.security.replaceCredential).toHaveBeenCalledOnce();
    const persistedCredential = fixture.storedCredentials[0]!;
    expect(persistedCredential.equals(resolved!.temporaryCredential)).toBe(
      false,
    );
    expect(JSON.stringify(fixture.service.snapshot())).not.toContain(
      Buffer.from(persistedCredential ?? []).toString("base64"),
    );
    expect(fixture.repository.peer(peer.deviceId)).toMatchObject({
      deviceId: peer.deviceId,
      identityFingerprint: peer.fingerprint,
    });
    await fixture.service.commitInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      transcript,
      transcriptHash,
    });
    expect(fixture.security.replaceCredential).toHaveBeenCalledOnce();
    peer.ephemeral.destroy();
  });

  it("does not let an unauthenticated hello pin the invitation ephemeral key", async () => {
    const fixture = createFixture();
    database = fixture.database;
    await fixture.service.setOptIn(true);
    const invitation = fixture.service.createPairingInvite().pairingInvite!;
    const attackerEphemeral = generateCompanionX25519KeyPair();
    const legitimatePeer = pairingPeer();

    expect(
      await fixture.service.resolveInvite({
        pairingId: invitation.pairingId,
        deviceId: "attacker",
        deviceName: "Unknown",
        fingerprint: "A".repeat(32),
        initiatorEphemeralPublicKey: attackerEphemeral.publicKey,
      }),
    ).not.toBeNull();
    expect(
      await fixture.service.resolveInvite({
        pairingId: invitation.pairingId,
        deviceId: legitimatePeer.deviceId,
        deviceName: legitimatePeer.deviceName,
        fingerprint: legitimatePeer.fingerprint,
        initiatorEphemeralPublicKey: legitimatePeer.ephemeral.publicKey,
      }),
    ).not.toBeNull();

    attackerEphemeral.destroy();
    legitimatePeer.ephemeral.destroy();
  });

  it("signs the responder acknowledgement before persisting peer authority", async () => {
    const fixture = createFixture();
    database = fixture.database;
    await fixture.service.setOptIn(true);
    const invitation = fixture.service.createPairingInvite().pairingInvite!;
    const peer = pairingPeer();
    await fixture.service.resolveInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      initiatorEphemeralPublicKey: peer.ephemeral.publicKey,
    });
    const transcript = pairingTranscript(
      invitation,
      fixture.identityValue,
      peer,
    );
    fixture.identity.signBytes.mockRejectedValueOnce(
      new Error("simulated signer failure"),
    );

    await expect(
      fixture.service.confirmInvite({
        pairingId: invitation.pairingId,
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        fingerprint: peer.fingerprint,
        shortCode: invitation.shortCode,
        transcript,
        initiatorIdentityPublicKey: peer.identityPublicKey,
        initiatorSignature: sign(
          null,
          canonicalCompanionPairingTranscript(transcript),
          peer.identityPrivateKey,
        ),
      }),
    ).rejects.toThrow("simulated signer failure");
    expect(fixture.security.replaceCredential).not.toHaveBeenCalled();
    expect(fixture.repository.peer(peer.deviceId)).toBeNull();
    peer.ephemeral.destroy();
  });

  it("locks a pairing invitation after five wrong short codes", async () => {
    const fixture = createFixture();
    database = fixture.database;
    await fixture.service.setOptIn(true);
    const invitation = fixture.service.createPairingInvite().pairingInvite!;
    const peer = pairingPeer();
    await fixture.service.resolveInvite({
      pairingId: invitation.pairingId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      fingerprint: peer.fingerprint,
      initiatorEphemeralPublicKey: peer.ephemeral.publicKey,
    });
    const transcript = pairingTranscript(
      invitation,
      fixture.identityValue,
      peer,
    );
    const signature = sign(
      null,
      canonicalCompanionPairingTranscript(transcript),
      peer.identityPrivateKey,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        fixture.service.confirmInvite({
          pairingId: invitation.pairingId,
          shortCode: invitation.shortCode === "000000" ? "111111" : "000000",
          deviceId: peer.deviceId,
          deviceName: peer.deviceName,
          fingerprint: peer.fingerprint,
          transcript,
          initiatorIdentityPublicKey: peer.identityPublicKey,
          initiatorSignature: signature,
        }),
      ).rejects.toThrow();
    }
    await expect(
      fixture.service.confirmInvite({
        pairingId: invitation.pairingId,
        shortCode: invitation.shortCode,
        deviceId: peer.deviceId,
        deviceName: peer.deviceName,
        fingerprint: peer.fingerprint,
        transcript,
        initiatorIdentityPublicKey: peer.identityPublicKey,
        initiatorSignature: signature,
      }),
    ).rejects.toThrow("COMPANION_PAIRING_LOCKED");
    expect(fixture.service.snapshot().pairing.state).toBe("locked");
    expect(fixture.security.replaceCredential).not.toHaveBeenCalled();
    peer.ephemeral.destroy();
  });

  it("durably replays exact command identity and rejects key reuse", async () => {
    const fixture = createFixture();
    database = fixture.database;
    const first = await fixture.service.setOptIn(
      false,
      "companion-opt-in-0001",
    );
    expect(
      (await fixture.service.setOptIn(false, "companion-opt-in-0001")).revision,
    ).toBe(first.revision);
    await expect(
      fixture.service.setOptIn(true, "companion-opt-in-0001"),
    ).rejects.toThrow("COMPANION_COMMAND_CONFLICT");
  });

  it("serializes concurrent opt-in so one receiver and advertisement own the lifecycle", async () => {
    const fixture = createFixture();
    database = fixture.database;
    const [first, second] = await Promise.all([
      fixture.service.setOptIn(true, "companion-opt-in-1001"),
      fixture.service.setOptIn(true, "companion-opt-in-1002"),
    ]);
    expect(first.discovery.state).toBe("ready");
    expect(second.discovery.state).toBe("ready");
    expect(fixture.receiver.start).toHaveBeenCalledOnce();
  });

  it("opt-out fences a late permission-pending status result", async () => {
    let resolveStatus!: (value: {
      state: "registered";
      manualFallbackAvailable: false;
    }) => void;
    const statusResult = new Promise<{
      state: "registered";
      manualFallbackAvailable: false;
    }>((resolve) => {
      resolveStatus = resolve;
    });
    const discovery = {
      register: vi.fn().mockResolvedValue({
        state: "permission-pending" as const,
        manualFallbackAvailable: true,
      }),
      status: vi.fn(() => statusResult),
      unregister: vi.fn().mockResolvedValue(undefined),
    } satisfies CompanionDiscoveryPort;
    const fixture = createFixture({
      discovery,
      waitForDiscoveryPoll: async () => undefined,
    });
    database = fixture.database;
    expect((await fixture.service.setOptIn(true)).discovery.state).toBe(
      "permission-pending",
    );
    await vi.waitFor(() => expect(discovery.status).toHaveBeenCalledOnce());
    const disabled = await fixture.service.setOptIn(false);
    resolveStatus({ state: "registered", manualFallbackAvailable: false });
    await Promise.resolve();
    expect(disabled.discovery.state).toBe("disabled");
    expect(fixture.service.snapshot().discovery.state).toBe("disabled");
  });

  it("reconciles a keychain-delete crash without deleting transfer authority", async () => {
    const fixture = createFixture();
    database = fixture.database;
    fixture.repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    const manifest = {
      schema: "companion-audio-transfer/v2" as const,
      transferId: "transfer-revoke-crash",
      sourceAssetId: "mobile-recording-1",
      displayName: "audio.wav",
      sizeBytes: 8,
      wholeFileSha256: "a".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 1,
      createdAtMs: 1,
    };
    fixture.repository.beginTransfer(manifest, "mobile-1", 1_000);
    vi.spyOn(fixture.repository, "revokePeer").mockImplementationOnce(() => {
      throw new Error("simulated crash after keychain delete");
    });
    await expect(fixture.service.revokePeer("mobile-1")).rejects.toThrow(
      "simulated crash",
    );
    fixture.security.readCredential.mockResolvedValue({ state: "missing" });

    const recovered = await fixture.service.reconcileStartup();

    expect(recovered.peers[0]?.trustState).toBe("credential-missing");
    expect(fixture.repository.getTransfer(manifest.transferId)).toMatchObject({
      wholeFileSha256: manifest.wholeFileSha256,
      state: "interrupted",
    });
  });

  it("surfaces temporary keychain denial without persisting missing trust", async () => {
    const fixture = createFixture();
    database = fixture.database;
    fixture.repository.pairPeer({
      deviceId: "mobile-1",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    fixture.security.readCredential.mockResolvedValue({ state: "denied" });

    const recovered = await fixture.service.reconcileStartup();

    expect(recovered.peers[0]?.trustState).toBe("credential-missing");
    expect(fixture.repository.peer("mobile-1")?.trustState).toBe("active");
  });

  it("never signs a sender-delete receipt when committed media validation fails", async () => {
    const fixture = createFixture({
      commitVerifiedTransfer: vi
        .fn()
        .mockRejectedValue(new Error("committed media authority changed")),
    });
    database = fixture.database;
    fixture.repository.pairPeer({
      deviceId: "mobile-media-fence",
      displayName: "Test Phone",
      identityFingerprint: "M".repeat(32),
      credentialIdentitySha256: "c".repeat(64),
      pairedAtMs: 1,
    });
    const manifest = {
      schema: "companion-audio-transfer/v2" as const,
      transferId: "transfer-media-fence",
      sourceAssetId: "source-media-fence",
      displayName: "audio.wav",
      sizeBytes: 8,
      wholeFileSha256: "a".repeat(64),
      chunkBytes: 4_096,
      chunkCount: 1,
      createdAtMs: 1,
    };
    fixture.repository.beginTransfer(manifest, "mobile-media-fence", 1_000);
    fixture.repository.recordVerifiedChunk({
      transferId: manifest.transferId,
      wholeFileSha256: manifest.wholeFileSha256,
      index: 0,
      offset: 0,
      plaintextBytes: 8,
      sha256: "b".repeat(64),
      receivedAtMs: 1_100,
    });
    const verifying = fixture.repository.claimVerification(manifest, 1_200);
    fixture.repository.claimImport(
      manifest.transferId,
      verifying.revision,
      verifying.destinationIdentity!,
      1_300,
    );

    await expect(
      fixture.service.commitTransfer(manifest, "/private/staged.wav"),
    ).rejects.toThrow("committed media authority changed");
    expect(fixture.identity.signReceipt).not.toHaveBeenCalled();
    expect(fixture.repository.getTransfer(manifest.transferId)).toMatchObject({
      receipt: null,
      senderDeleteAllowed: false,
    });
  });
});

function createFixture(
  options: {
    discovery?: CompanionDiscoveryPort;
    waitForDiscoveryPoll?: () => Promise<void>;
    nowMs?: () => number;
    commitVerifiedTransfer?: CompanionImportCommitPort["commitVerifiedTransfer"];
  } = {},
) {
  const database = openAudioDatabase(":memory:");
  const repository = new TransferRepository(database);
  const storedCredentials: Buffer[] = [];
  const security = {
    readCredential: vi.fn(),
    replaceCredential: vi.fn(async (_request, credential: Uint8Array) => {
      storedCredentials.push(Buffer.from(credential));
      return "stored" as const;
    }),
    deleteCredential: vi.fn().mockResolvedValue("deleted"),
  } satisfies CompanionNativeSecurityPort;
  const discovery =
    options.discovery ??
    ({
      register: vi.fn().mockResolvedValue({
        state: "registered",
        manualFallbackAvailable: true,
      }),
      unregister: vi.fn().mockResolvedValue(undefined),
    } satisfies CompanionDiscoveryPort);
  const receiver = {
    start: vi.fn().mockResolvedValue({ port: 43123 }),
    stop: vi.fn().mockResolvedValue(undefined),
    cancelTransfer: vi.fn(),
    revokePeer: vi.fn(),
    cleanupPendingStaging: vi.fn().mockReturnValue(0),
  } satisfies CompanionReceiverPort;
  const identityPair = generateKeyPairSync("ed25519");
  const identityPublicKey = rawPublicKey(identityPair.publicKey);
  const identityValue = {
    deviceId: "desktop-1",
    deviceName: "Studio Mac",
    fingerprint: companionFingerprint(identityPublicKey),
  };
  const identity = {
    ensureIdentity: vi.fn().mockResolvedValue(identityValue),
    identityPublicKey: vi.fn().mockResolvedValue(identityPublicKey),
    signBytes: vi.fn(async (payload: Uint8Array) =>
      sign(null, Buffer.from(payload), identityPair.privateKey),
    ),
    signReceipt: vi.fn().mockResolvedValue("c2lnbmF0dXJl"),
  } satisfies CompanionIdentityPort;
  return {
    database,
    repository,
    security,
    receiver,
    identityValue,
    identityPublicKey,
    identityPair,
    identity,
    storedCredentials,
    service: new CompanionService(
      repository,
      security,
      discovery,
      receiver,
      identity,
      { commitVerifiedTransfer: options.commitVerifiedTransfer ?? vi.fn() },
      options.nowMs ?? (() => 1_000),
      options.waitForDiscoveryPoll,
      () => "192.168.1.20",
    ),
  };
}

function pairingPeer() {
  const identity = generateKeyPairSync("ed25519");
  const identityPublicKey = rawPublicKey(identity.publicKey);
  return {
    deviceId: "mobile-1",
    deviceName: "Test Phone",
    fingerprint: companionFingerprint(identityPublicKey),
    identityPublicKey,
    identityPrivateKey: identity.privateKey,
    ephemeral: generateCompanionX25519KeyPair(),
  };
}

function pairingTranscript(
  invitation: NonNullable<
    ReturnType<CompanionService["snapshot"]>["pairingInvite"]
  >,
  desktop: { deviceId: string; fingerprint: string },
  peer: ReturnType<typeof pairingPeer>,
): CompanionPairingTranscriptValue {
  return {
    schema: "companion-audio-transfer/v2",
    pairingId: invitation.pairingId,
    initiatorDeviceId: peer.deviceId,
    initiatorFingerprint: peer.fingerprint,
    initiatorEphemeralPublicKey: peer.ephemeral.publicKey.toString("base64"),
    responderDeviceId: desktop.deviceId,
    responderFingerprint: desktop.fingerprint,
    responderEphemeralPublicKey: invitation.responderEphemeralPublicKey,
    shortCodeHash: createHash("sha256")
      .update(`${invitation.pairingId}:${invitation.shortCode}`)
      .digest("hex"),
    expiresAtMs: invitation.expiresAtMs,
    capabilities: ["audio-transfer/v2"],
  };
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(-32));
}
