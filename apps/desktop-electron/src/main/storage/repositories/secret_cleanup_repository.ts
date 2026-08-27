import type { DatabaseSync } from "node:sqlite";

export interface SecretCleanupRecord {
  secretRef: string;
  operation: "delete-keychain-item";
  state: "pending" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
  errorCode: string | null;
}

export class SecretCleanupRepository {
  constructor(private readonly database: DatabaseSync) {}

  pending(): SecretCleanupRecord[] {
    return this.database
      .prepare(
        `SELECT secret_ref, operation, state, created_at_ms, updated_at_ms, error_code
           FROM ai_secret_cleanup_queue
          ORDER BY created_at_ms, secret_ref`,
      )
      .all()
      .map((row) => ({
        secretRef: String(row.secret_ref),
        operation: "delete-keychain-item" as const,
        state: String(row.state) as SecretCleanupRecord["state"],
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
        errorCode: row.error_code == null ? null : String(row.error_code),
      }));
  }

  enqueue(secretRef: string, nowMs: number, errorCode: string | null): void {
    this.database
      .prepare(
        `INSERT INTO ai_secret_cleanup_queue (
           secret_ref, operation, state, created_at_ms, updated_at_ms, error_code
         ) VALUES (?, 'delete-keychain-item', ?, ?, ?, ?)
         ON CONFLICT(secret_ref) DO UPDATE SET
           state = excluded.state,
           updated_at_ms = excluded.updated_at_ms,
           error_code = excluded.error_code`,
      )
      .run(
        secretRef,
        errorCode === null ? "pending" : "failed",
        nowMs,
        nowMs,
        sanitizeCleanupErrorCode(errorCode),
      );
  }

  remove(secretRef: string): void {
    this.database
      .prepare("DELETE FROM ai_secret_cleanup_queue WHERE secret_ref = ?")
      .run(secretRef);
  }
}

function sanitizeCleanupErrorCode(errorCode: string | null): string | null {
  if (errorCode === null) return null;
  const sanitized = errorCode.replace(/[^A-Z0-9_-]/gu, "_").slice(0, 64);
  return sanitized.length > 0 ? sanitized : "AI_SECRET_CLEANUP_FAILED";
}
