import { describe, expect, it } from "vitest";
import { mapCapabilityContractToRegistryAsset } from "../src/a2api-contract-adapter.js";

const contract = () => ({
  protocolVersion: "1.0.0",
  id: "employee.lookup",
  version: "1.2.0",
  title: "Find employee",
  provider: { id: "hr-service", runtime: "java" as const, contractVersion: "1.0.0" as const, handler: "EmployeeProvider.lookup" },
  operation: { id: "lookup", kind: "query" as const, http: { method: "GET" as const, path: "/employees/{id}" } },
  input: { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
  output: { schema: { type: "object", required: ["employeeId"], properties: { employeeId: { type: "string" } }, additionalProperties: false } },
  security: { authentication: { required: true, schemes: ["session"] }, tenant: { mode: "required" as const, scope: "merchant" }, permissions: ["employee:read"] },
  execution: {
    effect: "read" as const, risk: "low" as const, destructive: false, timeoutMs: 8000,
    idempotency: { mode: "required" as const, keyScope: "tenant" as const },
    retry: { maxAttempts: 1, backoff: "none" as const, retryableErrors: [] as string[] }
  },
  errors: [{ code: "NOT_FOUND", message: "Employee not found", retryable: false }],
  audit: { required: false, record: ["capabilityId", "outcome"] }
});

const mapping = () => ({
  name: "Find employee",
  visibility: "system" as const,
  roles: ["merchant_owner", "store_manager"],
  adapter: "framework-integration",
  operation: "employee.lookup",
  idempotencyKeyFrom: "request.idempotencyKey",
  hostAuthenticationSchemes: ["session"],
  tenantScopeBinding: "merchant-id-to-tenant-id",
  hostEnforcedAuditRequired: false
});

describe("A2API contract to registry-asset adapter", () => {
  it("maps only explicitly bound fields and preserves source semantics as provenance", () => {
    const mapped = mapCapabilityContractToRegistryAsset(contract(), mapping());
    expect(mapped.asset).toMatchObject({
      schemaVersion: "1.0",
      protocolVersion: "1.0.0",
      id: "employee.lookup",
      version: "1.2.0",
      kind: "a2api",
      permissions: ["employee:read"],
      auth: { roles: ["merchant_owner", "store_manager"], tenantRequired: true },
      mapping: { adapter: "framework-integration", operation: "employee.lookup", timeoutMs: 8000 },
      idempotency: { required: true, keyFrom: "request.idempotencyKey" }
    });
    expect(mapped.asset.inputSchema).toEqual(contract().input.schema);
    expect(mapped.asset.outputSchema).toEqual(contract().output.schema);
    expect(mapped.provenance.sourceProvider.handler).toBe("EmployeeProvider.lookup");
    expect(mapped.provenance.sourceOperation.kind).toBe("query");
    expect(mapped.provenance.sourceExecution.effect).toBe("read");
    expect(mapped.provenance.sourceTenantScope).toBe("merchant");
    expect(mapped.provenance.sourceContractDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when source risk semantics are not representable", () => {
    const input = contract();
    input.execution.risk = "medium";
    expect(() => mapCapabilityContractToRegistryAsset(input, mapping())).toThrow(/A2API_MAPPING_RISK_UNREPRESENTABLE/);
  });

  it("requires explicit host bindings for source authentication schemes", () => {
    expect(() => mapCapabilityContractToRegistryAsset(contract(), {
      ...mapping(), hostAuthenticationSchemes: []
    })).toThrow(/A2API_MAPPING_AUTH_SCHEME_UNBOUND/);
  });

  it("rejects optional tenant mode because the target envelope cannot express it", () => {
    const input = contract();
    input.security.tenant.mode = "optional";
    expect(() => mapCapabilityContractToRegistryAsset(input, mapping())).toThrow(/A2API_MAPPING_UNSUPPORTED_TENANT_MODE/);
  });

  it("requires a host audit policy when source contract requires audit", () => {
    const input = contract();
    input.audit.required = true;
    expect(() => mapCapabilityContractToRegistryAsset(input, mapping())).toThrow(/A2API_MAPPING_AUDIT_POLICY_UNBOUND/);
    const mapped = mapCapabilityContractToRegistryAsset(input, { ...mapping(), hostEnforcedAuditRequired: true });
    expect(mapped.provenance.hostEnforcedAuditRequired).toBe(true);
  });

  it("rejects idempotency scopes the target runtime cannot implement", () => {
    const input = contract();
    input.execution.idempotency.keyScope = "principal";
    expect(() => mapCapabilityContractToRegistryAsset(input, mapping())).toThrow(/A2API_MAPPING_IDEMPOTENCY_SCOPE_UNSUPPORTED/);
  });

  it("rejects retry policies that would be silently lost", () => {
    const input = contract();
    input.execution.retry.maxAttempts = 2;
    input.execution.retry.backoff = "exponential";
    expect(() => mapCapabilityContractToRegistryAsset(input, mapping())).toThrow(/A2API_MAPPING_RETRY_UNSUPPORTED/);
  });

  it("requires tenant ownership metadata for tenant/private registry assets", () => {
    expect(() => mapCapabilityContractToRegistryAsset(contract(), {
      ...mapping(), visibility: "tenant"
    })).toThrow(/A2API_MAPPING_TENANT_REQUIRED/);
  });
});
