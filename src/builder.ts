import { z } from "zod";
import type { A2APICapability, A2UIComponent, A2WFWorkflow, AppManifest, BusinessAsset } from "./types.js";
import { AssetRegistry } from "./registry.js";

const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
export const AppRequirementSchema = z.object({
  appId: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
  appVersion: SemVer,
  name: z.string().min(1),
  description: z.string().optional(),
  visibility: z.enum(["system", "tenant", "private"]).default("tenant"),
  tenantId: z.string().optional(),
  roles: z.array(z.string().min(1)).min(1),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  requiredComponents: z.array(z.string().min(1)).default([]),
  workflowIntents: z.array(z.string().min(1)).default([]),
  entrypoints: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    roles: z.array(z.string().min(1)).min(1),
    intent: z.string().optional(),
    componentId: z.string().optional(),
    workflowIntent: z.string().optional()
  }).superRefine((entry, ctx) => {
    if (!entry.intent && !entry.componentId && !entry.workflowIntent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Entrypoint requires an intent, componentId or workflowIntent" });
    }
  })).min(1)
});
export type AppRequirement = z.infer<typeof AppRequirementSchema>;

export type BuilderGap = {
  kind: "a2api" | "a2ui" | "a2wf";
  id: string;
  reason: "not_found" | "not_visible";
  generationBrief: string;
};
export type BuilderPlan = {
  requirement: AppRequirement;
  matched: Array<{ kind: "a2api" | "a2ui" | "a2wf"; id: string; version: string; hash: string }>;
  gaps: BuilderGap[];
  readyForManifest: boolean;
  manifestDraft?: AppManifest;
};

/**
 * Deterministic first-stage Builder pipeline:
 * validate business requirements -> reuse visible published assets -> report gaps ->
 * compose a draft manifest from exact immutable dependency pins.
 * It deliberately does not invent executable business logic or publish anything.
 */
export class AppBuilderPlanner {
  constructor(private readonly registry: AssetRegistry) {}

  plan(input: unknown, scope: { tenantId?: string }): BuilderPlan {
    const parsed = AppRequirementSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("APP_REQUIREMENT_INVALID: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const requirement = parsed.data;
    if ((requirement.visibility === "tenant" || requirement.visibility === "private") && !requirement.tenantId) {
      throw new Error("APP_REQUIREMENT_INVALID: tenantId is required for tenant/private apps");
    }
    if (requirement.tenantId && scope.tenantId !== requirement.tenantId) {
      throw new Error("APP_BUILDER_TENANT_SCOPE_MISMATCH");
    }

    const visible = this.registry.list({ tenantId: scope.tenantId });
    const matched: BuilderPlan["matched"] = [];
    const gaps: BuilderGap[] = [];
    const addMatch = (asset: BusinessAsset) => {
      if (!matched.some(x => x.kind === asset.kind && x.id === asset.id && x.version === asset.version)) {
        const stored = this.registry.get(asset.id, asset.version);
        if (stored) matched.push({ kind: asset.kind as "a2api" | "a2ui" | "a2wf", id: asset.id, version: asset.version, hash: stored.hash });
      }
    };
    const find = (kind: "a2api" | "a2ui" | "a2wf", id: string) => visible.find(x => x.asset.kind === kind && x.asset.id === id);

    for (const id of requirement.requiredCapabilities) {
      const item = find("a2api", id);
      if (item) addMatch(item.asset);
      else gaps.push({ kind: "a2api", id, reason: "not_found", generationBrief: `Define A2API capability ${id}: input/output JSON Schema, roles, permissions, tenant policy, preconditions, effects, error contract, idempotency and trusted adapter mapping.` });
    }
    for (const id of requirement.requiredComponents) {
      const item = find("a2ui", id);
      if (item) addMatch(item.asset);
      else gaps.push({ kind: "a2ui", id, reason: "not_found", generationBrief: `Define safe declarative A2UI component ${id}: allowlisted renderer type, propsSchema, layout data and typed events pinned to exact published A2API/A2WF versions.` });
    }
    for (const intent of requirement.workflowIntents) {
      const item = visible.find(x => x.asset.kind === "a2wf" && (x.asset as A2WFWorkflow).trigger.intents.includes(intent));
      if (item) addMatch(item.asset);
      else gaps.push({ kind: "a2wf", id: intent, reason: "not_found", generationBrief: `Define A2WF workflow for intent ${intent}: explicit trigger roles, pinned action/form dependencies, transitions, confirmation and terminal paths.` });
    }

    const readyForManifest = gaps.length === 0;
    let manifestDraft: AppManifest | undefined;
    if (readyForManifest) {
      const assets = matched.map(({ kind, id, version }) => ({ kind, id, version }));
      const entrypoints = requirement.entrypoints.map(entry => ({
        id: entry.id,
        label: entry.label,
        roles: entry.roles,
        ...(entry.intent ? { intent: entry.intent } : {}),
        ...(entry.componentId ? { component: entry.componentId } : {}),
        ...(entry.workflowIntent ? {
          workflow: (visible.find(x => x.asset.kind === "a2wf" && (x.asset as A2WFWorkflow).trigger.intents.includes(entry.workflowIntent!))?.asset as A2WFWorkflow | undefined)?.id
        } : {})
      }));
      manifestDraft = {
        schemaVersion: "1.0",
        protocolVersion: "1.0.0",
        id: requirement.appId,
        version: requirement.appVersion,
        kind: "app",
        name: requirement.name,
        ...(requirement.description ? { description: requirement.description } : {}),
        status: "draft",
        visibility: requirement.visibility,
        ...(requirement.tenantId ? { tenantId: requirement.tenantId } : {}),
        permissions: [],
        dependencies: [],
        entrypoints,
        assets
      } as AppManifest;
    }
    return { requirement, matched, gaps, readyForManifest, ...(manifestDraft ? { manifestDraft } : {}) };
  }
}
