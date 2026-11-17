import { describe, expect, it } from "vitest";
import {
  PostgresWorkflowExecutionRepository,
  WORKFLOW_POSTGRES_MIGRATION,
  type WorkflowSqlExecutor
} from "../src/workflow-repository.js";
import type { WorkflowExecution } from "../src/workflow.js";

class FakeWorkflowPostgres implements WorkflowSqlExecutor {
  rows = new Map<string, { execution: WorkflowExecution; revision: number }>();
  async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const id = String(params[0]);
    if (sql.includes("INSERT INTO a2wf_executions")) {
      if (this.rows.has(id)) return { rows: [], rowCount: 0 };
      const execution = JSON.parse(String(params[5])) as WorkflowExecution;
      this.rows.set(id, { execution, revision: 1 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT execution, revision")) {
      const row = this.rows.get(id);
      return { rows: row ? [{ execution: row.execution, revision: row.revision } as unknown as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE a2wf_executions")) {
      const row = this.rows.get(id);
      const expectedRevision = Number(params[8]);
      if (!row || row.revision !== expectedRevision) return { rows: [], rowCount: 0 };
      const execution = JSON.parse(String(params[6])) as WorkflowExecution;
      row.execution = execution;
      row.revision = Number(params[5]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error("Unexpected SQL: " + sql);
  }
}

const execution: WorkflowExecution = {
  id: "2dbb3d18-61e9-4a56-9b44-4db44c2a7b17",
  protocolVersion: "1.0.0",
  workflowId: "merchant.onboarding",
  workflowVersion: "1.0.0",
  appId: "merchant-console",
  status: "running",
  currentStepId: "collect-profile",
  triggerInput: { region: "north" },
  identity: { userId: "user-1", tenantId: "tenant-1", roles: ["merchant_owner"], permissions: [] },
  outputs: {},
  history: [],
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  revision: 1
};

describe("PostgresWorkflowExecutionRepository", () => {
  it("creates and reloads a durable execution snapshot", async () => {
    const db = new FakeWorkflowPostgres();
    const repository = new PostgresWorkflowExecutionRepository(db);
    await repository.create(execution);
    expect(await repository.get(execution.id)).toEqual(execution);
    await expect(repository.create(execution)).rejects.toThrow("WORKFLOW_EXECUTION_ALREADY_EXISTS");
  });

  it("uses optimistic revisions to reject stale writers", async () => {
    const db = new FakeWorkflowPostgres();
    const repository = new PostgresWorkflowExecutionRepository(db);
    await repository.create(execution);
    const loaded = await repository.get(execution.id);
    expect(loaded?.revision).toBe(1);
    const next = { ...loaded!, status: "awaiting_input" as const, updatedAt: "2026-11-17T00:01:00.000Z" };
    expect(await repository.save(next, 1)).toBe(2);
    await expect(repository.save({ ...next, status: "completed" }, 1)).rejects.toThrow("WORKFLOW_EXECUTION_CONFLICT");
    expect((await repository.get(execution.id))?.status).toBe("awaiting_input");
  });

  it("defines tenant/status and workflow lookup indexes", () => {
    expect(WORKFLOW_POSTGRES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS a2wf_executions");
    expect(WORKFLOW_POSTGRES_MIGRATION).toContain("idx_a2wf_executions_tenant_status");
  });
});
