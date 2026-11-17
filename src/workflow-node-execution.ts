import { createHash, randomUUID } from "node:crypto";
import type { WorkflowExecution } from "./workflow.js";
import type { WorkflowSqlExecutor } from "./workflow-repository.js";

export type WorkflowNodeAttemptStatus = "running" | "succeeded" | "failed" | "unknown";
export type WorkflowNodeAttemptRef = { attemptId: string; attempt: number };
export interface WorkflowNodeExecutionStore {
  start(execution: WorkflowExecution, nodeId: string, input: unknown): Promise<WorkflowNodeAttemptRef>;
  finish(ref: WorkflowNodeAttemptRef, status: Exclude<WorkflowNodeAttemptStatus, "running">, output?: unknown, errorCode?: string): Promise<void>;
}
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");

/** Append-oriented per-node attempt ledger. Payloads are never stored, only hashes and bounded error codes. */
export class PostgresWorkflowNodeExecutionStore implements WorkflowNodeExecutionStore {
  constructor(private readonly db: WorkflowSqlExecutor) {}

  async start(execution: WorkflowExecution, nodeId: string, input: unknown): Promise<WorkflowNodeAttemptRef> {
    if (!nodeId || nodeId.length > 128) throw new Error("WORKFLOW_NODE_ID_INVALID");
    const attemptId = randomUUID();
    const result = await this.db.query<{ attempt: number }>(
      `INSERT INTO a2wf_node_attempts
       (attempt_id, execution_id, workflow_id, workflow_version, node_id, attempt, status, input_sha256, started_at)
       SELECT $1,$2,$3,$4,$5,COALESCE(MAX(attempt),0)+1,'running',$6,NOW()
       FROM a2wf_node_attempts WHERE execution_id=$2 AND node_id=$5
       RETURNING attempt`,
      [attemptId, execution.id, execution.workflowId, execution.workflowVersion, nodeId, digest(input)]
    );
    const attempt = Number(result.rows[0]?.attempt);
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error("WORKFLOW_NODE_ATTEMPT_CREATE_FAILED");
    return { attemptId, attempt };
  }

  async finish(ref: WorkflowNodeAttemptRef, status: Exclude<WorkflowNodeAttemptStatus, "running">, output?: unknown, errorCode?: string): Promise<void> {
    if (!["succeeded", "failed", "unknown"].includes(status)) throw new Error("WORKFLOW_NODE_ATTEMPT_STATUS_INVALID");
    const safeCode = errorCode?.slice(0, 128);
    const result = await this.db.query(
      `UPDATE a2wf_node_attempts SET status=$2, output_sha256=$3, error_code=$4, finished_at=NOW()
       WHERE attempt_id=$1 AND status='running'`,
      [ref.attemptId, status, output === undefined ? null : digest(output), safeCode ?? null]
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("WORKFLOW_NODE_ATTEMPT_FINALIZE_CONFLICT");
  }
}

export const WORKFLOW_NODE_ATTEMPTS_POSTGRES_MIGRATION = `
CREATE TABLE IF NOT EXISTS a2wf_node_attempts (
  attempt_id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES a2wf_executions(execution_id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
  input_sha256 CHAR(64) NOT NULL,
  output_sha256 CHAR(64),
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  UNIQUE (execution_id, node_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_a2wf_node_attempts_execution
  ON a2wf_node_attempts (execution_id, started_at);
CREATE INDEX IF NOT EXISTS idx_a2wf_node_attempts_status
  ON a2wf_node_attempts (status, started_at) WHERE status IN ('running','unknown');
`;
