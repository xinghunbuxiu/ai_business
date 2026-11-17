import { describe, expect, it } from "vitest";
import { AssetRegistry, ExecutionRuntime, type A2APICapability, type A2APIAuditRecord, PostgresAuditStore, AUDIT_POSTGRES_MIGRATION } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion: "1.0", protocolVersion: "1.0.0", id: "employee.create", version: "1.0.0",
  kind: "a2api", name: "Create employee", status: "draft", visibility: "system",
  permissions: ["employee:create"], dependencies: [],
  inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  outputSchema: { type: "object", required: ["employeeId"], properties: { employeeId: { type: "string" } } },
  errors: [], auth: { roles: ["merchant_owner"], tenantRequired: true }, preconditions: [], effects: ["employee.created"],
  mapping: { adapter: "employee", operation: "create", timeoutMs: 1000 },
  idempotency: { required: true, keyFrom: "request.idempotencyKey" },
  testEvidence: { suite: "unit", passed: 1, failed: 0 }
};
function registry() { const r = new AssetRegistry(); r.register(capability); r.publish(capability.id, capability.version); return r; }

describe("A2API audit", () => {
  it("persists start and success records with tenant and actor metadata but no input payload", async () => {
    const records: A2APIAuditRecord[] = [];
    const runtime = new ExecutionRuntime(registry(), undefined, { auditStore: { async append(record) { records.push(record); } } });
    runtime.registerAdapter("employee", async () => ({ employeeId: "e-1" }));
    const result = await runtime.execute("employee.create", { name: "private-name" }, {
      userId: "user-7", tenantId: "tenant-2", roles: ["merchant_owner"], permissions: ["employee:create"]
    }, { idempotencyKey: "audit-1", capabilityVersion: "1.0.0", appId: "merchant.app" });
    expect(result.success).toBe(true);
    expect(records.map(record => record.outcome)).toEqual(["started", "succeeded"]);
    expect(records[0]).toMatchObject({ tenantId: "tenant-2", actorId: "user-7", appId: "merchant.app", capabilityId: "employee.create" });
    expect(JSON.stringify(records)).not.toContain("private-name");
  });

  it("fails closed before invoking a business adapter when start audit cannot be written", async () => {
    const runtime = new ExecutionRuntime(registry(), undefined, { auditStore: { async append() { throw new Error("database offline"); } } });
    let invoked = false;
    runtime.registerAdapter("employee", async () => { invoked = true; return { employeeId: "e-1" }; });
    const result = await runtime.execute("employee.create", { name: "Alex" }, {
      userId: "user-7", tenantId: "tenant-2", roles: ["merchant_owner"], permissions: ["employee:create"]
    }, { idempotencyKey: "audit-fail", capabilityVersion: "1.0.0" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("AUDIT_PERSISTENCE_FAILED");
    expect(invoked).toBe(false);
  });

  it("writes parameterized append-only audit rows and exposes migration", async () => {
    let statement = "";
    let parameters: readonly unknown[] = [];
    const store = new PostgresAuditStore({ async query(sql, values = []) { statement = sql; parameters = values; return { rows: [], rowCount: 1 }; } });
    await store.append({ eventType: "execution.started", occurredAt: new Date().toISOString(), tenantId: "t", metadata: { safe: true } });
    expect(statement).toContain("INSERT INTO a2api_audit_events");
    expect(parameters).toContain("execution.started");
    expect(AUDIT_POSTGRES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS a2api_audit_events");
  });
});
