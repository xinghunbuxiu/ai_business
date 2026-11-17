import { randomUUID } from "node:crypto";
import type { A2WFWorkflow, Identity } from "./types.js";
import { AssetRegistry } from "./registry.js";
import { ExecutionRuntime } from "./runtime.js";

export type WorkflowStatus = "running" | "awaiting_input" | "awaiting_confirmation" | "completed" | "failed";
export type WorkflowExecution = {
  id: string; protocolVersion: "1.0.0"; workflowId: string; workflowVersion: string; appId: string; status: WorkflowStatus; currentStepId?: string;
  triggerInput: Record<string, unknown>; identity: Identity; outputs: Record<string, unknown>;
  history: Array<{ stepId: string; status: string; output?: unknown; error?: unknown }>;
  createdAt: string; updatedAt: string;
};
export type WorkflowResult = { execution: WorkflowExecution; waiting?: { type: "input" | "confirmation"; stepId: string; component?: string; props?: Record<string, unknown> } };
export type WorkflowEvent = { type: "workflow.started" | "workflow.step.started" | "workflow.step.completed" | "workflow.waiting" | "workflow.completed" | "workflow.failed"; executionId: string; workflowId: string; stepId?: string; at: string; detail?: unknown };

export class WorkflowRunner {
  private readonly executions = new Map<string, WorkflowExecution>();
  readonly events: WorkflowEvent[] = [];
  constructor(private readonly registry: AssetRegistry, private readonly runtime: ExecutionRuntime, private readonly onEvent?: (event: WorkflowEvent) => void) {}

  async start(workflowId: string, input: Record<string, unknown>, identity: Identity, options: { appId?: string } = {}): Promise<WorkflowResult> {
    const stored = this.registry.get(workflowId);
    if (!stored || stored.asset.kind !== "a2wf") throw new Error("WORKFLOW_NOT_FOUND");
    const workflow = stored.asset as A2WFWorkflow;
    if (workflow.trigger.roles.length && !workflow.trigger.roles.some(role => identity.roles.includes(role))) throw new Error("WORKFLOW_FORBIDDEN");
    if (workflow.permissions.some(permission => !identity.permissions?.includes(permission))) throw new Error("WORKFLOW_PERMISSION_DENIED");
    if (workflow.visibility !== "system" && workflow.tenantId !== identity.tenantId) throw new Error("WORKFLOW_TENANT_MISMATCH");
    for (const step of workflow.steps) {
      if (step.type === "action" && !this.registry.get(step.capability!, step.capabilityVersion)) throw new Error("WORKFLOW_DEPENDENCY_NOT_PUBLISHED: " + step.capability + "@" + step.capabilityVersion);
      if (step.type === "form" && !this.registry.get(step.component!, step.componentVersion)) throw new Error("WORKFLOW_COMPONENT_NOT_PUBLISHED: " + step.component + "@" + step.componentVersion);
    }
    const execution: WorkflowExecution = { id: randomUUID(), protocolVersion: "1.0.0", workflowId, workflowVersion: workflow.version, appId: options.appId ?? workflowId, status: "running", currentStepId: workflow.steps[0].id, triggerInput: input, identity, outputs: {}, history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.executions.set(execution.id, execution); this.emit("workflow.started", execution);
    return this.advance(execution, workflow);
  }

  async resume(executionId: string, response: Record<string, unknown>): Promise<WorkflowResult> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error("WORKFLOW_EXECUTION_NOT_FOUND");
    if (execution.status !== "awaiting_input" && execution.status !== "awaiting_confirmation") throw new Error("WORKFLOW_NOT_WAITING");
    const workflow = this.registry.get(execution.workflowId, execution.workflowVersion)?.asset as A2WFWorkflow | undefined;
    if (!workflow) throw new Error("WORKFLOW_VERSION_NOT_FOUND");
    const step = workflow.steps.find(item => item.id === execution.currentStepId);
    if (!step) throw new Error("WORKFLOW_STEP_NOT_FOUND");
    if (execution.status === "awaiting_confirmation") {
      if (response.confirmed !== true) {
        execution.status = "failed"; execution.history.push({ stepId: step.id, status: "rejected" });
        execution.updatedAt = new Date().toISOString(); this.emit("workflow.failed", execution, step.id, "Confirmation rejected");
        return { execution: structuredClone(execution) };
      }
      execution.outputs[step.id] = { confirmed: true };
      if (step.type !== "action") execution.currentStepId = step.next ?? this.nextStep(workflow, step.id);
    } else {
      execution.outputs[step.id] = response; execution.history.push({ stepId: step.id, status: "completed", output: response });
      execution.currentStepId = step.next ?? this.nextStep(workflow, step.id);
    }
    execution.status = "running"; execution.updatedAt = new Date().toISOString();
    return this.advance(execution, workflow);
  }

  get(executionId: string): WorkflowExecution | undefined {
    const value = this.executions.get(executionId); return value ? structuredClone(value) : undefined;
  }

  private async advance(execution: WorkflowExecution, workflow: A2WFWorkflow): Promise<WorkflowResult> {
    const byId = new Map(workflow.steps.map(step => [step.id, step]));
    let budget = workflow.steps.length * 4;
    while (execution.currentStepId && budget-- > 0) {
      const step = byId.get(execution.currentStepId);
      if (!step) return this.fail(execution, "WORKFLOW_INVALID_TRANSITION");
      this.emit("workflow.step.started", execution, step.id);
      if (step.type === "end") {
        execution.history.push({ stepId: step.id, status: "completed" }); execution.currentStepId = undefined;
        execution.status = "completed"; execution.updatedAt = new Date().toISOString();
        this.emit("workflow.completed", execution, step.id); return { execution: structuredClone(execution) };
      }
      if (step.type === "condition") {
        const actual = this.readPath(execution, step.condition!.path);
        const passed = step.condition!.operator === "exists" ? actual !== undefined : step.condition!.operator === "truthy" ? Boolean(actual) : step.condition!.operator === "eq" ? Object.is(actual, step.condition!.value) : !Object.is(actual, step.condition!.value);
        execution.outputs[step.id] = { passed }; execution.history.push({ stepId: step.id, status: "completed", output: { passed } });
        execution.currentStepId = passed ? step.onTrue : step.onFalse; continue;
      }
      if (step.type === "form" || step.type === "approval") {
        execution.status = step.type === "approval" ? "awaiting_confirmation" : "awaiting_input";
        execution.updatedAt = new Date().toISOString(); this.emit("workflow.waiting", execution, step.id, { type: step.type });
        return { execution: structuredClone(execution), waiting: { type: step.type === "approval" ? "confirmation" : "input", stepId: step.id, component: step.component, props: this.resolveBindings(step.input, execution) as Record<string, unknown> } };
      }
      const priorOutput = execution.outputs[step.id];
      const isConfirmed = !!priorOutput && typeof priorOutput === "object" && (priorOutput as Record<string, unknown>).confirmed === true;
      if (step.requiresConfirmation && !isConfirmed) {
        execution.status = "awaiting_confirmation"; execution.updatedAt = new Date().toISOString();
        this.emit("workflow.waiting", execution, step.id, { type: "confirmation" });
        return { execution: structuredClone(execution), waiting: { type: "confirmation", stepId: step.id, props: this.resolveBindings(step.input, execution) as Record<string, unknown> } };
      }
      const input = this.resolveBindings(step.input, execution) as Record<string, unknown>;
      const result = await this.runtime.execute(step.capability!, input, execution.identity, { idempotencyKey: execution.id + ":" + step.id, appId: execution.appId, capabilityVersion: step.capabilityVersion });
      if (!result.success) {
        execution.history.push({ stepId: step.id, status: "failed", error: result.error });
        return this.fail(execution, result.error.code);
      }
      execution.outputs[step.id] = result.data; execution.history.push({ stepId: step.id, status: "completed", output: result.data });
      this.emit("workflow.step.completed", execution, step.id, result.data);
      execution.currentStepId = step.next ?? this.nextStep(workflow, step.id); execution.updatedAt = new Date().toISOString();
    }
    if (budget <= 0) return this.fail(execution, "WORKFLOW_STEP_BUDGET_EXCEEDED");
    if (!execution.currentStepId) { execution.status = "completed"; execution.updatedAt = new Date().toISOString(); this.emit("workflow.completed", execution); }
    return { execution: structuredClone(execution) };
  }

  private resolveBindings(value: unknown, execution: WorkflowExecution): unknown {
    if (Array.isArray(value)) return value.map(item => this.resolveBindings(item, execution));
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 1 && typeof object.$ref === "string") return this.readPath(execution, object.$ref);
      return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, this.resolveBindings(item, execution)]));
    }
    return value;
  }
  private readPath(execution: WorkflowExecution, path: string): unknown {
    const [root, ...parts] = path.split(".");
    let value: unknown = root === "trigger" ? execution.triggerInput : root === "outputs" ? execution.outputs : undefined;
    for (const part of parts) { if (!value || typeof value !== "object") return undefined; value = (value as Record<string, unknown>)[part]; }
    return value;
  }
  private nextStep(workflow: A2WFWorkflow, id: string): string | undefined {
    const index = workflow.steps.findIndex(step => step.id === id); return workflow.steps[index + 1]?.id;
  }
  private fail(execution: WorkflowExecution, code: string): WorkflowResult {
    execution.status = "failed"; execution.updatedAt = new Date().toISOString();
    this.emit("workflow.failed", execution, execution.currentStepId, code); return { execution: structuredClone(execution) };
  }
  private emit(type: WorkflowEvent["type"], execution: WorkflowExecution, stepId?: string, detail?: unknown): void {
    const event: WorkflowEvent = { type, executionId: execution.id, workflowId: execution.workflowId, stepId, at: new Date().toISOString(), detail };
    this.events.push(event); this.onEvent?.(event);
  }
}
