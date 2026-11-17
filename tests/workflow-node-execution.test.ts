import { describe, expect, it } from "vitest";
import {
  PostgresWorkflowNodeExecutionStore,
  WORKFLOW_NODE_ATTEMPTS_POSTGRES_MIGRATION,
  type WorkflowNodeAttemptRef
} from "../src/workflow-node-execution.js";
import type { WorkflowExecution } from "../src/workflow.js";
import type { WorkflowSqlExecutor } from "../src/workflow-repository.js";

class FakeNodeDb implements WorkflowSqlExecutor {
  rows = new Map<string, Record<string, unknown>>();
  async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes("INSERT INTO a2wf_node_attempts")) {
      const id = String(params[0]);
      const executionId = String(params[1]);
      const nodeId = String(params[4]);
      const attempt = [...this.rows.values()].filter(row => row.execution_id === executionId && row.node_id === nodeId).length + 1;
      this.rows.set(id, { attempt_id: id, execution_id: executionId, node_id: nodeId, attempt, status: "running", input_sha256: params[5] });
      return { rows: [{ attempt } as unknown as T], rowCount: 1 };
    }
    if (sql.includes("UPDATE a2wf_node_attempts")) {
      const row = this.rows.get(String(params[0]));
      if (!row || row.status !== "running") return { rows: [], rowCount: 0 };
      Object.assign(row, { status: params[1], output_sha256: params[2], error_code: params[3] });
      return { rows: [], rowCount: 1 };
    }
    throw new Error("Unexpected SQL: " + sql);
  }
}
const execution: WorkflowExecution = {
  id: "2dbb3d18-61e9-4a56-9b44-4db44c2a7b17", protocolVersion: "1.0.0",
  workflowId: "merchant.onboarding", workflowVersion: "1.0.0", appId: "merchant-console",
  status: "running", currentStepId: "create-account", triggerInput: {}, identity: { userId: "u1", tenantId: "t1", roles: [], permissions: [] },
  outputs: {}, history: [], createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z"
};

describe("PostgresWorkflowNodeExecutionStore", () => {
  it("records each attempt with hashes rather than raw payloads", async () => {
    const db = new FakeNodeDb();
    const store = new PostgresWorkflowNodeExecutionStore(db);
    const first = await store.start(execution, "create-account", { email: "private@example.com" });
    const second = await store.start(execution, "create-account", { email: "private@example.com" });
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    const row = db.rows.get(first.attemptId)!;
    expect(row.input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain("private@example.com");
  });

  it("finalizes an attempt once and rejects duplicate finalization", async () => {
    const db = new FakeNodeDb();
    const store = new PostgresWorkflowNodeExecutionStore(db);
    const ref: WorkflowNodeAttemptRef = await store.start(execution, "create-account", { amount: 12 });
    await store.finish(ref, "succeeded", { accountId: "a1" });
    expect(db.rows.get(ref.attemptId)?.status).toBe("succeeded");
    await expect(store.finish(ref, "failed", undefined, "LATE_ERROR")).rejects.toThrow("WORKFLOW_NODE_ATTEMPT_FINALIZE_CONFLICT");
  });

  it("supports failed and uncertain outcomes and defines recovery indexes", async () => {
    const db = new FakeNodeDb();
    const store = new PostgresWorkflowNodeExecutionStore(db);
    const failed = await store.start(execution, "charge", { cents: 100 });
    await store.finish(failed, "failed", undefined, "PAYMENT_DECLINED");
    const unknown = await store.start(execution, "charge", { cents: 100 });
    await store.finish(unknown, "unknown", undefined, "TIMEOUT");
    expect(db.rows.get(unknown.attemptId)?.status).toBe("unknown");
    expect(WORKFLOW_NODE_ATTEMPTS_POSTGRES_MIGRATION).toContain("UNIQUE (execution_id, node_id, attempt)");
    expect(WORKFLOW_NODE_ATTEMPTS_POSTGRES_MIGRATION).toContain("idx_a2wf_node_attempts_status");
  });
});
