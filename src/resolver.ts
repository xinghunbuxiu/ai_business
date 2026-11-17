import type { A2APICapability, A2WFWorkflow, ExecutionContext } from "./types.js";
import { AssetRegistry } from "./registry.js";

export type IntentRequest = { text: string; intent: string; appId: string; context: ExecutionContext };
export type ResolvedPlan = { workflow?: A2WFWorkflow; capability?: A2APICapability; clarificationRequired: boolean; reason?: string };

export class IntentResolver {
  constructor(private readonly registry: AssetRegistry) {}

  resolve(request: IntentRequest): ResolvedPlan {
    const { context, intent } = request;
    const workflows = this.registry.list({ kind: "a2wf", tenantId: context.identity.tenantId });
    const workflow = workflows.map(x => x.asset as A2WFWorkflow).find(w =>
      w.trigger.intents.includes(intent) && (!w.trigger.roles.length || w.trigger.roles.some(r => context.identity.roles.includes(r)))
    );
    if (workflow) return { workflow, clarificationRequired: false };

    const capabilities = this.registry.list({ kind: "a2api", tenantId: context.identity.tenantId }).map(x => x.asset as A2APICapability);
    const capability = capabilities.find(c => c.id === intent && c.auth.roles.some(r => context.identity.roles.includes(r)) && (!c.auth.tenantRequired || !!context.identity.tenantId));
    if (capability) return { capability, clarificationRequired: false };
    return { clarificationRequired: true, reason: "No published workflow or capability matched this intent and identity" };
  }
}
