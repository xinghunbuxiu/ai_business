import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { AssetRegistry, ExecutionRuntime, type A2APICapability, type Identity } from "../src/index.js";
import {
  mapCapabilityContractToRegistryAsset,
  type CapabilityContract
} from "../src/a2api-contract-adapter.js";
import { adaptRuntimeResultToSassWire } from "../src/a2api-wire-adapter.js";
import type { RuntimeResult } from "../src/types.js";
import type { IdempotencyStore, IdempotencyReservation } from "../src/idempotency.js";

const corpus = JSON.parse(readFileSync(
  new URL("../protocols/a2api/1.0.0/conformance/vectors.json", import.meta.url),
  "utf8"
)) as { cases: Array<Record<string, any>> };


const corpusBytes = readFileSync(new URL("../protocols/a2api/1.0.0/conformance/vectors.json", import.meta.url));
const corpusSha256 = createHash("sha256").update(corpusBytes).digest("hex");
const executedRuntimeVectorIds: string[] = [];

afterAll(() => {
  const runtimeVectors = corpus.cases.filter(vector => vector.runner === "runtime-contract");
  const report = {
    reportVersion: "1.0.0",
    protocol: "A2API",
    protocolVersion: "1.0.0",
    runtime: "ai_business.ExecutionRuntime",
    adapter: "sass-capability-contract-to-registry-asset + sass-invocation-result-wire",
    adapterCommitSha: process.env.GITHUB_SHA ?? "local",
    corpus: {
      path: "protocols/a2api/1.0.0/conformance/vectors.json",
      sha256: corpusSha256
    },
    generatedAt: new Date().toISOString(),
    summary: {
      total: runtimeVectors.length,
      passed: executedRuntimeVectorIds.length,
      notExecuted: runtimeVectors.length - executedRuntimeVectorIds.length
    },
    vectors: runtimeVectors.map(vector => ({
      id: vector.id,
      status: executedRuntimeVectorIds.includes(vector.id) ? "passed" : "not_executed"
    }))
  };
  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/a2api-runtime-conformance.json", JSON.stringify(report, null, 2) + "\n");
});

function contract(permissions: string[], idempotencyRequired = false, timeoutMs = 5000): CapabilityContract {
  return {
    protocolVersion: "1.0.0",
    id: "employee.lookup",
    version: "1.0.0",
    provider: { id: "shared-conformance", runtime: "node", contractVersion: "1.0.0", handler: "test.lookup" },
    operation: { id: "employee.lookup", kind: "query" },
    input: { schema: { type: "object", properties: { mobile: { type: "string" } }, additionalProperties: false } },
    output: { schema: { type: "object", properties: { employeeId: { type: "string" } }, additionalProperties: false } },
    security: {
      authentication: { required: true },
      tenant: { mode: "required", scope: "merchant" },
      permissions
    },
    execution: {
      effect: "read",
      risk: "low",
      destructive: false,
      timeoutMs,
      idempotency: { mode: idempotencyRequired ? "required" : "unsupported", ...(idempotencyRequired ? { keyScope: "tenant" as const } : {}) },
      retry: { maxAttempts: 1, backoff: "none" }
    },
    errors: [],
    audit: { required: false, record: [] }
  };
}

function makeRuntime(permissions: string[], idempotencyStore?: IdempotencyStore, idempotencyRequired = false, adapterBehavior: "success" | "timeout" | "wait-for-abort" = "success", timeoutMs = 5000) {
  const mapped = mapCapabilityContractToRegistryAsset(contract(permissions, idempotencyRequired, timeoutMs), {
    name: "Shared runtime conformance capability",
    visibility: "system",
    roles: ["merchant_owner"],
    adapter: "shared-conformance",
    operation: "employee.lookup",
    idempotencyKeyFrom: "request.idempotencyKey",
    tenantScopeBinding: "host-tenant-context",
    hostEnforcedAuditRequired: false
  });
  const registry = new AssetRegistry();
  const asset = {
    ...mapped.asset,
    testEvidence: { suite: "shared-runtime-conformance", passed: 1, failed: 0 }
  } as A2APICapability;
  registry.register(asset);
  registry.publish(asset.id, asset.version);

  const runtime = new ExecutionRuntime(registry, undefined, { idempotencyStore });
  let providerDispatchCount = 0;
  let abortObserved = false;
  let lateCompletion = false;
  runtime.registerAdapter("shared-conformance", async (_input, context) => {
    providerDispatchCount += 1;
    if (adapterBehavior === "timeout") throw new Error("ADAPTER_TIMEOUT");
    if (adapterBehavior === "wait-for-abort") {
      return new Promise(resolve => {
        context.signal?.addEventListener("abort", () => {
          abortObserved = true;
          lateCompletion = true;
          resolve({ employeeId: "late-after-timeout" });
        }, { once: true });
      });
    }
    return { employeeId: "emp-1" };
  });
  return {
    runtime,
    getProviderDispatchCount: () => providerDispatchCount,
    getAbortObserved: () => abortObserved,
    getLateCompletion: () => lateCompletion
  };
}


class VectorIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { fingerprint: string; status: "in_progress" | "completed" | "unknown"; result?: RuntimeResult }>();

  async reserve(key: string, fingerprint: string): Promise<IdempotencyReservation> {
    const current = this.records.get(key);
    if (!current) {
      this.records.set(key, { fingerprint, status: "in_progress" });
      return { status: "acquired" };
    }
    if (current.fingerprint !== fingerprint) return { status: "conflict" };
    if (current.status === "unknown") return { status: "unknown" };
    if (current.status === "completed" && current.result) return { status: "completed", result: current.result };
    return { status: "in_progress" };
  }

  async complete(key: string, fingerprint: string, result: RuntimeResult): Promise<void> {
    const current = this.records.get(key);
    if (!current || current.fingerprint !== fingerprint || current.status !== "in_progress") {
      throw new Error("IDEMPOTENCY_COMPLETION_REJECTED");
    }
    current.status = "completed";
    current.result = result;
  }

  async release(key: string, fingerprint: string): Promise<void> {
    const current = this.records.get(key);
    if (current?.fingerprint === fingerprint && current.status === "in_progress") this.records.delete(key);
  }

  async markUnknown(key: string, fingerprint: string): Promise<void> {
    const current = this.records.get(key);
    if (current?.fingerprint === fingerprint && current.status === "in_progress") current.status = "unknown";
  }

  seedUnknown(key: string, fingerprint: string): void {
    this.records.set(key, { fingerprint, status: "unknown" });
  }
}

describe("A2API shared runtime conformance vectors", () => {
  it("executes shared security vectors through the registry adapter and runtime", async () => {
    const runtimeVectors = corpus.cases.filter(
      vector => vector.runner === "runtime-contract" && ["security", "runtime-audit", "execution", "idempotency"].includes(vector.area)
    );
    const executed: string[] = [];

    for (const vector of runtimeVectors) {
      if (!["SEC-TENANT-001", "SEC-PERMISSION-001", "AUDIT-REQUIRED-001", "EXEC-TIMEOUT-001", "EXEC-IDEMPOTENCY-001", "EXEC-IDEMPOTENCY-002", "EXEC-IDEMPOTENCY-003"].includes(vector.id)) {
        throw new Error("Unimplemented shared runtime vector: " + vector.id);
      }



      if (vector.id === "EXEC-TIMEOUT-001") {
        const { runtime, getProviderDispatchCount, getAbortObserved, getLateCompletion } =
          makeRuntime([], undefined, false, "wait-for-abort", 25);
        const identity: Identity = {
          userId: "user:7", tenantId: "merchant:42", roles: ["merchant_owner"], permissions: []
        };
        const runtimeResult = await runtime.execute(
          "employee.lookup", { mobile: "13800000000" }, identity,
          { requestId: "req-" + vector.id, traceId: "trace-" + vector.id, capabilityVersion: "1.0.0" }
        );
        const wire = adaptRuntimeResultToSassWire(runtimeResult, {
          invocationId: "123e4567-e89b-12d3-a456-426614174000",
          capabilityVersion: "1.0.0",
          identity
        });
        expect((wire.result as { error?: { code?: string } }).error?.code, vector.id).toBe(vector.expect.code);
        expect(getProviderDispatchCount() > 0, vector.id).toBe(vector.expect.providerDispatched);
        expect(getAbortObserved(), vector.id).toBe(true);
        expect(getLateCompletion(), vector.id).toBe(true);
        executed.push(vector.id);
        executedRuntimeVectorIds.push(vector.id);
        continue;
      }

      if (vector.area === "idempotency") {
        const store = new VectorIdempotencyStore();
        const key = "idem-" + vector.id;
        if (vector.id === "EXEC-IDEMPOTENCY-003") {
          const identity: Identity = { userId: "user:7", tenantId: "merchant:42", roles: ["merchant_owner"], permissions: [] };
          const first = makeRuntime([], store, true, "timeout");
          const firstResult = await first.runtime.execute(
            "employee.lookup", { mobile: "13800000000" }, identity,
            { requestId: "req-" + vector.id + "-first", traceId: "trace-" + vector.id, idempotencyKey: key, capabilityVersion: "1.0.0" }
          );
          expect(firstResult.success, vector.id).toBe(false);
          if (!firstResult.success) expect(firstResult.error.code).toBe("TIMEOUT");

          const second = makeRuntime([], store, true);
          const result = await second.runtime.execute(
            "employee.lookup", { mobile: "13800000000" }, identity,
            { requestId: "req-" + vector.id + "-retry", traceId: "trace-" + vector.id, idempotencyKey: key, capabilityVersion: "1.0.0" }
          );
          const wire = adaptRuntimeResultToSassWire(result, {
            invocationId: "123e4567-e89b-12d3-a456-426614174000",
            capabilityVersion: "1.0.0",
            identity
          });
          expect((wire.result as { error?: { code?: string } }).error?.code, vector.id).toBe(vector.expect.code);
          expect(first.getProviderDispatchCount() + second.getProviderDispatchCount(), vector.id).toBe(vector.expect.providerDispatchCount);
          executed.push(vector.id);
          continue;
        }

        const first = makeRuntime([], store, true);
        const identity: Identity = { userId: "user:7", tenantId: "merchant:42", roles: ["merchant_owner"], permissions: [] };
        const firstResult = await first.runtime.execute(
          "employee.lookup", { mobile: "13800000000" }, identity,
          { requestId: "req-" + vector.id + "-first", traceId: "trace-" + vector.id, idempotencyKey: key, capabilityVersion: "1.0.0" }
        );
        expect(firstResult.success, vector.id).toBe(true);

        const second = makeRuntime([], store, true);
        const secondInput = vector.id === "EXEC-IDEMPOTENCY-002"
          ? { mobile: "13900000000" }
          : { mobile: "13800000000" };
        const secondResult = await second.runtime.execute(
          "employee.lookup", secondInput, identity,
          { requestId: "req-" + vector.id + "-second", traceId: "trace-" + vector.id, idempotencyKey: key, capabilityVersion: "1.0.0" }
        );
        if (vector.id === "EXEC-IDEMPOTENCY-001") {
          expect(secondResult).toEqual(firstResult);
          expect(first.getProviderDispatchCount() + second.getProviderDispatchCount(), vector.id).toBe(vector.expect.providerDispatchCount);
        } else {
          const wire = adaptRuntimeResultToSassWire(secondResult, {
            invocationId: "123e4567-e89b-12d3-a456-426614174000",
            capabilityVersion: "1.0.0",
            identity
          });
          expect((wire.result as { error?: { code?: string } }).error?.code, vector.id).toBe(vector.expect.code);
          expect(first.getProviderDispatchCount() + second.getProviderDispatchCount(), vector.id).toBe(vector.expect.providerDispatchCount);
        }
        executed.push(vector.id);
        continue;
      }

      if (vector.id === "AUDIT-REQUIRED-001") {
        const { runtime, getProviderDispatchCount } = makeRuntime([]);
        const identity: Identity = {
          userId: "user:7",
          tenantId: "merchant:42",
          roles: ["merchant_owner"],
          permissions: []
        };
        const runtimeResult: RuntimeResult = await runtime.execute(
          "employee.lookup",
          { mobile: "13800000000" },
          identity,
          { requestId: "req-" + vector.id, traceId: "trace-" + vector.id, capabilityVersion: "1.0.0" }
        );
        const wire = adaptRuntimeResultToSassWire(runtimeResult, {
          invocationId: "123e4567-e89b-12d3-a456-426614174000",
          capabilityVersion: "1.0.0",
          identity,
          auditRequired: true
        });
        expect(wire.result.ok, vector.id).toBe(false);
        expect((wire.result as { error?: { code?: string } }).error?.code, vector.id).toBe(vector.expect.code);
        expect(getProviderDispatchCount(), vector.id).toBe(1);
        executed.push(vector.id);
        continue;
      }

      const missingTenant = vector.id === "SEC-TENANT-001";
      const requiredPermissions = vector.id === "SEC-PERMISSION-001" ? ["employee:read"] : [];
      const { runtime, getProviderDispatchCount } = makeRuntime(requiredPermissions);
      const identity: Identity = {
        userId: "user:7",
        ...(missingTenant ? {} : { tenantId: "merchant:42" }),
        roles: ["merchant_owner"],
        permissions: []
      };

      const runtimeResult: RuntimeResult = await runtime.execute(
        "employee.lookup",
        { mobile: "13800000000" },
        identity,
        { requestId: "req-" + vector.id, traceId: "trace-" + vector.id, capabilityVersion: "1.0.0" }
      );
      const wire = adaptRuntimeResultToSassWire(runtimeResult, {
        invocationId: "123e4567-e89b-12d3-a456-426614174000",
        capabilityVersion: "1.0.0",
        identity
      });

      expect(wire.result.ok, vector.id).toBe(false);
      expect((wire.result as { error?: { code?: string } }).error?.code, vector.id).toBe(vector.expect.code);
      expect(getProviderDispatchCount(), vector.id).toBe(0);
      expect(vector.expect.providerDispatched ?? false, vector.id).toBe(false);
      executed.push(vector.id);
    }

    expect(executed).toEqual(runtimeVectors.map(vector => vector.id));
  });
});
