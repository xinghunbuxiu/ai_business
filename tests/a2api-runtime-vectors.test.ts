import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssetRegistry, ExecutionRuntime, type A2APICapability, type Identity } from "../src/index.js";
import {
  mapCapabilityContractToRegistryAsset,
  type CapabilityContract
} from "../src/a2api-contract-adapter.js";
import { adaptRuntimeResultToSassWire } from "../src/a2api-wire-adapter.js";
import type { RuntimeResult } from "../src/types.js";

const corpus = JSON.parse(readFileSync(
  new URL("../protocols/a2api/1.0.0/conformance/vectors.json", import.meta.url),
  "utf8"
)) as { cases: Array<Record<string, any>> };

function contract(permissions: string[]): CapabilityContract {
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
      timeoutMs: 5000,
      idempotency: { mode: "unsupported" },
      retry: { maxAttempts: 1, backoff: "none" }
    },
    errors: [],
    audit: { required: false, record: [] }
  };
}

function makeRuntime(permissions: string[]) {
  const mapped = mapCapabilityContractToRegistryAsset(contract(permissions), {
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

  const runtime = new ExecutionRuntime(registry);
  let providerDispatchCount = 0;
  runtime.registerAdapter("shared-conformance", async () => {
    providerDispatchCount += 1;
    return { employeeId: "emp-1" };
  });
  return { runtime, getProviderDispatchCount: () => providerDispatchCount };
}

describe("A2API shared runtime conformance vectors", () => {
  it("executes shared security vectors through the registry adapter and runtime", async () => {
    const runtimeVectors = corpus.cases.filter(
      vector => vector.runner === "runtime-contract" && ["security", "runtime-audit"].includes(vector.area)
    );
    const executed: string[] = [];

    for (const vector of runtimeVectors) {
      if (!["SEC-TENANT-001", "SEC-PERMISSION-001", "AUDIT-REQUIRED-001"].includes(vector.id)) {
        throw new Error("Unimplemented shared runtime vector: " + vector.id);
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
