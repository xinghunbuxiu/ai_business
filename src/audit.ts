import type { RuntimeEvent } from "./runtime.js";

export type A2APIAuditRecord = {
  eventType: string;
  occurredAt: string;
  requestId?: string;
  traceId?: string;
  capabilityId?: string;
  tenantId?: string;
  actorId?: string;
  appId?: string;
  outcome?: "started" | "succeeded" | "failed" | "denied";
  errorCode?: string;
  metadata?: Record<string, unknown>;
};

export interface AuditStore {
  append(record: A2APIAuditRecord): Promise<void>;
}

export interface AuditSqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Append-only PostgreSQL audit writer. No input payloads, credentials or secrets are stored. */
export class PostgresAuditStore implements AuditStore {
  constructor(private readonly db: AuditSqlExecutor) {}

  async append(record: A2APIAuditRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO a2api_audit_events
       (event_type, occurred_at, request_id, trace_id, capability_id, tenant_id, actor_id, app_id, outcome, error_code, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        record.eventType, record.occurredAt, record.requestId ?? null, record.traceId ?? null,
        record.capabilityId ?? null, record.tenantId ?? null, record.actorId ?? null,
        record.appId ?? null, record.outcome ?? null, record.errorCode ?? null,
        JSON.stringify(record.metadata ?? {})
      ]
    );
  }
}

export function runtimeEventToAuditRecord(event: RuntimeEvent): A2APIAuditRecord {
  const detail = event.detail && typeof event.detail === "object"
    ? event.detail as Record<string, unknown>
    : undefined;
  const errorCode = detail && typeof detail.code === "string" ? detail.code : undefined;
  return {
    eventType: event.type,
    occurredAt: event.at,
    requestId: event.requestId,
    traceId: event.traceId,
    capabilityId: event.capability,
    tenantId: event.tenantId,
    actorId: event.actorId,
    appId: event.appId,
    outcome: event.type === "execution.started" ? "started" :
      event.type === "execution.succeeded" ? "succeeded" : "failed",
    errorCode,
    metadata: errorCode ? { retryable: detail?.retryable === true } : {}
  };
}

export const AUDIT_POSTGRES_MIGRATION = `
CREATE TABLE IF NOT EXISTS a2api_audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  request_id TEXT,
  trace_id TEXT,
  capability_id TEXT,
  tenant_id TEXT,
  actor_id TEXT,
  app_id TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('started','succeeded','failed','denied')),
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_a2api_audit_tenant_time ON a2api_audit_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2api_audit_trace ON a2api_audit_events (trace_id);
CREATE INDEX IF NOT EXISTS idx_a2api_audit_request ON a2api_audit_events (request_id);
`;
