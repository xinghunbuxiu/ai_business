import { z } from "zod";

export const A2API_PROTOCOL_VERSION = "1.0.0" as const;
export const A2WF_PROTOCOL_VERSION = "1.0.0" as const;
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
  protocolVersion: z.literal(A2API_PROTOCOL_VERSION),
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

export const A2WFStepSchema = z.object({
  id: z.string().min(1), type: z.enum(["action", "form", "approval", "condition", "end"]).default("action"),
  capability: z.string().optional(), capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).optional(), component: z.string().optional(), componentVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/).optional(), input: z.record(z.unknown()).default({}),
  requiresConfirmation: z.boolean().default(false), next: z.string().optional(), onTrue: z.string().optional(), onFalse: z.string().optional(),
  condition: z.object({ path: z.string().min(1), operator: z.enum(["eq", "neq", "exists", "truthy"]), value: z.unknown().optional() }).optional()
}).superRefine((step, ctx) => {
  if (step.type === "action" && (!step.capability || !step.capabilityVersion)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilityVersion"], message: "Action steps require a capability ID and pinned capabilityVersion" });
  if (step.type === "form" && (!step.component || !step.componentVersion)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["componentVersion"], message: "Form steps require a component ID and pinned componentVersion" });
  if (step.type === "condition" && (!step.condition || !step.onTrue || !step.onFalse)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["condition"], message: "Condition steps require condition, onTrue and onFalse" });
});
export const A2WFWorkflowSchema = BaseAssetSchema.extend({
  kind: z.literal("a2wf"), protocolVersion: z.literal(A2WF_PROTOCOL_VERSION), trigger: z.object({ intents: z.array(z.string()).min(1), roles: z.array(z.string()).default([]) }), steps: z.array(A2WFStepSchema).min(1)
}).superRefine((workflow, ctx) => {
  const ids = new Set(workflow.steps.map(step => step.id));
  if (ids.size !== workflow.steps.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps"], message: "Workflow step IDs must be unique" });
  for (const step of workflow.steps) for (const target of [step.next, step.onTrue, step.onFalse]) if (target && !ids.has(target)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", step.id], message: `Unknown workflow transition target: ${target}` });
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
export type A2APIInvocation<T = unknown> = { protocolVersion: string; capabilityId: string; capabilityVersion: string; requestId: string; traceId: string; appId: string; idempotencyKey: string; input: T };
export type RuntimeResult<T = unknown> = { protocolVersion: typeof A2API_PROTOCOL_VERSION; success: true; requestId: string; traceId: string; capability: string; data: T; effects: string[] } | { protocolVersion: typeof A2API_PROTOCOL_VERSION; success: false; requestId: string; traceId: string; capability: string; error: RuntimeError };
