import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_POSTGRES_MIGRATION,
  PostgresIdempotencyStore,
  type IdempotencySqlExecutor,
  type IdempotencyStore,
  type IdempotencyReservation
} from "../src/idempotency.js";
import { AssetRegistry, ExecutionRuntime, type A2APICapability, type RuntimeResult } from "../src/index.js";

class FakePostgres implements IdempotencySqlExecutor {
  records = new Map<string, { fingerprint: string; state: "in_progress" | "completed"; result: RuntimeResult | null; expires_at: string }>();

  async query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const key = String(params[0]);
    if (sql.includes("INSERT INTO a2api_idempotency")) {
      if (this.records.has(key)) return { rows: [], rowCount: 0 };
      this.records.set(key, {
        fingerprint: String(params[1]), state: "in_progress", result: null,
        expires_at: new Date(Date.now() + Number(params[2]) * 1000).toISOString()
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT fingerprint")) {
      const row = this.records.get(key);
      return { rows: row ? [row as unknown as T] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes("UPDATE a2api_idempotency")) {
      const row = this.records.get(key);
      if (!row || row.fingerprint !== params[1] || row.state !== "in_progress") return { rows: [], rowCount: 0 };
      row.state = "completed";
      row.result = JSON.parse(String(params[2])) as RuntimeResult;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM a2api_idempotency")) {
      const row = this.records.get(key);
      if (!sql.includes("expires_at <= $1") && row && row.fingerprint === params[1] && row.state === "in_progress") {
        this.records.delete(key);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("expires_at <= $1")) {
        let removed = 0;
        for (const [recordKey, record] of this.records) {
          if (new Date(record.expires_at) <= new Date(params[0] as Date)) { this.records.delete(recordKey); removed++; }
        }
        return { rows: [], rowCount: removed };
      }
      return { rows: [], rowCount: 0 };
    }
    throw new Error("Unexpected SQL: " + sql);
  }
}

class SharedMemoryStore implements IdempotencyStore {
  records = new Map<string, { fingerprint: string; result?: RuntimeResult }>();
  async reserve(key: string, fingerprint: string): Promise<IdempotencyReservation> {
    const current = this.records.get(key);
    if (!current) { this.records.set(key, { fingerprint }); return { status: "acquired" }; }
    if (current.fingerprint !== fingerprint) return { status: "conflict" };
    return current.result ? { status: "completed", result: current.result } : { status: "in_progress" };
  }
  async complete(key: string, fingerprint: string, result: RuntimeResult) {
    const current = this.records.get(key);
    if (!current || current.fingerprint !== fingerprint) throw new Error("reservation missing");
    current.result = result;
  }
  async release(key: string, fingerprint: string) {
    if (this.records.get(key)?.fingerprint === fingerprint) this.records.delete(key);
  }
}

const capability: A2APICapability = {
  schemaVersion: "1.0", protocolVersion: "1.0.0", id: "invoice.create", version: "1.0.0",
  kind: "a2api", name: "Create invoice", status: "draft", visibility: "system",
  permissions: ["invoice:create"], dependencies: [],
  inputSchema: { type: "object", required: ["amount"], properties: { amount: { type: "number" } } },
  outputSchema: { type: "object", required: ["invoiceId"], properties: { invoiceId: { type: "string" } } },
  errors: [], auth: { roles: ["merchant_owner"], tenantRequired: true }, preconditions: [],
  effects: ["invoice.created"], mapping: { adapter: "invoice", operation: "create", timeoutMs: 1000 },
  idempotency: { required: true, keyFrom: "request.idempotencyKey" },
  testEvidence: { suite: "unit", passed: 1, failed: 0 }
};
function registry() { const r = new AssetRegistry(); r.register(capability); r.publish(capability.id, capability.version); return r; }

describe("PostgresIdempotencyStore", () => {
  it("atomically reserves keys, rejects fingerprint changes and replays completed results", async () => {
    const db = new FakePostgres();
    const store = new PostgresIdempotencyStore(db);
    expect(await store.reserve("tenant-a:invoice.create@1.0.0:key-1", "a".repeat(64), 3600)).toEqual({ status: "acquired" });
    expect(await store.reserve("tenant-a:invoice.create@1.0.0:key-1", "a".repeat(64), 3600)).toEqual({ status: "in_progress" });
    expect(await store.reserve("tenant-a:invoice.create@1.0.0:key-1", "b".repeat(64), 3600)).toEqual({ status: "conflict" });
    const result: RuntimeResult = { protocolVersion: "1.0.0", success: true, requestId: "r", traceId: "t", capability: "invoice.create", data: { invoiceId: "i-1" }, effects: ["invoice.created"] };
    await store.complete("tenant-a:invoice.create@1.0.0:key-1", "a".repeat(64), result);
    expect(await store.reserve("tenant-a:invoice.create@1.0.0:key-1", "a".repeat(64), 3600)).toEqual({ status: "completed", result });
  });

  it("provides an expiry cleanup migration and validates retention policy", async () => {
    expect(IDEMPOTENCY_POSTGRES_MIGRATION).toContain("CREATE TABLE IF NOT EXISTS a2api_idempotency");
    const store = new PostgresIdempotencyStore(new FakePostgres());
    await expect(store.reserve("k", "a".repeat(64), 10)).rejects.toThrow(/IDEMPOTENCY_TTL_INVALID/);
  });
});

describe("ExecutionRuntime durable idempotency", () => {
  it("replays across Runtime instances and prevents a changed payload from reusing the key", async () => {
    const store = new SharedMemoryStore();
    let calls = 0;
    const firstRuntime = new ExecutionRuntime(registry(), undefined, { idempotencyStore: store });
    firstRuntime.registerAdapter("invoice", async () => ({ invoiceId: "invoice-1", call: ++calls }));
    const identity = { userId: "u1", tenantId: "tenant-a", roles: ["merchant_owner"], permissions: ["invoice:create"] };
    const first = await firstRuntime.execute("invoice.create", { amount: 10 }, identity, { idempotencyKey: "same", capabilityVersion: "1.0.0" });

    const secondRuntime = new ExecutionRuntime(registry(), undefined, { idempotencyStore: store });
    secondRuntime.registerAdapter("invoice", async () => ({ invoiceId: "invoice-2", call: ++calls }));
    const replay = await secondRuntime.execute("invoice.create", { amount: 10 }, identity, { idempotencyKey: "same", capabilityVersion: "1.0.0" });
    const conflict = await secondRuntime.execute("invoice.create", { amount: 20 }, identity, { idempotencyKey: "same", capabilityVersion: "1.0.0" });
    expect(replay).toEqual(first);
    expect(conflict.success).toBe(false);
    if (!conflict.success) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(calls).toBe(1);
  });
});
