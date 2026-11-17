import type { Adapter } from "./runtime.js";
import type { ExecutionContext } from "./types.js";
import type { ProviderRegistration } from "./provider.js";
import type { ProviderRepository } from "./provider-repository.js";
import { HttpJsonProviderTransport, ProviderTransportError } from "./provider-transport.js";

/** Adapter factory for durable ProviderRepository discovery (PostgreSQL, etc.). */
export function createRepositoryProviderAdapter(options: {
  capabilityId: string;
  capabilityVersion: string;
  environment: ProviderRegistration["environment"];
  repository: ProviderRepository;
  transport: HttpJsonProviderTransport;
}): Adapter {
  return async (input: unknown, context: ExecutionContext) => {
    const providers = await options.repository.listActive({
      capabilityId: options.capabilityId,
      capabilityVersion: options.capabilityVersion,
      environment: options.environment
    });
    if (providers.length === 0) throw new ProviderTransportError("PROVIDER_NOT_FOUND", "No active provider is registered for the exact capability pin");
    const selected = providers[0];
    return options.transport.invoke(selected, {
      protocolVersion: "1.0.0",
      capabilityId: options.capabilityId,
      capabilityVersion: options.capabilityVersion,
      requestId: context.requestId,
      traceId: context.traceId,
      appId: context.appId,
      idempotencyKey: context.idempotencyKey,
      input
    }, context.signal);
  };
}
