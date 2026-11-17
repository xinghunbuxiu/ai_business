import { createHash, randomUUID } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import { A2API_PROTOCOL_VERSION, type A2APIInvocation, type A2APICapability, type ExecutionContext, type RuntimeResult } from "./types.js";
import { AssetRegistry } from "./registry.js";

export type Adapter = (input: unknown, context: ExecutionContext) => Promise<unknown>;
export type PreconditionHandler = (input: unknown, context: ExecutionContext) => Promise<boolean>;
export type RuntimeEvent = { type: "execution.started" | "execution.succeeded" | "execution.failed"; traceId: string; requestId: string; capability: string; at: string; detail?: unknown };

export class ExecutionRuntime {
  private readonly adapters = new Map<string, Adapter>();
  private readonly preconditions = new Map<string, PreconditionHandler>();
  private readonly idempotency = new Map<string, { fingerprint: string; result: RuntimeResult }>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<RuntimeResult> }>();
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  readonly events: RuntimeEvent[] = [];

  constructor(private readonly registry: AssetRegistry, private readonly onEvent?: (event: RuntimeEvent) => void) {}

  registerPrecondition(name: string, handler: PreconditionHandler): void {
    if (this.preconditions.has(name)) throw new Error("PRECONDITION_EXISTS: " + name);
    this.preconditions.set(name, handler);
  }

  registerAdapter(name: string, adapter: Adapter): void {
    if (this.adapters.has(name)) throw new Error(`ADAPTER_EXISTS: ${name}`);
    this.adapters.set(name, adapter);
  }

  async execute(capabilityId: string, input: unknown, identity: ExecutionContext["identity"], options: { requestId?: string; traceId?: string; idempotencyKey?: string; appId?: string; capabilityVersion?: string } = {}): Promise<RuntimeResult> {
    if (!options.idempotencyKey) return this.executeOnce(capabilityId, input, identity, options);
    const key = `${identity.tenantId ?? "global"}:${capabilityId}@${options.capabilityVersion ?? "latest"}:${options.idempotencyKey}`;
    const fingerprint = createHash("sha256").update(stableStringify({ input, identity: { userId: identity.userId, tenantId: identity.tenantId, roles: identity.roles, permissions: identity.permissions } })).digest("hex");
    const conflict = (): RuntimeResult => ({ protocolVersion: A2API_PROTOCOL_VERSION, success: false, requestId: options.requestId ?? randomUUID(), traceId: options.traceId ?? randomUUID(), capability: capabilityId, error: { code: "IDEMPOTENCY_CONFLICT", message: "The idempotency key was already used with a different input", retryable: false } });
    const cached = this.idempotency.get(key);
    if (cached) return cached.fingerprint === fingerprint ? cached.result : conflict();
    const pending = this.inFlight.get(key);
    if (pending) return pending.fingerprint === fingerprint ? pending.promise : conflict();
    const promise = this.executeOnce(capabilityId, input, identity, options);
    this.inFlight.set(key, { fingerprint, promise });
    try {
      const result = await promise;
      if (result.success) this.idempotency.set(key, { fingerprint, result });
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async executeInvocation(invocation: A2APIInvocation, identity: ExecutionContext["identity"]): Promise<RuntimeResult> {
    if (invocation.protocolVersion !== A2API_PROTOCOL_VERSION) {
      return { protocolVersion: A2API_PROTOCOL_VERSION, success: false, requestId: invocation.requestId, traceId: invocation.traceId, capability: invocation.capabilityId, error: { code: "UNSUPPORTED_PROTOCOL_VERSION", message: "Unsupported A2API protocol version: " + invocation.protocolVersion, retryable: false } };
    }
    return this.execute(invocation.capabilityId, invocation.input, identity, { requestId: invocation.requestId, traceId: invocation.traceId, appId: invocation.appId, idempotencyKey: invocation.idempotencyKey, capabilityVersion: invocation.capabilityVersion });
  }

  private async executeOnce(capabilityId: string, input: unknown, identity: ExecutionContext["identity"], options: { requestId?: string; traceId?: string; idempotencyKey?: string; appId?: string; capabilityVersion?: string } = {}): Promise<RuntimeResult> {
    const requestId = options.requestId ?? randomUUID();
    const traceId = options.traceId ?? randomUUID();
    const fail = (code: string, message: string, retryable = false, fieldErrors?: Record<string, string[]>): RuntimeResult => ({
      protocolVersion: A2API_PROTOCOL_VERSION, success: false, requestId, traceId, capability: capabilityId,
      error: { code, message, retryable, ...(fieldErrors ? { fieldErrors } : {}) }
    });
    const stored = this.registry.get(capabilityId, options.capabilityVersion);
    if (!stored || stored.asset.kind !== "a2api") return fail("CAPABILITY_NOT_FOUND", "Published capability was not found");
    const capability = stored.asset as A2APICapability;
    if (!capability.auth.roles.some(role => identity.roles.includes(role))) return fail("FORBIDDEN", "Identity does not have a permitted role");
    if (capability.permissions.some(permission => !identity.permissions?.includes(permission))) return fail("FORBIDDEN", "Identity is missing one or more required permissions");
    if (capability.auth.tenantRequired && !identity.tenantId) return fail("TENANT_REQUIRED", "A tenant identity is required");
    if (capability.visibility !== "system" && capability.tenantId !== identity.tenantId) return fail("TENANT_MISMATCH", "Asset is not available to this tenant");
    if (capability.idempotency.required && !options.idempotencyKey) return fail("IDEMPOTENCY_KEY_REQUIRED", "This operation requires an idempotency key");

    const inputValidator = this.validator(`${stored.hash}:input`, capability.inputSchema);
    if (!inputValidator(input)) return fail("INVALID_INPUT", "Input does not satisfy the published capability schema", false, this.formatErrors(inputValidator));
    const controller = new AbortController();
    const context: ExecutionContext = { identity, appId: options.appId ?? "runtime", traceId, requestId, idempotencyKey: options.idempotencyKey, signal: controller.signal };
    for (const name of capability.preconditions) {
      const check = this.preconditions.get(name);
      if (!check) return fail("PRECONDITION_NOT_CONFIGURED", "Precondition " + name + " is not registered");
      try {
        if (!await check(input, context)) return fail("PRECONDITION_FAILED", "Precondition " + name + " was not satisfied");
      } catch (error) {
        return fail("PRECONDITION_ERROR", error instanceof Error ? error.message : "Precondition " + name + " failed");
      }
    }
    const adapter = this.adapters.get(capability.mapping.adapter);
    if (!adapter) return fail("ADAPTER_NOT_CONFIGURED", `Adapter '${capability.mapping.adapter}' is not registered`);

    this.emit({ type: "execution.started", traceId, requestId, capability: capabilityId, at: new Date().toISOString() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(new Error("ADAPTER_TIMEOUT")); reject(new Error("ADAPTER_TIMEOUT")); }, capability.mapping.timeoutMs);
      });
      const data = await Promise.race([adapter(input, context), timeout]);
      const outputValidator = this.validator(`${stored.hash}:output`, capability.outputSchema);
      if (!outputValidator(data)) {
        const message = "Adapter response does not satisfy the published output schema";
        this.emit({ type: "execution.failed", traceId, requestId, capability: capabilityId, at: new Date().toISOString(), detail: message });
        return fail("OUTPUT_CONTRACT_VIOLATION", message, false, this.formatErrors(outputValidator));
      }
      const result: RuntimeResult = { protocolVersion: A2API_PROTOCOL_VERSION, success: true, requestId, traceId, capability: capabilityId, data, effects: capability.effects };
      this.emit({ type: "execution.succeeded", traceId, requestId, capability: capabilityId, at: new Date().toISOString() });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown adapter error";
      this.emit({ type: "execution.failed", traceId, requestId, capability: capabilityId, at: new Date().toISOString(), detail: message });
      return fail(message === "ADAPTER_TIMEOUT" ? "TIMEOUT" : "ADAPTER_ERROR", message, message === "ADAPTER_TIMEOUT");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private validator(key: string, schema: Record<string, unknown>): ValidateFunction {
    let validate = this.validators.get(key);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.validators.set(key, validate);
    }
    return validate;
  }

  private formatErrors(validate: ValidateFunction): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const error of validate.errors ?? []) {
      const path = error.instancePath || "$";
      (result[path] ??= []).push(error.message ?? "Invalid value");
    }
    return result;
  }

  private emit(event: RuntimeEvent): void { this.events.push(event); this.onEvent?.(event); }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + stableStringify(object[key])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
