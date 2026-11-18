import { createHash } from "node:crypto";
import { z } from "zod";
import { A2APICapabilitySchema, type A2APICapability } from "./types.js";

/**
 * Explicit bridge from the Sass capability-contract model to the ai_business
 * A2API registry-asset envelope. It deliberately refuses semantic fields that
 * the target runtime cannot represent or that need a host-owned policy binding.
 */
const JsonSchemaObject = z.record(z.string(), z.unknown());
const ContractSchema = z.object({
  protocolVersion: z.literal("1.0.0"),
  id: z.string().min(3).max(200),
  version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  title: z.string().optional(),
  description: z.string().optional(),
  provider: z.object({
    id: z.string().min(1),
    runtime: z.enum(["java", "node", "python", "http", "native"]),
    contractVersion: z.literal("1.0.0"),
    handler: z.string().optional()
  }).strict(),
  operation: z.object({
    id: z.string().min(1),
    kind: z.enum(["query", "command"]),
    http: z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/") }).strict().optional()
  }).strict(),
  input: z.object({ schema: JsonSchemaObject }).strict(),
  output: z.object({ schema: JsonSchemaObject }).strict(),
  security: z.object({
    authentication: z.object({ required: z.boolean(), schemes: z.array(z.string()).optional() }).strict(),
    tenant: z.object({ mode: z.enum(["none", "optional", "required"]), scope: z.string().optional() }).strict(),
    permissions: z.array(z.string())
  }).strict(),
  execution: z.object({
    effect: z.enum(["read", "write"]),
    risk: z.enum(["low", "medium", "high", "critical"]),
    destructive: z.boolean(),
    timeoutMs: z.number().int().positive(),
    idempotency: z.object({ mode: z.enum(["required", "optional", "unsupported"]), keyScope: z.enum(["tenant", "principal", "global"]).optional() }).strict(),
    retry: z.object({ maxAttempts: z.number().int().positive(), backoff: z.enum(["none", "fixed", "exponential"]), initialDelayMs: z.number().int().nonnegative().optional(), maxDelayMs: z.number().int().nonnegative().optional(), retryableErrors: z.array(z.string()).optional() }).strict()
  }).strict(),
  errors: z.array(z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict()),
  audit: z.object({ required: z.boolean(), record: z.array(z.string()) }).strict()
}).strict();

export type CapabilityContract = z.infer<typeof ContractSchema>;

export const A2ApiRegistryMappingSchema = z.object({
  name: z.string().min(1),
  visibility: z.enum(["system", "tenant", "private"]).default("system"),
  tenantId: z.string().optional(),
  roles: z.array(z.string().min(1)).min(1),
  adapter: z.string().min(1),
  operation: z.string().min(1),
  idempotencyKeyFrom: z.string().min(1),
  hostAuthenticationSchemes: z.array(z.string()).default([]),
  tenantScopeBinding: z.string().optional(),
  hostEnforcedAuditRequired: z.boolean().default(false),
  preconditions: z.array(z.string()).default([]),
  effects: z.array(z.string()).default([]),
  dependencies: z.array(z.object({ id: z.string(), version: z.string() })).default([])
}).strict();
export type A2ApiRegistryMapping = z.input<typeof A2ApiRegistryMappingSchema>;

export type A2ApiContractMappingProvenance = {
  sourceContractDigest: string;
  sourceProvider: CapabilityContract["provider"];
  sourceOperation: CapabilityContract["operation"];
  sourceExecution: CapabilityContract["execution"];
  sourceAudit: CapabilityContract["audit"];
  sourceTenantScope?: string;
  hostAuthenticationSchemes: string[];
  tenantScopeBinding?: string;
  hostEnforcedAuditRequired: boolean;
};

export type MappedA2ApiRegistryAsset = {
  asset: A2APICapability;
  provenance: A2ApiContractMappingProvenance;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fail(code: string, message: string): never {
  throw new Error(code + ": " + message);
}

export function mapCapabilityContractToRegistryAsset(
  input: unknown,
  mappingInput: A2ApiRegistryMapping
): MappedA2ApiRegistryAsset {
  const contractResult = ContractSchema.safeParse(input);
  if (!contractResult.success) {
    fail("A2API_CONTRACT_INVALID", contractResult.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "));
  }
  const contract = contractResult.data;
  const mapping = A2ApiRegistryMappingSchema.parse(mappingInput);

  if (!contract.security.authentication.required) {
    fail("A2API_MAPPING_UNSUPPORTED_AUTH", "The target registry runtime requires an authenticated identity");
  }
  const schemes = contract.security.authentication.schemes ?? [];
  const unboundSchemes = schemes.filter(scheme => !mapping.hostAuthenticationSchemes.includes(scheme));
  if (unboundSchemes.length) {
    fail("A2API_MAPPING_AUTH_SCHEME_UNBOUND", "No host authentication binding for: " + unboundSchemes.join(", "));
  }
  if (contract.security.tenant.mode === "optional") {
    fail("A2API_MAPPING_UNSUPPORTED_TENANT_MODE", "The registry asset envelope supports required/none, not optional tenant semantics");
  }
  if (contract.security.tenant.scope && !mapping.tenantScopeBinding) {
    fail("A2API_MAPPING_TENANT_SCOPE_UNBOUND", "Tenant scope requires an explicit host binding");
  }
  if (contract.execution.risk !== "low" || contract.execution.destructive) {
    fail("A2API_MAPPING_RISK_UNREPRESENTABLE", "The target registry runtime has no equivalent risk/approval enforcement; only low-risk non-destructive capabilities may be mapped");
  }
  if (contract.execution.retry.maxAttempts !== 1 || contract.execution.retry.backoff !== "none" || (contract.execution.retry.retryableErrors?.length ?? 0) > 0) {
    fail("A2API_MAPPING_RETRY_UNSUPPORTED", "The target runtime does not implement the source retry policy");
  }
  if (contract.execution.idempotency.mode !== "unsupported" && contract.execution.idempotency.keyScope !== "tenant") {
    fail("A2API_MAPPING_IDEMPOTENCY_SCOPE_UNSUPPORTED", "The target runtime currently scopes durable idempotency by tenant/global identity only");
  }
  if (contract.execution.idempotency.mode !== "unsupported" && mapping.idempotencyKeyFrom !== "request.idempotencyKey") {
    fail("A2API_MAPPING_IDEMPOTENCY_KEY_PATH", "The target runtime extracts the key from request.idempotencyKey");
  }
  if (contract.audit.required && !mapping.hostEnforcedAuditRequired) {
    fail("A2API_MAPPING_AUDIT_POLICY_UNBOUND", "A2API audit.required needs an explicit host policy because the registry asset schema has no per-capability audit-required field");
  }
  if ((mapping.visibility === "tenant" || mapping.visibility === "private") && !mapping.tenantId) {
    fail("A2API_MAPPING_TENANT_REQUIRED", "Tenant/private registry assets require tenantId");
  }

  const candidate = {
    schemaVersion: "1.0",
    protocolVersion: contract.protocolVersion,
    id: contract.id,
    version: contract.version,
    kind: "a2api" as const,
    name: mapping.name,
    ...(contract.description ? { description: contract.description } : {}),
    status: "draft" as const,
    visibility: mapping.visibility,
    ...(mapping.tenantId ? { tenantId: mapping.tenantId } : {}),
    permissions: [...contract.security.permissions],
    dependencies: mapping.dependencies,
    inputSchema: contract.input.schema,
    outputSchema: contract.output.schema,
    errors: contract.errors,
    auth: {
      roles: mapping.roles,
      tenantRequired: contract.security.tenant.mode === "required"
    },
    preconditions: mapping.preconditions,
    effects: mapping.effects,
    mapping: {
      adapter: mapping.adapter,
      operation: mapping.operation,
      timeoutMs: contract.execution.timeoutMs
    },
    idempotency: {
      required: contract.execution.idempotency.mode === "required",
      keyFrom: mapping.idempotencyKeyFrom
    }
  };

  const assetResult = A2APICapabilitySchema.safeParse(candidate);
  if (!assetResult.success) {
    fail("A2API_REGISTRY_ASSET_INVALID", assetResult.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; "));
  }

  return {
    asset: assetResult.data,
    provenance: {
      sourceContractDigest: digest(contract),
      sourceProvider: contract.provider,
      sourceOperation: contract.operation,
      sourceExecution: contract.execution,
      sourceAudit: contract.audit,
      ...(contract.security.tenant.scope ? { sourceTenantScope: contract.security.tenant.scope } : {}),
      hostAuthenticationSchemes: [...mapping.hostAuthenticationSchemes],
      ...(mapping.tenantScopeBinding ? { tenantScopeBinding: mapping.tenantScopeBinding } : {}),
      hostEnforcedAuditRequired: mapping.hostEnforcedAuditRequired
    }
  };
}
