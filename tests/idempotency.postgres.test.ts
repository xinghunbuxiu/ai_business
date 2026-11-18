import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  IDEMPOTENCY_POSTGRES_MIGRATION,
  PostgresIdempotencyStore,
  type IdempotencySqlExecutor
} from "../src/idempotency.js";
import type { RuntimeResult } from "../src/types.js";

const databaseUrl = process.env.A2API_TEST_DATABASE_URL;
const postgresDescribe = describe.skipIf(!databaseUrl);

postgresDescribe("PostgresIdempotencyStore (real PostgreSQL)", () => {
  let pool: Pool;
  let store: PostgresIdempotencyStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 20 });
    await pool.query(IDEMPOTENCY_POSTGRES_MIGRATION);
    const executor: IdempotencySqlExecutor = {
      async query<T extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
        const result = await pool.query(sql, [...parameters]);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      }
    };
    store = new PostgresIdempotencyStore(executor);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE a2api_idempotency");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("allows exactly one concurrent reservation for a tenant-scoped key", async () => {
    const key = "tenant:merchant-42:employee.create@1.0.0:concurrent";
    const fingerprint = "a".repeat(64);
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => store.reserve(key, fingerprint, 3600))
    );

    expect(claims.filter(claim => claim.status === "acquired")).toHaveLength(1);
    expect(claims.filter(claim => claim.status === "in_progress")).toHaveLength(19);
    expect(await store.reserve(key, "b".repeat(64), 3600)).toEqual({ status: "conflict" });
  });

  it("replays the committed result across independent store instances", async () => {
    const key = "tenant:merchant-42:employee.create@1.0.0:replay";
    const fingerprint = "c".repeat(64);
    const firstStore = store;
    const secondStore = new PostgresIdempotencyStore({
      async query<T extends Record<string, unknown>>(sql: string, parameters: readonly unknown[] = []) {
        const result = await pool.query(sql, [...parameters]);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      }
    });
    expect(await firstStore.reserve(key, fingerprint, 3600)).toEqual({ status: "acquired" });
    const result: RuntimeResult = {
      protocolVersion: "1.0.0",
      success: true,
      requestId: "request-1",
      traceId: "trace-1",
      capability: "employee.create",
      data: { employeeId: "emp-1" },
      effects: ["employee.created"]
    };
    await firstStore.complete(key, fingerprint, result);
    expect(await secondStore.reserve(key, fingerprint, 3600)).toEqual({ status: "completed", result });
  });

  it("converts expired in-progress claims to durable UNKNOWN tombstones", async () => {
    const key = "tenant:merchant-42:employee.create@1.0.0:stale";
    const fingerprint = "d".repeat(64);
    expect(await store.reserve(key, fingerprint, 60)).toEqual({ status: "acquired" });
    await pool.query(
      "UPDATE a2api_idempotency SET expires_at = NOW() - INTERVAL '1 second' WHERE scope_key = $1",
      [key]
    );

    expect(await store.reserve(key, fingerprint, 3600)).toEqual({ status: "unknown" });
    expect(await store.reserve(key, fingerprint, 3600)).toEqual({ status: "unknown" });
    expect(await store.deleteExpired(new Date(Date.now() + 60_000))).toBe(0);
    const row = await pool.query("SELECT state FROM a2api_idempotency WHERE scope_key = $1", [key]);
    expect(row.rows[0]?.state).toBe("unknown");
  });

  it("cleans expired completed rows and permits a fresh reservation after retention", async () => {
    const key = "tenant:merchant-42:employee.create@1.0.0:retention";
    const fingerprint = "e".repeat(64);
    expect(await store.reserve(key, fingerprint, 3600)).toEqual({ status: "acquired" });
    const result: RuntimeResult = {
      protocolVersion: "1.0.0",
      success: true,
      requestId: "request-2",
      traceId: "trace-2",
      capability: "employee.create",
      data: { employeeId: "emp-2" },
      effects: ["employee.created"]
    };
    await store.complete(key, fingerprint, result);
    await pool.query(
      "UPDATE a2api_idempotency SET expires_at = NOW() - INTERVAL '1 second' WHERE scope_key = $1",
      [key]
    );

    expect(await store.deleteExpired(new Date(Date.now() + 60_000))).toBe(1);
    expect(await store.reserve(key, fingerprint, 3600)).toEqual({ status: "acquired" });
  });
});
