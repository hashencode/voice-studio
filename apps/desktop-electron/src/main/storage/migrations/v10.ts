import type { DatabaseSync } from "node:sqlite";

export function migrateSchemaV9ToV10(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE companion_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      receiver_enabled INTEGER NOT NULL DEFAULT 0 CHECK (receiver_enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      updated_at_ms INTEGER NOT NULL
    );
    INSERT INTO companion_settings VALUES (1, 0, 0, 0);

    CREATE TABLE companion_peers (
      device_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
      identity_fingerprint TEXT NOT NULL,
      credential_identity_sha256 TEXT NOT NULL CHECK (
        length(credential_identity_sha256) = 64 AND credential_identity_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      trust_state TEXT NOT NULL CHECK (trust_state IN ('active', 'revoked', 'credential-missing')),
      paired_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER,
      revoked_at_ms INTEGER
    );
    CREATE TABLE companion_transfers (
      transfer_id TEXT PRIMARY KEY,
      whole_file_sha256 TEXT NOT NULL CHECK (
        length(whole_file_sha256) = 64 AND whole_file_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      peer_device_id TEXT NOT NULL,
      source_asset_id TEXT NOT NULL,
      display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4294967296),
      chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes BETWEEN 4096 AND 1048576),
      chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 65536),
      state TEXT NOT NULL CHECK (state IN (
        'awaiting', 'transferring', 'verifying', 'importing', 'committed',
        'canceled', 'failed', 'interrupted', 'expired'
      )),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      error_code TEXT,
      meeting_id INTEGER,
      processing_job_id INTEGER,
      recording_id INTEGER,
      receipt_json TEXT CHECK (receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json) <= 4096)),
      sender_delete_allowed INTEGER NOT NULL DEFAULT 0 CHECK (sender_delete_allowed IN (0, 1)),
      destination_identity TEXT CHECK (
        destination_identity IS NULL OR (
          length(destination_identity) = 64 AND destination_identity NOT GLOB '*[^0-9a-f]*'
        )
      ),
      import_started_at_ms INTEGER,
      staging_cleanup_state TEXT NOT NULL DEFAULT 'active'
        CHECK (staging_cleanup_state IN ('active', 'pending', 'complete')),
      checkpoint_expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      FOREIGN KEY(peer_device_id) REFERENCES companion_peers(device_id) ON DELETE RESTRICT,
      FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE RESTRICT,
      FOREIGN KEY(processing_job_id) REFERENCES processing_jobs(id) ON DELETE RESTRICT,
      CHECK (sender_delete_allowed = 0 OR (state = 'committed' AND receipt_json IS NOT NULL))
    );
    CREATE INDEX companion_transfers_peer_history
      ON companion_transfers(peer_device_id, updated_at_ms DESC, transfer_id);
    CREATE INDEX companion_transfers_reconciliation
      ON companion_transfers(state, checkpoint_expires_at_ms, transfer_id);

    CREATE TABLE companion_transfer_chunks (
      transfer_id TEXT NOT NULL,
      whole_file_sha256 TEXT NOT NULL,
      chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 65535),
      chunk_offset INTEGER NOT NULL CHECK (chunk_offset >= 0),
      chunk_sha256 TEXT NOT NULL CHECK (
        length(chunk_sha256) = 64 AND chunk_sha256 NOT GLOB '*[^0-9a-f]*'
      ),
      plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes BETWEEN 1 AND 1048576),
      received_at_ms INTEGER NOT NULL,
      PRIMARY KEY(transfer_id, chunk_index),
      FOREIGN KEY(transfer_id) REFERENCES companion_transfers(transfer_id) ON DELETE CASCADE
    );

    CREATE TABLE companion_command_receipts (
      idempotency_key TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN (
        'set-opt-in', 'create-invite', 'revoke-peer', 'cancel-transfer', 'retry-transfer'
      )),
      target_identity TEXT NOT NULL,
      expected_revision INTEGER,
      result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
      result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 65536),
      created_at_ms INTEGER NOT NULL
    );
  `);
}
