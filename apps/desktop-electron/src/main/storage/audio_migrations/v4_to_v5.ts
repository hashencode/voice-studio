import type { DatabaseSync } from "node:sqlite";

const TITLE_ORIGIN_PREFIX = "workspace-title-origin:";
const DESCRIPTION_PREFIX = "workspace-description:";

export function migrateAudioV4ToV5(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (pragmaNumber(database, "user_version") !== 4) {
      throw new Error("audio database changed before v4 migration");
    }

    const reservedNotes = database
      .prepare(
        `SELECT id, audio_id, idempotency_key, body
         FROM audio_notes
         WHERE idempotency_key LIKE 'workspace-title-origin:%'
            OR idempotency_key LIKE 'workspace-description:%'
         ORDER BY id`,
      )
      .all();
    for (const note of reservedNotes) assertReservedNoteOwner(note);

    database.exec(`
      ALTER TABLE audio_items ADD COLUMN original_name TEXT NOT NULL DEFAULT ' ' CHECK (length(original_name) > 0);
      ALTER TABLE audio_items ADD COLUMN description TEXT NOT NULL DEFAULT '';
      UPDATE audio_items
      SET original_name = COALESCE(
        (SELECT body FROM audio_notes
         WHERE audio_id = audio_items.id
           AND idempotency_key = 'workspace-title-origin:' || audio_items.id),
        display_name
      ),
      description = COALESCE(
        (SELECT body FROM audio_notes
         WHERE audio_id = audio_items.id
           AND idempotency_key = 'workspace-description:' || audio_items.id),
        ''
      );
    `);

    const invalid = database
      .prepare(
        "SELECT id FROM audio_items WHERE original_name IS NULL OR length(original_name) = 0 OR description IS NULL LIMIT 1",
      )
      .get();
    if (invalid) throw new Error("audio metadata backfill is incomplete");
    assertAudioItemsV5Columns(database);
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error(
        "audio database has foreign-key damage after v4 migration",
      );
    }
    const integrity = database.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || String(integrity[0]?.quick_check) !== "ok") {
      throw new Error("audio database integrity failed after v4 migration");
    }

    database.exec("PRAGMA user_version = 5");
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

function assertReservedNoteOwner(note: Record<string, unknown>): void {
  const key = String(note.idempotency_key);
  const prefix = key.startsWith(TITLE_ORIGIN_PREFIX)
    ? TITLE_ORIGIN_PREFIX
    : DESCRIPTION_PREFIX;
  const suffix = key.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(suffix) || Number(suffix) !== Number(note.audio_id)) {
    throw new Error(
      `reserved metadata note ${String(note.id)} has invalid ownership`,
    );
  }
}

function assertAudioItemsV5Columns(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(audio_items)").all();
  const actual = columns.map((row) => String(row.name));
  const expected = [
    "id",
    "idempotency_key",
    "source_identity",
    "display_name",
    "media_path",
    "duration_ms",
    "media_authority_id",
    "active_publication_id",
    "active_generation_id",
    "created_at_ms",
    "updated_at_ms",
    "original_name",
    "description",
  ];
  if (
    actual.length !== expected.length ||
    expected.some((name) => !actual.includes(name))
  ) {
    throw new Error("audio_items schema does not match v5");
  }
  for (const name of ["original_name", "description"]) {
    const column = columns.find((row) => String(row.name) === name);
    if (Number(column?.notnull) !== 1) {
      throw new Error(`audio_items.${name} must be NOT NULL in v5`);
    }
  }
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  const value = database.prepare(`PRAGMA ${pragma}`).get()?.[pragma];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`SQLite PRAGMA ${pragma} is invalid`);
  }
  return Number(value);
}
