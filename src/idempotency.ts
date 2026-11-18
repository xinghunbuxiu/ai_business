import type { RuntimeResult } from "./types.js";

export type IdempotencyReservation =
  | { status: "acquired" }
  | { status: "in_progress" }
  | { status: "conflict" }
  | { status: "completed"; result: RuntimeResult }
  | { status: "unknown" };

export interface IdempotencyStore {
  reserve(key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotencyReservation>;
  complete(key: string, fingerprint: string, result: RuntimeResult): Promise<void>;
  release(key: string, fingerprint: string): Promise<void>;
  markUnknown(key: string, fingerprint: string): Promise<void>;
}

export interface IdempotencySqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

type IdempotencyRow = {
  fingerprint: string;
  state: "in_progress" | "completed" | "unknown";
  result: RuntimeResult | null;
  expires_at: Date | string;
};

/**
 * PostgreSQL-backed idempotency store. Reservation is atomic on the unique
 * scope key. Completed responses are replayed; active reservations are never
 * executed twice by a competing Runtime instance.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: IdempotencySqlExecutor) {}

  async reserve(key: string, fingerprint: string, ttlSeconds: number): Promise<IdempotencyReservation> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 31_536_000) {
      throw new Error("IDEMPOTENCY_TTL_INVALID: ttlSeconds must be between 60 and 31536000");
    }
    const inserted = await this.db.query(
      `INSERT INTO a2api_idempotency (scope_key, fingerprint, state, result, expires_at, updated_at)
       VALUES ($1,$2,'in_progress',NULL,NOW() + ($3 * INTERVAL '1 second'),NOW())
       ON CONFLICT (scope_key) DO NOTHING`,
      [key, fingerprint, ttlSeconds]
    );
    if ((inserted.rowCount ?? 0) === 1) return { status: "acquired" };

    const existing = await this.db.query<IdempotencyRow>(
      "SELECT fingerprint, state, result, expires_at FROM a2api_idempotency WHERE scope_key=$1",
      [key]
    );
    const row = existing.rows[0];
    if (!row) {
      // A concurrent expiry cleanup may have removed the row. Retry once.
      const retry = await this.db.query(
        `INSERT INTO a2api_idempotency (scope_key, fingerprint, state, result, expires_at, updated_at)
         VALUES ($1,$2,'in_progress',NULL,NOW() + ($3 * INTERVAL '1 second'),NOW())
         ON CONFLICT (scope_key) DO NOTHING`,
        [key, fingerprint, ttlSeconds]
      );
      return (retry.rowCount ?? 0) === 1 ? { status: "acquired" } : { status: "in_progress" };
    }
    if (row.fingerprint !== fingerprint) return { status: "conflict" };
    if (row.state === "unknown") return { status: "unknown" };
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      if (row.state === "in_progress") {
        const marked = await this.db.query(
          "UPDATE a2api_idempotency SET state='unknown', updated_at=NOW() WHERE scope_key=$1 AND fingerprint=$2 AND state='in_progress' AND expires_at <= NOW()",
          [key, fingerprint]
        );
        return (marked.rowCount ?? 0) === 1 ? { status: "unknown" } : { status: "in_progress" };
      }
      await this.db.query("DELETE FROM a2api_idempotency WHERE scope_key=$1 AND state='completed' AND expires_at <= NOW()", [key]);
      const retry = await this.db.query(
        `INSERT INTO a2api_idempotency (scope_key, fingerprint, state, result, expires_at, updated_at)
         VALUES ($1,$2,'in_progress',NULL,NOW() + ($3 * INTERVAL '1 second'),NOW())
         ON CONFLICT (scope_key) DO NOTHING`,
        [key, fingerprint, ttlSeconds]
      );
      return (retry.rowCount ?? 0) === 1 ? { status: "acquired" } : { status: "in_progress" };
    }
    return row.state === "completed" && row.result
      ? { status: "completed", result: row.result }
      : { status: "in_progress" };
  }

  async complete(key: string, fingerprint: string, result: RuntimeResult): Promise<void> {
    const updated = await this.db.query(
      `UPDATE a2api_idempotency SET state='completed', result=$3::jsonb, updated_at=NOW()
       WHERE scope_key=$1 AND fingerprint=$2 AND state='in_progress' AND expires_at > NOW()`,
      [key, fingerprint, JSON.stringify(result)]
    );
    if ((updated.rowCount ?? 0) !== 1) throw new Error("IDEMPOTENCY_COMPLETION_REJECTED: reservation missing, expired or already completed");
  }

  async release(key: string, fingerprint: string): Promise<void> {
    await this.db.query(
      "DELETE FROM a2api_idempotency WHERE scope_key=$1 AND fingerprint=$2 AND state='in_progress'",
      [key, fingerprint]
    );
  }

  async markUnknown(key: string, fingerprint: string): Promise<void> {
    await this.db.query(
      "UPDATE a2api_idempotency SET state='unknown', updated_at=NOW() WHERE scope_key=$1 AND fingerprint=$2 AND state='in_progress'",
      [key, fingerprint]
    );
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const result = await this.db.query("DELETE FROM a2api_idempotency WHERE state='completed' AND expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }
}

export const IDEMPOTENCY_POSTGRES_MIGRATION = `
CREATE TABLE IF NOT EXISTS a2api_idempotency (
  scope_key TEXT PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress','completed','unknown')),
  result JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((state IN ('in_progress','unknown') AND result IS NULL) OR (state = 'completed' AND result IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_a2api_idempotency_expiry ON a2api_idempotency (expires_at);
`;
