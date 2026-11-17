import { z } from "zod";
import type { Adapter } from "./runtime.js";
import type { ExecutionContext } from "./types.js";
import type { ProviderRegistry, RegisteredProvider } from "./provider.js";

export type ProviderBinding = {
  /** Resolved only by trusted server configuration; never accepted as a request URL. */
  endpointUrl: string;
  /** Service credentials / gateway-signed identity context from a secret manager. */
  headers: Record<string, string>;
};

export interface ProviderBindingResolver {
  resolve(bindingRef: string, provider: RegisteredProvider): Promise<ProviderBinding>;
}

export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const ProviderSuccessSchema = z.object({
  protocolVersion: z.literal("1.0.0"),
  requestId: z.string(),
  traceId: z.string(),
  success: z.literal(true),
  data: z.unknown()
}).strict();

const ProviderFailureSchema = z.object({
  protocolVersion: z.literal("1.0.0"),
  requestId: z.string(),
  traceId: z.string(),
  success: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().default(false)
  }).strict()
}).strict();

const ProviderResponseSchema = z.discriminatedUnion("success", [
  ProviderSuccessSchema,
  ProviderFailureSchema
]);

export type ProviderInvocation = {
  protocolVersion: "1.0.0";
  capabilityId: string;
  capabilityVersion: string;
  requestId: string;
  traceId: string;
  appId: string;
  idempotencyKey?: string;
  input: unknown;
};

export class ProviderTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

export class HttpJsonProviderTransport {
  constructor(
    private readonly bindings: ProviderBindingResolver,
    private readonly fetcher: ProviderFetch = fetch,
    private readonly options: { allowInsecureHttp?: boolean; maxResponseBytes?: number } = {}
  ) {}

  async invoke(provider: RegisteredProvider, invocation: ProviderInvocation, signal?: AbortSignal): Promise<unknown> {
    if (provider.registration.transport.type !== "https-json") {
      throw new ProviderTransportError("PROVIDER_TRANSPORT_UNSUPPORTED", "This transport only supports https-json");
    }

    const binding = await this.bindings.resolve(provider.registration.transport.bindingRef, provider);
    let endpoint: URL;
    try {
      endpoint = new URL(binding.endpointUrl);
    } catch {
      throw new ProviderTransportError("PROVIDER_BINDING_INVALID", "Provider endpoint binding is not a valid URL");
    }
    const secure = endpoint.protocol === "https:";
    const localHttp = endpoint.protocol === "http:" && this.options.allowInsecureHttp === true;
    if (!secure && !localHttp) {
      throw new ProviderTransportError("PROVIDER_BINDING_INSECURE", "Provider endpoint must use HTTPS");
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new ProviderTransportError("PROVIDER_BINDING_INVALID", "Provider endpoint must not contain credentials or a fragment");
    }

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          ...binding.headers,
          "content-type": "application/json",
          "accept": "application/json"
        },
        body: JSON.stringify(invocation),
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw new ProviderTransportError("PROVIDER_CALL_ABORTED", "Provider call was aborted", true);
      throw new ProviderTransportError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "Provider request failed", true);
    }

    const maxBytes = this.options.maxResponseBytes ?? 1_048_576;
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > maxBytes) {
      throw new ProviderTransportError("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds the configured size limit");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new ProviderTransportError("PROVIDER_RESPONSE_INVALID", "Provider response must use application/json");
    }

    let raw: unknown;
    try {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw new ProviderTransportError("PROVIDER_RESPONSE_TOO_LARGE", "Provider response exceeds the configured size limit");
      }
      raw = JSON.parse(text);
    } catch (error) {
      if (error instanceof ProviderTransportError) throw error;
      throw new ProviderTransportError("PROVIDER_RESPONSE_INVALID", "Provider response is not valid JSON");
    }

    const parsed = ProviderResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderTransportError("PROVIDER_RESPONSE_INVALID", "Provider response does not match the A2API provider envelope");
    }
    const envelope = parsed.data;
    if (envelope.requestId !== invocation.requestId || envelope.traceId !== invocation.traceId) {
      throw new ProviderTransportError("PROVIDER_CORRELATION_MISMATCH", "Provider response requestId/traceId does not match the invocation");
    }
    if (!response.ok) {
      throw new ProviderTransportError("PROVIDER_HTTP_ERROR", "Provider returned HTTP " + response.status, response.status >= 500);
    }
    if (!envelope.success) {
      throw new ProviderTransportError(envelope.error.code, envelope.error.message, envelope.error.retryable);
    }
    return envelope.data;
  }
}

/**
 * Creates a Runtime Adapter pinned to one exact capability version.
 * Provider selection is deterministic. It deliberately does not fail over
 * after a write attempt: a timeout may happen after the provider committed.
 */
export function createProviderAdapter(options: {
  capabilityId: string;
  capabilityVersion: string;
  environment: RegisteredProvider["registration"]["environment"];
  registry: ProviderRegistry;
  transport: HttpJsonProviderTransport;
  selectProvider?: (providers: RegisteredProvider[]) => RegisteredProvider;
}): Adapter {
  return async (input: unknown, context: ExecutionContext) => {
    const providers = options.registry.list({
      capabilityId: options.capabilityId,
      capabilityVersion: options.capabilityVersion,
      environment: options.environment
    });
    if (providers.length === 0) {
      throw new ProviderTransportError("PROVIDER_NOT_FOUND", "No active provider is registered for the exact capability pin");
    }
    const sorted = [...providers].sort((a, b) => {
      const left = [a.registration.projectId, a.registration.serviceId, a.registration.providerId, a.registration.instanceId].join("/");
      const right = [b.registration.projectId, b.registration.serviceId, b.registration.providerId, b.registration.instanceId].join("/");
      return left.localeCompare(right);
    });
    const selected = options.selectProvider ? options.selectProvider(sorted) : sorted[0];
    if (!sorted.includes(selected)) {
      throw new ProviderTransportError("PROVIDER_SELECTION_INVALID", "Provider selection policy returned an unregistered provider");
    }
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
