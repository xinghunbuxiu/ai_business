import type { WorkflowExecution } from "./workflow.js";

export interface WorkflowExecutionRepository {
  create(execution: WorkflowExecution): Promise<void>;
  get(executionId: string): Promise<WorkflowExecution | undefined>;
  save(execution: WorkflowExecution, expectedRevision: number, workerId?: string): Promise<number>;
  claim(executionId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  renew(executionId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  release(executionId: string, workerId: string): Promise<void>;
}

export interface WorkflowSqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

type WorkflowExecutionRow = {
  execution: WorkflowExecution | string;
  revision: number;
};

/**
 * Durable workflow snapshots with optimistic concurrency control.
 * This repository prevents stale snapshots from overwriting newer state;
 * it is not a distributed execution lock or exactly-once action guarantee.
 */
export class PostgresWorkflowExecutionRepository implements WorkflowExecutionRepository {
  constructor(private readonly db: WorkflowSqlExecutor) {}

  async create(execution: WorkflowExecution): Promise<void> {
    const snapshot = { ...execution, revision: 1 };
    const result = await this.db.query(
      `INSERT INTO a2wf_executions (execution_id, workflow_id, workflow_version, tenant_id, status, revision, execution, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,1,$6::jsonb,$7,$8)
       ON CONFLICT (execution_id) DO NOTHING`,
      [execution.id, execution.workflowId, execution.workflowVersion,
        execution.identity.tenantId ?? null, execution.status, JSON.stringify(snapshot),
        execution.createdAt, execution.updatedAt]
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("WORKFLOW_EXECUTION_ALREADY_EXISTS");
  }

  async get(executionId: string): Promise<WorkflowExecution | undefined> {
    const result = await this.db.query<WorkflowExecutionRow>(
      "SELECT execution, revision FROM a2wf_executions WHERE execution_id=$1",
      [executionId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const execution = typeof row.execution === "string" ? JSON.parse(row.execution) as WorkflowExecution : row.execution;
    return { ...execution, revision: Number(row.revision) };
  }

  async claim(executionId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    this.validateLease(workerId, leaseSeconds);
    const result = await this.db.query(
      "UPDATE a2wf_executions SET lease_owner=$2, lease_expires_at=NOW() + ($3 * INTERVAL '1 second') WHERE execution_id=$1 AND status IN ('running','awaiting_input','awaiting_confirmation') AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())",
      [executionId, workerId, leaseSeconds]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async renew(executionId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    this.validateLease(workerId, leaseSeconds);
    const result = await this.db.query(
      "UPDATE a2wf_executions SET lease_expires_at=NOW() + ($3 * INTERVAL '1 second') WHERE execution_id=$1 AND lease_owner=$2 AND lease_expires_at > NOW() AND status IN ('running','awaiting_input','awaiting_confirmation')",
      [executionId, workerId, leaseSeconds]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async release(executionId: string, workerId: string): Promise<void> {
    await this.db.query(
      "UPDATE a2wf_executions SET lease_owner=NULL, lease_expires_at=NULL WHERE execution_id=$1 AND lease_owner=$2",
      [executionId, workerId]
    );
  }

  private validateLease(workerId: string, leaseSeconds: number): void {
    if (!workerId || workerId.length > 128) throw new Error("WORKFLOW_WORKER_ID_INVALID");
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) throw new Error("WORKFLOW_LEASE_DURATION_INVALID");
  }

  async save(execution: WorkflowExecution, expectedRevision: number, workerId?: string): Promise<number> {
    const nextRevision = expectedRevision + 1;
    const snapshot = { ...execution, revision: nextRevision };
    const result = await this.db.query(
      `UPDATE a2wf_executions
       SET workflow_id=$2, workflow_version=$3, tenant_id=$4, status=$5,
           revision=$6, execution=$7::jsonb, updated_at=$8
       WHERE execution_id=$1 AND revision=$9 AND ($10::text IS NULL OR (lease_owner=$10 AND lease_expires_at > NOW()))`,
      [execution.id, execution.workflowId, execution.workflowVersion,
        execution.identity.tenantId ?? null, execution.status, nextRevision,
        JSON.stringify(snapshot), execution.updatedAt, expectedRevision, workerId ?? null]
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("WORKFLOW_EXECUTION_CONFLICT");
    return nextRevision;
  }
}

export const WORKFLOW_POSTGRES_MIGRATION = `
CREATE TABLE IF NOT EXISTS a2wf_executions (
  execution_id UUID PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  tenant_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','awaiting_input','awaiting_confirmation','completed','failed')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  execution JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_a2wf_executions_tenant_status
  ON a2wf_executions (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2wf_executions_lease
  ON a2wf_executions (lease_expires_at) WHERE status IN ('running','awaiting_input','awaiting_confirmation');
CREATE INDEX IF NOT EXISTS idx_a2wf_executions_workflow
  ON a2wf_executions (workflow_id, workflow_version, created_at DESC);
`;
