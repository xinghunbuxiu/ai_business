import { describe, expect, it } from "vitest";
import {
  adaptSassInvocationToRuntime,
  adaptRuntimeResultToSassWire,
  type SassA2ApiAuditEvidence
} from "../src/a2api-wire-adapter.js";
import type { Identity, RuntimeResult } from "../src/types.js";

const identity: Identity = {
  userId: "user:7",
  tenantId: "merchant:42",
  roles: ["merchant_owner"],
  permissions: ["employee:read"]
};
const wireInvocation = (context: Record<string, unknown> = {}) => ({
  protocolVersion: "1.0.0",
  invocationId: "123e4567-e89b-12d3-a456-426614174000",
  capability: { id: "employee.lookup", version: "1.2.0" },
  context: { principalId: "user:7", tenantId: "merchant:42", requestId: "req-1", correlationId: "trace-1", idempotencyKey: "idem-1", ...context },
  input: { employeeId: "emp-1" }
});
const success: RuntimeResult = {
  protocolVersion: "1.0.0", success: true, requestId: "req-1", traceId: "trace-1",
  capability: "employee.lookup", data: { employeeId: "emp-1" }, effects: ["employee.read"]
};
const auditEvidence: SassA2ApiAuditEvidence = {
  auditId: "fw-audit:555",
  capability: { id: "employee.lookup", version: "1.2.0" },
  invocationId: "123e4567-e89b-12d3-a456-426614174000",
  principalId: "user:7",
  tenantId: "merchant:42",
  outcome: "success",
  startedAt: "2026-11-18T00:00:00.000Z",
  completedAt: "2026-11-18T00:00:01.000Z"
};

describe("A2API Invocation/Result wire adapter", () => {
  it("injects trusted app identity and maps request/correlation/idempotency fields without conflation", () => {
    const adapted = adaptSassInvocationToRuntime(wireInvocation(), { identity, appId: "employee-app" });
    expect(adapted.invocation).toMatchObject({
      capabilityId: "employee.lookup", capabilityVersion: "1.2.0",
      requestId: "req-1", traceId: "trace-1", appId: "employee-app", idempotencyKey: "idem-1"
    });
    expect(adapted.invocation).not.toHaveProperty("invocationId");
    expect(adapted.invocationId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(adapted.provenance.sourceInvocationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects caller-controlled principal and tenant identity assertions", () => {
    expect(() => adaptSassInvocationToRuntime(wireInvocation({ principalId: "user:999" }), { identity, appId: "employee-app" }))
      .toThrow(/A2API_WIRE_PRINCIPAL_MISMATCH/);
    expect(() => adaptSassInvocationToRuntime(wireInvocation({ tenantId: "merchant:999" }), { identity, appId: "employee-app" }))
      .toThrow(/A2API_WIRE_TENANT_MISMATCH/);
  });

  it("does not conflate requestId with traceId when no correlation ID is supplied", () => {
    const adapted = adaptSassInvocationToRuntime(wireInvocation({ correlationId: undefined }), {
      identity, appId: "employee-app", 
    }, { createTraceId: () => "generated-trace" });
    expect(adapted.invocation.requestId).toBe("req-1");
    expect(adapted.invocation.traceId).toBe("generated-trace");
  });

  it("rejects deadlines because this runtime cannot enforce a hard end-to-end deadline", () => {
    expect(() => adaptSassInvocationToRuntime(wireInvocation({ deadline: "2026-11-18T00:00:10.000Z" }), { identity, appId: "employee-app" }))
      .toThrow(/A2API_WIRE_DEADLINE_UNSUPPORTED/);
  });

  it("maps success output and preserves effects in a separate sidecar", () => {
    const adapted = adaptRuntimeResultToSassWire(success, {
      invocationId: "123e4567-e89b-12d3-a456-426614174000",
      capabilityVersion: "1.2.0",
      identity
    });
    expect(adapted.result).toMatchObject({ ok: true, output: { employeeId: "emp-1" } });
    expect(adapted.result).not.toHaveProperty("effects");
    expect(adapted.sidecar.effects).toEqual(["employee.read"]);
  });

  it("requires persisted audit evidence when the capability requires it", () => {
    const adapted = adaptRuntimeResultToSassWire(success, {
      invocationId: "123e4567-e89b-12d3-a456-426614174000",
      capabilityVersion: "1.2.0",
      identity,
      auditRequired: true
    });
    expect(adapted.result).toMatchObject({ ok: false, error: { code: "AUDIT_REQUIRED" } });
  });

  it("rejects audit evidence bound to another invocation or principal", () => {
    const adapted = adaptRuntimeResultToSassWire(success, {
      invocationId: "123e4567-e89b-12d3-a456-426614174000",
      capabilityVersion: "1.2.0",
      identity,
      auditEvidence: { ...auditEvidence, principalId: "user:999" }
    });
    expect(adapted.result).toMatchObject({ ok: false, error: { code: "AUDIT_IDENTITY_MISMATCH" } });
  });

  it("normalizes stable runtime errors to the Sass A2API error vocabulary", () => {
    const denied: RuntimeResult = {
      protocolVersion: "1.0.0", success: false, requestId: "req-1", traceId: "trace-1",
      capability: "employee.lookup",
      error: { code: "FORBIDDEN", message: "Missing permission", retryable: false }
    };
    const adapted = adaptRuntimeResultToSassWire(denied, {
      invocationId: "123e4567-e89b-12d3-a456-426614174000",
      capabilityVersion: "1.2.0",
      identity
    });
    expect(adapted.result).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED", retryable: false } });
  });

  it("attaches validated persisted audit evidence to the wire result", () => {
    const adapted = adaptRuntimeResultToSassWire(success, {
      invocationId: "123e4567-e89b-12d3-a456-426614174000",
      capabilityVersion: "1.2.0",
      identity,
      auditRequired: true,
      auditEvidence
    });
    expect(adapted.result).toMatchObject({ ok: true, audit: { auditId: "fw-audit:555", invocationId: "123e4567-e89b-12d3-a456-426614174000" } });
  });
});
