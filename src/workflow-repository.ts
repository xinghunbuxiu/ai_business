import type { WorkflowExecution } from "./workflow.js";

export interface WorkflowExecutionRepository {
  create(execution: WorkflowExecution): Promise<void>;
  get(executionId: string): Promise<WorkflowExecution | undefined>;
  save(execution: WorkflowExecution, expectedRevision: number): Promise<number>;
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

  async save(execution: WorkflowExecution, expectedRevision: number): Promise<number> {
    const nextRevision = expectedRevision + 1;
    const snapshot = { ...execution, revision: nextRevision };
    const result = await this.db.query(
      `UPDATE a2wf_executions
       SET workflow_id=$2, workflow_version=$3, tenant_id=$4, status=$5,
           revision=$6, execution=$7::jsonb, updated_at=$8
       WHERE execution_id=$1 AND revision=$9`,
      [execution.id, execution.workflowId, execution.workflowVersion,
        execution.identity.tenantId ?? null, execution.status, nextRevision,
        JSON.stringify(snapshot), execution.updatedAt, expectedRevision]
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
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2wf_executions_tenant_status
  ON a2wf_executions (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2wf_executions_workflow
  ON a2wf_executions (workflow_id, workflow_version, created_at DESC);
`;
