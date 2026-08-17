# Audio Intelligence Provider Protocol v1

## Status

Contract status: `FROZEN_V1`. Product status:
`DEFERRED_PC_RUNTIME_MISSING`.

This document defines the minimum mobile ↔ PC provider boundary required before
QR pairing can be implemented. It does not authorize a scanner route, camera
permission, PC adapter, discovery UI, or “connected” product state. Those remain
TODO until an interoperable PC runtime and security fixture exist.

## Security model

Pairing establishes a mutually authenticated, encrypted session. A conforming
runtime must:

- use `wss://` with TLS 1.3 or an equivalently reviewed authenticated encrypted
  transport;
- bind the advertised X25519 public key to the QR `publicKeyFingerprint`;
- prove possession of the private key by signing/responding to a one-time,
  256-bit challenge;
- expire offers after at most 120 seconds and reject a challenge/session tuple
  that was already consumed;
- negotiate an exact protocol version and named capabilities before accepting a
  job;
- bind every message to `sessionId`, `jobId`, `idempotencyKey`, and the
  SHA-256 `inputHash` where applicable;
- verify the input hash again on the result and reject mismatches;
- never place an API key, bearer token, cookie, password, private key, or other
  permanent credential in a QR payload or protocol message;
- retain no audio transcript after the mobile-declared job retention window
  unless the user separately opts in.

The QR code is an ephemeral invitation, not a credential vault. It contains only
the PC endpoint, public-key material/fingerprint, one-time challenge, expiry,
provider metadata, and offered capabilities.

## Version and vocabulary

- Protocol schema: `audio_intelligence_provider/v1`.
- Result schema: `audio_intelligence_output/v1`, identical to the app-owned
  DeepSeek adapter output contract.
- Processing locations: `onDevice`, `cloudDirect`, `pairedPc`. This protocol
  requires `pairedPc`.
- Required capability: `audio_intelligence.generate.v1`.
- Optional capabilities:
  `audio_intelligence.progress.v1`,
  `audio_intelligence.cancel.v1`,
  `audio_intelligence.retry.v1`.

Unknown versions, locations, message types, fields, or capabilities fail closed.
There is no legacy `local`/`remote` wire vocabulary.

## Message sequence

1. PC renders a `pairingOffer` QR valid for no more than 120 seconds.
2. Mobile verifies shape, expiry, fingerprint and absence of secret-bearing
   fields, then sends `pairingAccept` over the authenticated encrypted channel.
3. PC verifies the one-time challenge and replies with a negotiated capability
   set. Reusing the offer is a replay error.
4. Mobile obtains the same per-audio explicit consent used by cloud direct,
   computes the canonical transcript input SHA-256, and sends `jobRequest`.
5. PC may emit monotonic `jobProgress`. Mobile may send `jobCancel`. A retry
   reuses the original `idempotencyKey`; an uncertain request is never silently
   retried.
6. PC returns `jobResult` with the original job/idempotency/input identities and
   a strict `audio_intelligence_output/v1` object. Mobile validates both
   protocol identity and application output before persistence.

## QR payload

```json
{
  "schemaVersion": "audio_intelligence_provider/v1",
  "messageType": "pairingOffer",
  "protocolVersion": 1,
  "sessionId": "018f3da0-90e7-7d31-a912-4b75d4f05521",
  "endpoint": "wss://pc.example.invalid/audio-intelligence/v1",
  "serverPublicKey": "X25519_BASE64URL_PUBLIC_KEY",
  "publicKeyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "challenge": "BASE64URL_32_BYTE_ONE_TIME_CHALLENGE",
  "issuedAtMs": 1784990000000,
  "expiresAtMs": 1784990120000,
  "capabilities": [
    "audio_intelligence.generate.v1",
    "audio_intelligence.progress.v1",
    "audio_intelligence.cancel.v1"
  ],
  "providerId": "user-pc-provider",
  "modelId": "user-configured-model",
  "processingLocation": "pairedPc"
}
```

`endpoint` must not contain user info, query parameters, or fragments.
`serverPublicKey` and `challenge` are intentionally non-secret public/ephemeral
values. The fingerprint is computed over the decoded public key using SHA-256.

## Job identities and canonical input

`inputHash` is lowercase hex SHA-256 over the UTF-8 JSON canonicalization of:

```json
{
  "schema_version": "audio_intelligence_input/v1",
  "template_id": "general",
  "input_start_ms": 0,
  "input_end_ms": 120000,
  "segments": [
    {"segment_id": 1, "start_ms": 0, "end_ms": 1200, "text": "example"}
  ]
}
```

Object keys are sorted lexicographically, arrays retain order, integers use
base-10 without leading zeros, and no insignificant whitespace is emitted.
Speaker labels may be included only when displayed in consent and then become
part of this canonical input.

`idempotencyKey` identifies one logical paid/compute operation and is stable
across an explicit retry. `jobId` identifies a persisted mobile job attempt.
The PC must return the prior terminal result for the same idempotency key and
input hash; the same key with a different input hash is a conflict.

## Progress, cancel, retry, and result

Progress is monotonic from 0 through 100 and is advisory. Cancellation is
idempotent and yields a terminal canceled state when observed. If delivery is
uncertain, mobile records `recoveryUnknown` and requires explicit user action
before retrying.

The authoritative JSON Schema is
[`audio-intelligence-provider-v1.schema.json`](../contracts/audio-intelligence-provider-v1.schema.json).
The schema includes `pairingOffer`, `pairingAccept`, `jobRequest`,
`jobProgress`, `jobCancel`, and `jobResult`. `jobResult.output` uses the
app-owned structured output fields, including evidence segment/time ranges.

## Implementation TODO

- PC runtime, transport and private-key lifecycle.
- Cross-implementation security fixtures and replay cache.
- Mobile scanner/adapter and user-facing pairing management.
- Device revocation and session retention policy UX.

Until these exist and pass the contract validator, the product status remains
`DEFERRED_PC_RUNTIME_MISSING` and no actionable PC pairing entrance may ship.
