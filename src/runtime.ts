import { randomUUID } from "node:crypto";
import type { A2APICapability, ExecutionContext, RuntimeResult } from "./types.js";
import { AssetRegistry } from "./registry.js";

export type Adapter = (input: unknown, context: ExecutionContext) => Promise<unknown>;
export type RuntimeEvent = { type: "execution.started" | "execution.succeeded" | "execution.failed"; traceId: string; requestId: string; capability: string; at: string; detail?: unknown };
export class ExecutionRuntime {
  private readonly adapters = new Map<string, Adapter>();
  private readonly idempotency = new Map<string, RuntimeResult>();
  readonly events: RuntimeEvent[] = [];
  constructor(private readonly registry: AssetRegistry, private readonly onEvent?: (event: RuntimeEvent) => void) {}

  registerAdapter(name: string, adapter: Adapter): void {
    if (this.adapters.has(name)) throw new Error(`ADAPTER_EXISTS: ${name}`);
    this.adapters.set(name, adapter);
  }

  async execute(capabilityId: string, input: unknown, identity: ExecutionContext["identity"], options: { requestId?: string; traceId?: string; idempotencyKey?: string } = {}): Promise<RuntimeResult> {
    const requestId = options.requestId ?? randomUUID();
    const traceId = options.traceId ?? randomUUID();
    const fail = (code: string, message: string, retryable = false): RuntimeResult => ({ success: false, requestId, traceId, capability: capabilityId, error: { code, message, retryable } });
    const stored = this.registry.get(capabilityId);
    if (!stored || stored.asset.kind !== "a2api") return fail("CAPABILITY_NOT_FOUND", "Published capability was not found");
    const capability = stored.asset as A2APICapability;
    if (!capability.auth.roles.some(role => identity.roles.includes(role))) return fail("FORBIDDEN", "Identity does not have a permitted role");
    if (capability.auth.tenantRequired && !identity.tenantId) return fail("TENANT_REQUIRED", "A tenant identity is required");
    if (capability.visibility !== "system" && capability.tenantId !== identity.tenantId) return fail("TENANT_MISMATCH", "Asset is not available to this tenant");
    if (capability.idempotency.required && !options.idempotencyKey) return fail("IDEMPOTENCY_KEY_REQUIRED", "This operation requires an idempotency key");
    const idemKey = options.idempotencyKey ? `${identity.tenantId ?? "global"}:${capabilityId}:${options.idempotencyKey}` : undefined;
    if (idemKey && this.idempotency.has(idemKey)) return this.idempotency.get(idemKey)!;
    const adapter = this.adapters.get(capability.mapping.adapter);
    if (!adapter) return fail("ADAPTER_NOT_CONFIGURED", `Adapter '${capability.mapping.adapter}' is not registered`);
    const context: ExecutionContext = { identity, appId: "runtime", traceId, requestId, idempotencyKey: options.idempotencyKey };
    this.emit({ type: "execution.started", traceId, requestId, capability: capabilityId, at: new Date().toISOString() });
    try {
      const data = await Promise.race([
        adapter(input, context),
        new Promise((_, reject) => setTimeout(() => reject(new Error("ADAPTER_TIMEOUT")), capability.mapping.timeoutMs))
      ]);
      const result: RuntimeResult = { success: true, requestId, traceId, capability: capabilityId, data, effects: capability.effects };
      if (idemKey) this.idempotency.set(idemKey, result);
      this.emit({ type: "execution.succeeded", traceId, requestId, capability: capabilityId, at: new Date().toISOString() });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown adapter error";
      this.emit({ type: "execution.failed", traceId, requestId, capability: capabilityId, at: new Date().toISOString(), detail: message });
      return fail(message === "ADAPTER_TIMEOUT" ? "TIMEOUT" : "ADAPTER_ERROR", message, message === "ADAPTER_TIMEOUT");
    }
  }

  private emit(event: RuntimeEvent): void { this.events.push(event); this.onEvent?.(event); }
}
