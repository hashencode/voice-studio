import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  verify,
} from "node:crypto";

import {
  companionCapability,
  companionLimits,
  companionProtocol,
} from "../../../shared/contracts";

const initiatorDirection = 0x49325231;
const responderDirection = 0x52324931;
const messageTypes = new Set([
  "discovery",
  "pairingTranscript",
  "capability",
  "manifest",
  "chunk",
  "checkpoint",
  "receipt",
  "cancel",
  "error",
]);
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const fingerprintPattern = /^[A-Z2-7]{20,64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface CompanionPairingTranscriptValue {
  schema: typeof companionProtocol;
  pairingId: string;
  initiatorDeviceId: string;
  initiatorFingerprint: string;
  initiatorEphemeralPublicKey: string;
  responderDeviceId: string;
  responderFingerprint: string;
  responderEphemeralPublicKey: string;
  shortCodeHash: string;
  expiresAtMs: number;
  capabilities: [typeof companionCapability];
}

export interface CompanionX25519KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
  destroy(): void;
}

export function generateCompanionX25519KeyPair(): CompanionX25519KeyPair {
  const pair = generateKeyPairSync("x25519");
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
  const privateBytes = Buffer.from(privateDer.subarray(-32));
  privateDer.fill(0);
  return {
    publicKey: rawPublicKey(pair.publicKey),
    privateKey: privateBytes,
    destroy: () => privateBytes.fill(0),
  };
}

export function companionX25519Secret(
  privateKey: Buffer,
  peerPublicKey: Buffer,
): Buffer {
  requireBytes(privateKey, 32, "pairingPrivateKey");
  requireBytes(peerPublicKey, 32, "peerEphemeralPublicKey");
  const secret = Buffer.from(
    diffieHellman({
      privateKey: x25519PrivateKey(privateKey),
      publicKey: x25519PublicKey(peerPublicKey),
    }),
  );
  if (secret.every((byte) => byte === 0)) {
    secret.fill(0);
    throw new CompanionCryptoError(
      "INVALID_PAIRING_KEY",
      "pairing shared secret is invalid",
    );
  }
  return secret;
}

export function deriveCompanionPairingCredential(
  secret: Buffer,
  pairingId: string,
  purpose: "temporary-channel" | "long-term-peer",
  transcriptHash?: Buffer,
): Buffer {
  requireBytes(secret, 32, "pairingSecret");
  requireIdentifier(pairingId, "pairingId");
  if (purpose === "long-term-peer") {
    requireBytes(transcriptHash, 32, "transcriptHash");
  }
  const salt = createHash("sha256")
    .update(companionProtocol)
    .update(":pairing:")
    .update(pairingId)
    .digest();
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      salt,
      Buffer.concat([
        Buffer.from(`${companionProtocol}:pairing:${purpose}`, "utf8"),
        transcriptHash ?? Buffer.alloc(0),
      ]),
      32,
    ),
  );
}

export function canonicalCompanionPairingTranscript(
  value: CompanionPairingTranscriptValue,
): Buffer {
  validatePairingTranscript(value);
  return Buffer.from(
    JSON.stringify({
      schema: companionProtocol,
      pairingId: value.pairingId,
      initiatorDeviceId: value.initiatorDeviceId,
      initiatorFingerprint: value.initiatorFingerprint,
      initiatorEphemeralPublicKey: value.initiatorEphemeralPublicKey,
      responderDeviceId: value.responderDeviceId,
      responderFingerprint: value.responderFingerprint,
      responderEphemeralPublicKey: value.responderEphemeralPublicKey,
      shortCodeHash: value.shortCodeHash,
      expiresAtMs: value.expiresAtMs,
      capabilities: value.capabilities,
    }),
    "utf8",
  );
}

export function verifyCompanionPairingSignature(
  transcript: CompanionPairingTranscriptValue,
  identityPublicKey: Buffer,
  signature: Buffer,
  expectedFingerprint: string,
): void {
  requireBytes(identityPublicKey, 32, "identityPublicKey");
  requireBytes(signature, 64, "identitySignature");
  if (companionFingerprint(identityPublicKey) !== expectedFingerprint) {
    throw new CompanionCryptoError(
      "PAIRING_FINGERPRINT_MISMATCH",
      "pairing identity fingerprint changed",
    );
  }
  if (
    !verify(
      null,
      canonicalCompanionPairingTranscript(transcript),
      ed25519PublicKey(identityPublicKey),
      signature,
    )
  ) {
    throw new CompanionCryptoError(
      "PAIRING_SIGNATURE_INVALID",
      "pairing signature is invalid",
    );
  }
}

export function companionFingerprint(publicKey: Buffer): string {
  requireBytes(publicKey, 32, "identityPublicKey");
  return base32(
    createHash("sha256").update(publicKey).digest().subarray(0, 20),
  );
}

export class CompanionCryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompanionCryptoError";
  }
}

export interface CompanionCryptoEnvelope {
  schema: typeof companionProtocol;
  type: string;
  messageId: string;
  sessionId: string;
  counter: number;
  payload: Record<string, unknown>;
}

export class CompanionCryptoSession {
  private readonly sendKey: Buffer;
  private readonly receiveKey: Buffer;
  private readonly sendDirection: number;
  private readonly receiveDirection: number;
  private sendCounter = 0;
  private highestReceiveCounter = -1;

  constructor(
    private readonly options: {
      role: "initiator" | "responder";
      sessionId: string;
      sharedCredential: Buffer;
      initiatorNonce: Buffer;
      responderNonce: Buffer;
      expiresAtMs: number;
      nowMs?: () => number;
    },
  ) {
    requireIdentifier(options.sessionId, "sessionId");
    requireBytes(options.sharedCredential, 32, "sharedCredential");
    requireBytes(options.initiatorNonce, 32, "initiatorNonce");
    requireBytes(options.responderNonce, 32, "responderNonce");
    if (!Number.isSafeInteger(options.expiresAtMs) || options.expiresAtMs < 0) {
      throw new CompanionCryptoError(
        "INVALID_SESSION_HANDSHAKE",
        "invalid expiry",
      );
    }
    const salt = createHash("sha256")
      .update(options.initiatorNonce)
      .update(options.responderNonce)
      .digest();
    const material = Buffer.from(
      hkdfSync(
        "sha256",
        options.sharedCredential,
        salt,
        Buffer.from(`${companionProtocol}:${options.sessionId}`, "utf8"),
        64,
      ),
    );
    const initiatorSend = Buffer.from(material.subarray(0, 32));
    const responderSend = Buffer.from(material.subarray(32, 64));
    material.fill(0);
    if (options.role === "initiator") {
      this.sendKey = initiatorSend;
      this.receiveKey = responderSend;
      this.sendDirection = initiatorDirection;
      this.receiveDirection = responderDirection;
    } else {
      this.sendKey = responderSend;
      this.receiveKey = initiatorSend;
      this.sendDirection = responderDirection;
      this.receiveDirection = initiatorDirection;
    }
  }

  sealControl(
    type: string,
    messageId: string,
    payload: Record<string, unknown>,
  ): string {
    this.requireLive();
    if (!messageTypes.has(type)) {
      throw new CompanionCryptoError(
        "UNKNOWN_MESSAGE_TYPE",
        "unknown message type",
      );
    }
    requireIdentifier(messageId, "messageId");
    requireBoundedJson(payload, companionLimits.maximumMetadataBytes);
    const counter = this.nextSendCounter();
    const envelope: CompanionCryptoEnvelope = {
      schema: companionProtocol,
      type,
      messageId,
      sessionId: this.options.sessionId,
      counter,
      payload,
    };
    const cleartext = Buffer.from(JSON.stringify(envelope), "utf8");
    if (cleartext.length > companionLimits.maximumMetadataBytes) {
      throw new CompanionCryptoError(
        "METADATA_TOO_LARGE",
        "envelope exceeds limit",
      );
    }
    const encrypted = encrypt(
      this.sendKey,
      nonce(this.sendDirection, counter),
      cleartext,
      Buffer.from(`${companionProtocol}:${this.options.sessionId}`, "utf8"),
    );
    return JSON.stringify({
      schema: companionProtocol,
      sessionId: this.options.sessionId,
      counter,
      ciphertext: encrypted.ciphertext.toString("base64"),
      mac: encrypted.tag.toString("base64"),
    });
  }

  openControl(sealed: string): CompanionCryptoEnvelope {
    this.requireLive();
    if (
      Buffer.byteLength(sealed, "utf8") >
      companionLimits.maximumMetadataBytes * 2
    ) {
      throw new CompanionCryptoError(
        "SEALED_MESSAGE_TOO_LARGE",
        "sealed message exceeds limit",
      );
    }
    const wrapper = parseObject(sealed, "INVALID_SEALED_MESSAGE");
    exactKeys(wrapper, ["schema", "sessionId", "counter", "ciphertext", "mac"]);
    const counter = requireCounter(wrapper.counter);
    if (
      wrapper.schema !== companionProtocol ||
      wrapper.sessionId !== this.options.sessionId ||
      counter <= this.highestReceiveCounter
    ) {
      throw new CompanionCryptoError(
        counter <= this.highestReceiveCounter
          ? "REPLAY_REJECTED"
          : "INVALID_SEALED_MESSAGE",
        "sealed message identity or counter is invalid",
      );
    }
    const ciphertext = decodeCanonicalBase64(
      wrapper.ciphertext,
      undefined,
      "ciphertext",
    );
    const mac = decodeCanonicalBase64(wrapper.mac, 16, "mac");
    let cleartext: Buffer;
    try {
      cleartext = decrypt(
        this.receiveKey,
        nonce(this.receiveDirection, counter),
        ciphertext,
        mac,
        Buffer.from(`${companionProtocol}:${this.options.sessionId}`, "utf8"),
      );
    } catch {
      throw new CompanionCryptoError(
        "AUTHENTICATION_FAILED",
        "control authentication failed",
      );
    }
    if (cleartext.length > companionLimits.maximumMetadataBytes) {
      throw new CompanionCryptoError(
        "METADATA_TOO_LARGE",
        "envelope exceeds limit",
      );
    }
    const envelope = parseObject(cleartext.toString("utf8"), "INVALID_JSON");
    exactKeys(envelope, [
      "schema",
      "type",
      "messageId",
      "sessionId",
      "counter",
      "payload",
    ]);
    if (
      envelope.schema !== companionProtocol ||
      envelope.sessionId !== this.options.sessionId ||
      envelope.counter !== counter ||
      typeof envelope.type !== "string" ||
      !messageTypes.has(envelope.type) ||
      typeof envelope.messageId !== "string" ||
      !identifier.test(envelope.messageId) ||
      !isPlainObject(envelope.payload)
    ) {
      throw new CompanionCryptoError(
        "INVALID_ENVELOPE",
        "control envelope is invalid",
      );
    }
    requireBoundedJson(envelope.payload, companionLimits.maximumMetadataBytes);
    this.highestReceiveCounter = counter;
    return envelope as unknown as CompanionCryptoEnvelope;
  }

  sealBinary(plaintext: Buffer): Buffer {
    this.requireLive();
    if (
      plaintext.length < 1 ||
      plaintext.length > companionLimits.maximumChunkBytes
    ) {
      throw new CompanionCryptoError(
        "INVALID_BINARY_PAYLOAD",
        "binary payload is outside limit",
      );
    }
    const counter = this.nextSendCounter();
    const encrypted = encrypt(
      this.sendKey,
      nonce(this.sendDirection, counter),
      plaintext,
      Buffer.from(
        `${companionProtocol}:${this.options.sessionId}:binary:${counter}`,
        "utf8",
      ),
    );
    const packet = Buffer.allocUnsafe(25 + encrypted.ciphertext.length);
    packet[0] = 1;
    packet.writeBigUInt64BE(BigInt(counter), 1);
    encrypted.tag.copy(packet, 9);
    encrypted.ciphertext.copy(packet, 25);
    return packet;
  }

  openBinary(packet: Buffer): Buffer {
    this.requireLive();
    if (
      packet.length < 26 ||
      packet.length > companionLimits.maximumChunkBytes + 25 ||
      packet[0] !== 1
    ) {
      throw new CompanionCryptoError(
        "INVALID_BINARY_PACKET",
        "binary packet is malformed",
      );
    }
    const rawCounter = packet.readBigUInt64BE(1);
    if (rawCounter > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CompanionCryptoError(
        "INVALID_COUNTER",
        "counter is outside safe range",
      );
    }
    const counter = Number(rawCounter);
    if (counter <= this.highestReceiveCounter) {
      throw new CompanionCryptoError(
        "REPLAY_REJECTED",
        "binary packet was already received",
      );
    }
    let cleartext: Buffer;
    try {
      cleartext = decrypt(
        this.receiveKey,
        nonce(this.receiveDirection, counter),
        packet.subarray(25),
        packet.subarray(9, 25),
        Buffer.from(
          `${companionProtocol}:${this.options.sessionId}:binary:${counter}`,
          "utf8",
        ),
      );
    } catch {
      throw new CompanionCryptoError(
        "AUTHENTICATION_FAILED",
        "binary authentication failed",
      );
    }
    this.highestReceiveCounter = counter;
    return cleartext;
  }

  destroy(): void {
    this.sendKey.fill(0);
    this.receiveKey.fill(0);
  }

  private nextSendCounter(): number {
    if (this.sendCounter > Number.MAX_SAFE_INTEGER) {
      throw new CompanionCryptoError("INVALID_COUNTER", "counter exhausted");
    }
    return this.sendCounter++;
  }

  private requireLive(): void {
    if ((this.options.nowMs ?? Date.now)() > this.options.expiresAtMs) {
      throw new CompanionCryptoError(
        "SESSION_EXPIRED",
        "encrypted session expired",
      );
    }
  }
}

export class CompanionReceiverCryptoSession extends CompanionCryptoSession {
  constructor(
    options: Omit<
      ConstructorParameters<typeof CompanionCryptoSession>[0],
      "role"
    >,
  ) {
    super({ ...options, role: "responder" });
  }
}

export function decodeCanonicalBase64(
  value: unknown,
  expectedBytes?: number,
  field = "value",
): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new CompanionCryptoError(
      "INVALID_BASE64",
      `${field} is not canonical base64`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw new CompanionCryptoError(
      "INVALID_BASE64",
      `${field} has invalid length`,
    );
  }
  return decoded;
}

function encrypt(key: Buffer, iv: Buffer, cleartext: Buffer, aad: Buffer) {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  return {
    ciphertext: Buffer.concat([cipher.update(cleartext), cipher.final()]),
    tag: cipher.getAuthTag(),
  };
}

function decrypt(
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function nonce(direction: number, counter: number): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new CompanionCryptoError("INVALID_COUNTER", "counter is invalid");
  }
  const output = Buffer.alloc(12);
  output.writeUInt32BE(direction, 0);
  output.writeBigUInt64BE(BigInt(counter), 4);
  return output;
}

function parseObject(encoded: string, code: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new CompanionCryptoError(code, "JSON is malformed");
  }
  if (!isPlainObject(decoded))
    throw new CompanionCryptoError(code, "JSON object required");
  return decoded;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new CompanionCryptoError(
      "INVALID_FIELDS",
      "missing or unknown fields",
    );
  }
}

function requireCounter(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CompanionCryptoError("INVALID_COUNTER", "counter is invalid");
  }
  return Number(value);
}

function requireIdentifier(value: string, field: string): void {
  if (!identifier.test(value)) {
    throw new CompanionCryptoError("INVALID_IDENTIFIER", `${field} is invalid`);
  }
}

function requireBytes(
  value: Buffer | undefined,
  length: number,
  field: string,
): asserts value is Buffer {
  if (!Buffer.isBuffer(value) || value.length !== length) {
    throw new CompanionCryptoError(
      "INVALID_SESSION_HANDSHAKE",
      `${field} is invalid`,
    );
  }
}

function requireBoundedJson(
  value: Record<string, unknown>,
  maximum: number,
): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CompanionCryptoError("INVALID_JSON", "value is not serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > maximum) {
    throw new CompanionCryptoError(
      "METADATA_TOO_LARGE",
      "metadata exceeds limit",
    );
  }
}

function validatePairingTranscript(
  value: CompanionPairingTranscriptValue,
): void {
  if (
    value.schema !== companionProtocol ||
    !identifier.test(value.pairingId) ||
    !identifier.test(value.initiatorDeviceId) ||
    !identifier.test(value.responderDeviceId) ||
    !fingerprintPattern.test(value.initiatorFingerprint) ||
    !fingerprintPattern.test(value.responderFingerprint) ||
    !sha256Pattern.test(value.shortCodeHash) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs < 0 ||
    value.capabilities.length !== 1 ||
    value.capabilities[0] !== companionCapability
  ) {
    throw new CompanionCryptoError(
      "INVALID_PAIRING_TRANSCRIPT",
      "pairing transcript is invalid",
    );
  }
  decodeCanonicalBase64(
    value.initiatorEphemeralPublicKey,
    32,
    "initiatorEphemeralPublicKey",
  );
  decodeCanonicalBase64(
    value.responderEphemeralPublicKey,
    32,
    "responderEphemeralPublicKey",
  );
}

function x25519PrivateKey(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      raw,
    ]),
    format: "der",
    type: "pkcs8",
  });
}

function x25519PublicKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function ed25519PublicKey(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: "der", type: "spki" });
  if (der.length !== 44) {
    throw new CompanionCryptoError(
      "INVALID_PAIRING_KEY",
      "pairing public key is invalid",
    );
  }
  return Buffer.from(der.subarray(-32));
}

function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}
