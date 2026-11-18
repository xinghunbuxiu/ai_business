import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { A2APIInvocation, Identity, RuntimeResult } from "./types.js";

const SassInvocationSchema = z.object({
  protocolVersion: z.literal("1.0.0"),
  invocationId: z.string().uuid(),
  capability: z.object({ id: z.string().min(3), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/) }).strict(),
  context: z.object({
    principalId: z.string().min(1),
    tenantId: z.string().optional(),
    requestId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
    deadline: z.string().datetime().optional()
  }).strict(),
  input: z.unknown()
}).strict();

export type SassA2ApiInvocation = z.infer<typeof SassInvocationSchema>;
export type TrustedA2ApiHostContext = { identity: Identity; appId: string };
export type AdaptedRuntimeInvocation = {
  invocationId: string;
  invocation: A2APIInvocation;
  provenance: { sourceInvocationDigest: string; suppliedCorrelationId?: string };
};

const AuditEvidenceSchema = z.object({
  auditId: z.string().min(1),
  capability: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  invocationId: z.string().uuid(),
  principalId: z.string().min(1),
  tenantId: z.string().optional(),
  outcome: z.enum(["success", "failure", "denied"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  inputDigest: z.string().optional(),
  outputDigest: z.string().optional(),
  errorCode: z.string().optional()
}).strict();
export type SassA2ApiAuditEvidence = z.infer<typeof AuditEvidenceSchema>;

export type AdaptedSassResult = {
  result: Record<string, unknown>;
  sidecar: { sourceRequestId: string; sourceTraceId: string; effects: string[] };
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function failure(invocationId: string, code: string, message: string, retryable = false, audit?: SassA2ApiAuditEvidence) {
  return {
    protocolVersion: "1.0.0",
    invocationId,
    ok: false,
    error: { code, message, retryable },
    ...(audit ? { audit } : {})
  };
}

export function adaptSassInvocationToRuntime(
  input: unknown,
  trusted: TrustedA2ApiHostContext,
  options: { createTraceId?: () => string } = {}
): AdaptedRuntimeInvocation {
  const parsed = SassInvocationSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("A2API_WIRE_INVOCATION_INVALID: " + parsed.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "));
  }
  const wire = parsed.data;
  if (!trusted?.identity?.userId || !trusted.appId) {
    throw new Error("A2API_WIRE_TRUST_CONTEXT_REQUIRED: authenticated host identity and appId are required");
  }
  if (wire.context.principalId !== trusted.identity.userId) {
    throw new Error("A2API_WIRE_PRINCIPAL_MISMATCH: caller principal assertion does not match trusted host identity");
  }
  if (wire.context.tenantId !== undefined && wire.context.tenantId !== trusted.identity.tenantId) {
    throw new Error("A2API_WIRE_TENANT_MISMATCH: caller tenant assertion does not match trusted host tenant");
  }
  if (wire.context.deadline) {
    throw new Error("A2API_WIRE_DEADLINE_UNSUPPORTED: current ai_business runtime cannot enforce a hard invocation deadline");
  }
  const traceId = wire.context.correlationId ?? (options.createTraceId ?? randomUUID)();
  return {
    invocationId: wire.invocationId,
    invocation: {
      protocolVersion: wire.protocolVersion,
      capabilityId: wire.capability.id,
      capabilityVersion: wire.capability.version,
      requestId: wire.context.requestId,
      traceId,
      appId: trusted.appId,
      idempotencyKey: wire.context.idempotencyKey ?? "",
      input: wire.input
    },
    provenance: {
      sourceInvocationDigest: digest(wire),
      ...(wire.context.correlationId ? { suppliedCorrelationId: wire.context.correlationId } : {})
    }
  };
}

const ERROR_CODE_MAP: Record<string, string> = {
  FORBIDDEN: "PERMISSION_DENIED",
  TENANT_MISMATCH: "TENANT_REQUIRED",
  CAPABILITY_NOT_FOUND: "NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  IDEMPOTENCY_KEY_REQUIRED: "INVALID_ARGUMENT",
  INVALID_INPUT: "INVALID_ARGUMENT",
  OUTPUT_CONTRACT_VIOLATION: "INTERNAL",
  AUDIT_PERSISTENCE_FAILED: "INTERNAL",
  IDEMPOTENCY_PERSISTENCE_FAILED: "DEPENDENCY_UNAVAILABLE",
  IDEMPOTENCY_STORE_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE"
};

export function adaptRuntimeResultToSassWire(
  runtimeResult: RuntimeResult,
  options: {
    invocationId: string;
    capabilityVersion: string;
    identity: Identity;
    auditRequired?: boolean;
    auditEvidence?: SassA2ApiAuditEvidence;
  }
): AdaptedSassResult {
  const { invocationId, capabilityVersion, identity } = options;
  const audit = options.auditEvidence ? AuditEvidenceSchema.safeParse(options.auditEvidence) : undefined;
  if (audit && !audit.success) {
    return {
      result: failure(invocationId, "AUDIT_INVALID", "Provided audit evidence does not match the A2API audit contract"),
      sidecar: { sourceRequestId: runtimeResult.requestId, sourceTraceId: runtimeResult.traceId, effects: [] }
    };
  }
  const evidence = audit?.success ? audit.data : undefined;
  if (evidence && (
    evidence.invocationId !== invocationId ||
    evidence.capability.id !== runtimeResult.capability ||
    evidence.capability.version !== capabilityVersion ||
    evidence.principalId !== identity.userId
  )) {
    return {
      result: failure(invocationId, "AUDIT_IDENTITY_MISMATCH", "Audit evidence does not match this invocation and trusted identity"),
      sidecar: { sourceRequestId: runtimeResult.requestId, sourceTraceId: runtimeResult.traceId, effects: [] }
    };
  }
  if (options.auditRequired && !evidence) {
    return {
      result: failure(invocationId, "AUDIT_REQUIRED", "Capability requires persisted audit evidence but none was supplied"),
      sidecar: { sourceRequestId: runtimeResult.requestId, sourceTraceId: runtimeResult.traceId, effects: [] }
    };
  }

  if (runtimeResult.success) {
    return {
      result: {
        protocolVersion: "1.0.0",
        invocationId,
        ok: true,
        output: runtimeResult.data,
        ...(evidence ? { audit: evidence } : {})
      },
      sidecar: {
        sourceRequestId: runtimeResult.requestId,
        sourceTraceId: runtimeResult.traceId,
        effects: [...runtimeResult.effects]
      }
    };
  }

  const code = ERROR_CODE_MAP[runtimeResult.error.code] ?? runtimeResult.error.code;
  const result = failure(invocationId, code, runtimeResult.error.message, runtimeResult.error.retryable, evidence);
  return {
    result,
    sidecar: {
      sourceRequestId: runtimeResult.requestId,
      sourceTraceId: runtimeResult.traceId,
      effects: []
    }
  };
}
