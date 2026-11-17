import { z } from "zod";

export const AssetStatus = z.enum(["draft", "validated", "testing", "published", "deprecated"]);
export type AssetStatus = z.infer<typeof AssetStatus>;
export const AssetKind = z.enum(["a2ui", "a2api", "a2wf", "app"]);
export type AssetKind = z.infer<typeof AssetKind>;

export const BaseAssetSchema = z.object({
  schemaVersion: z.string().min(1),
  id: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  kind: AssetKind,
  name: z.string().min(1),
  description: z.string().optional(),
  status: AssetStatus.default("draft"),
  visibility: z.enum(["system", "tenant", "private"]).default("system"),
  tenantId: z.string().optional(),
  permissions: z.array(z.string()).default([]),
  dependencies: z.array(z.object({ id: z.string(), version: z.string() })).default([]),
  testEvidence: z.object({ suite: z.string(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), reportId: z.string().optional() }).optional()
});
export type BaseAsset = z.infer<typeof BaseAssetSchema>;

export const A2UIComponentSchema = BaseAssetSchema.extend({
  kind: z.literal("a2ui"),
  component: z.string().min(1),
  propsSchema: z.record(z.unknown()).default({}),
  events: z.array(z.object({ name: z.string(), action: z.string() })).default([]),
  layout: z.record(z.unknown()).optional()
});
export type A2UIComponent = z.infer<typeof A2UIComponentSchema>;

export const A2APICapabilitySchema = BaseAssetSchema.extend({
  kind: z.literal("a2api"),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()),
  errors: z.array(z.object({ code: z.string(), message: z.string(), retryable: z.boolean().default(false) })).default([]),
  auth: z.object({ roles: z.array(z.string()).min(1), tenantRequired: z.boolean().default(true) }),
  preconditions: z.array(z.string()).default([]),
  effects: z.array(z.string()).default([]),
  mapping: z.object({ adapter: z.string(), operation: z.string(), timeoutMs: z.number().int().positive().default(10000) }),
  idempotency: z.object({ required: z.boolean().default(true), keyFrom: z.string().default("request.idempotencyKey") }).default({ required: true, keyFrom: "request.idempotencyKey" })
});
export type A2APICapability = z.infer<typeof A2APICapabilitySchema>;

export const A2WFWorkflowSchema = BaseAssetSchema.extend({
  kind: z.literal("a2wf"),
  trigger: z.object({ intents: z.array(z.string()).min(1), roles: z.array(z.string()).default([]) }),
  steps: z.array(z.object({ id: z.string(), capability: z.string().optional(), component: z.string().optional(), input: z.record(z.unknown()).default({}), requiresConfirmation: z.boolean().default(false) })).min(1)
});
export type A2WFWorkflow = z.infer<typeof A2WFWorkflowSchema>;

export const AppManifestSchema = BaseAssetSchema.extend({
  kind: z.literal("app"),
  entrypoints: z.array(z.object({ id: z.string(), label: z.string(), roles: z.array(z.string()), intent: z.string().optional(), component: z.string().optional(), workflow: z.string().optional() })),
  assets: z.array(z.object({ id: z.string(), version: z.string(), kind: AssetKind })),
  defaultRole: z.string().optional()
});
export type AppManifest = z.infer<typeof AppManifestSchema>;

export type BusinessAsset = A2UIComponent | A2APICapability | A2WFWorkflow | AppManifest;
export type Identity = { userId: string; tenantId?: string; roles: string[]; permissions?: string[] };
export type ExecutionContext = { identity: Identity; appId: string; traceId: string; requestId: string; idempotencyKey?: string; signal?: AbortSignal };
export type RuntimeError = { code: string; message: string; retryable: boolean; fieldErrors?: Record<string, string[]> };
export type RuntimeResult<T = unknown> = { success: true; requestId: string; traceId: string; capability: string; data: T; effects: string[] } | { success: false; requestId: string; traceId: string; capability: string; error: RuntimeError };
