# Companion Audio transfer v2

`companion-audio-transfer/v2` transfers immutable Audio source media from the
mobile app to a paired desktop. It is deliberately separate from
`audio_intelligence_provider/v1`, which remains the frozen
transcript-to-structured-notes protocol. Peers advertise the exact
`audio-transfer/v2` capability; v1 schemas and capabilities are rejected before
pairing, credential, checkpoint, or transfer state changes.

## Trust and discovery

The desktop listens on a dynamic private-LAN port and advertises
`_voice2text-audio._tcp` through DNS-SD. Discovery supplies an address, device
name, capability, and public-key fingerprint; it never establishes trust.
Pairing requires a visible six-digit code or QR confirmation on both devices,
binds both device identifiers and Ed25519 fingerprints into one signed
transcript, expires within two minutes, and locks after five failed attempts.
Long-term credentials live in Android Keystore or macOS Keychain. A changed,
revoked, restored, or missing device key requires a new pairing. Unpairing
deletes the credential and unfinished checkpoints.

Each connection derives directional AES-256-GCM keys from a 32-byte paired
credential and fresh 32-byte nonces using HKDF-SHA256. Every encrypted envelope
has an authenticated session ID and monotonic counter. Replayed, expired,
unknown-peer, authentication-failed, or legacy-v1 messages are rejected before
transfer state changes. No API key, reusable credential, filesystem path,
transcript, or audio bytes appear in discovery or unencrypted framing.

## Transfer and commit

The sender transmits a bounded manifest followed by independently hashed
chunks. `transferId + wholeFileSha256` is the idempotency identity. The desktop
persists a checkpoint and returns the missing chunk indexes, so reconnection
sends only missing chunks. Sender paths are never accepted as destination
paths. Staging rejects traversal, links, non-regular files, invalid offsets,
oversized metadata, sparse/size mismatches, overwrite conflicts, and storage
shortage.

After every chunk is present, the desktop reassembles the final bytes,
recomputes the whole-file SHA-256, and feeds the staged file to the same private
import path and Audio processing queue used by the desktop file picker. A
signed receipt is created only after that durable commit. Repeated manifests or
commit requests return the same receipt and Audio ID.

The mobile source remains authoritative until a valid receipt is stored. v2
defaults to retaining it. The user may explicitly delete it after receipt,
defer cleanup, or inspect the receipt from transfer history. Failed, canceled,
offline, permission-denied, or duplicate transfers never delete the source.
The mobile and desktop continue using separate SQLite files; only versioned
manifest, checkpoint, and receipt envelopes cross the connection.

## Failure behavior

Local-network permission denial, multicast isolation, or unavailable discovery
keeps recording, mobile transcription/review/export, and ordinary desktop file
import available. Cancellation is explicit and retryable. Restart reconciliation
either resumes a valid checkpoint or removes an uncommitted temporary tree;
committed Audio items and stored receipts are not removed.
