import { describe, expect, it, vi } from "vitest";
import { AssetRegistry, ExecutionRuntime, ProviderRegistry, HttpJsonProviderTransport, createProviderAdapter, type A2APICapability } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion: "1.0", protocolVersion: "1.0.0", id: "commerce.orders.create", version: "1.0.0",
  kind: "a2api", name: "Create order", status: "draft", visibility: "system", permissions: ["order:create"], dependencies: [],
  inputSchema: { type: "object" }, outputSchema: { type: "object" }, errors: [],
  auth: { roles: ["merchant_owner"], tenantRequired: true }, preconditions: [], effects: ["order.created"],
  mapping: { adapter: "provider", operation: "createOrder", timeoutMs: 5000 },
  idempotency: { required: true, keyFrom: "request.idempotencyKey" },
  testEvidence: { suite: "unit", passed: 1, failed: 0 }
};

function fixture() {
  const assets = new AssetRegistry();
  assets.register(capability);
  const published = assets.publish(capability.id, capability.version);
  const registry = new ProviderRegistry(assets, bindingRef => bindingRef === "secret://commerce/orders");
  const now = new Date("2026-11-17T00:00:00.000Z");
  registry.register({
    registrationProtocolVersion: "1.0.0", projectId: "commerce", serviceId: "orders", providerId: "orders-java",
    environment: "prod", instanceId: "pod-1",
    capabilities: [{ capabilityId: capability.id, capabilityVersion: capability.version, contractHash: published.hash }],
    transport: { type: "https-json", bindingRef: "secret://commerce/orders" },
    lease: { issuedAt: "2026-11-17T00:00:00.000Z", expiresAt: "2099-11-17T00:05:00.000Z" }
  }, "commerce", now);
  return registry;
}

const context = {
  identity: { userId: "u1", tenantId: "tenant-1", roles: ["merchant_owner"], permissions: ["order:create"] },
  appId: "merchant-app", traceId: "trace-1", requestId: "request-1", idempotencyKey: "idem-1"
};

describe("HttpJsonProviderTransport", () => {
  it("sends the exact A2API invocation and unwraps a correlated provider response", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        protocolVersion: "1.0.0", requestId: request.requestId, traceId: request.traceId,
        success: true, data: { orderId: "o-1", status: "created" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const transport = new HttpJsonProviderTransport({
      resolve: async ref => {
        expect(ref).toBe("secret://commerce/orders");
        return { endpointUrl: "https://orders.internal/a2api/invoke", headers: { authorization: "Bearer server-token" } };
      }
    }, fetcher);
    const adapter = createProviderAdapter({ capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod", registry: fixture(), transport });
    const result = await adapter({ total: 99 }, context);
    expect(result).toEqual({ orderId: "o-1", status: "created" });
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      protocolVersion: "1.0.0", capabilityId: capability.id, capabilityVersion: "1.0.0",
      requestId: "request-1", traceId: "trace-1", appId: "merchant-app", idempotencyKey: "idem-1", input: { total: 99 }
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("identity");
    expect(init.headers).toMatchObject({ authorization: "Bearer server-token" });
  });

  it("rejects non-HTTPS endpoint bindings by default", async () => {
    const transport = new HttpJsonProviderTransport({
      resolve: async () => ({ endpointUrl: "http://orders.internal/invoke", headers: {} })
    }, vi.fn() as never);
    const provider = fixture().list({ capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod" })[0];
    await expect(transport.invoke(provider, {
      protocolVersion: "1.0.0", capabilityId: capability.id, capabilityVersion: "1.0.0",
      requestId: "r", traceId: "t", appId: "app", idempotencyKey: "k", input: {}
    })).rejects.toMatchObject({ code: "PROVIDER_BINDING_INSECURE" });
  });

  it("rejects mismatched correlation IDs and malformed provider envelopes", async () => {
    const provider = fixture().list({ capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod" })[0];
    const bindings = { resolve: async () => ({ endpointUrl: "https://orders.internal/invoke", headers: {} }) };
    const mismatch = new HttpJsonProviderTransport(bindings, vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: "1.0.0", requestId: "wrong", traceId: "t", success: true, data: {}
    }), { status: 200, headers: { "content-type": "application/json" } })) as never);
    await expect(mismatch.invoke(provider, {
      protocolVersion: "1.0.0", capabilityId: capability.id, capabilityVersion: "1.0.0",
      requestId: "r", traceId: "t", appId: "app", input: {}
    })).rejects.toMatchObject({ code: "PROVIDER_CORRELATION_MISMATCH" });
    const malformed = new HttpJsonProviderTransport(bindings, vi.fn(async () => new Response("{}", {
      status: 200, headers: { "content-type": "application/json" }
    })) as never);
    await expect(malformed.invoke(provider, {
      protocolVersion: "1.0.0", capabilityId: capability.id, capabilityVersion: "1.0.0",
      requestId: "r", traceId: "t", appId: "app", input: {}
    })).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("maps provider-declared errors without losing stable error codes", async () => {
    const provider = fixture().list({ capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod" })[0];
    const transport = new HttpJsonProviderTransport({
      resolve: async () => ({ endpointUrl: "https://orders.internal/invoke", headers: {} })
    }, vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: "1.0.0", requestId: "r", traceId: "t", success: false,
      error: { code: "ORDER_OUT_OF_STOCK", message: "Insufficient stock", retryable: false }
    }), { status: 200, headers: { "content-type": "application/json" } })) as never);
    await expect(transport.invoke(provider, {
      protocolVersion: "1.0.0", capabilityId: capability.id, capabilityVersion: "1.0.0",
      requestId: "r", traceId: "t", appId: "app", input: {}
    })).rejects.toMatchObject({ code: "ORDER_OUT_OF_STOCK" });
  });

  it("does not silently route when no provider is registered", async () => {
    const empty = new ProviderRegistry(new AssetRegistry(), () => false);
    const transport = new HttpJsonProviderTransport({ resolve: async () => ({ endpointUrl: "https://x", headers: {} }) });
    const adapter = createProviderAdapter({ capabilityId: "commerce.orders.create", capabilityVersion: "1.0.0", environment: "prod", registry: empty, transport });
    await expect(adapter({}, context)).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
  });

  it("preserves provider business error codes through the A2API Runtime", async () => {
    const assets = new AssetRegistry();
    assets.register(capability);
    assets.publish(capability.id, capability.version);
    const providers = new ProviderRegistry(assets, bindingRef => bindingRef === "secret://commerce/orders");
    providers.register({
      registrationProtocolVersion: "1.0.0", projectId: "commerce", serviceId: "orders", providerId: "orders-java",
      environment: "prod", instanceId: "pod-1",
      capabilities: [{ capabilityId: capability.id, capabilityVersion: capability.version, contractHash: assets.get(capability.id, capability.version)!.hash }],
      transport: { type: "https-json", bindingRef: "secret://commerce/orders" },
      lease: { issuedAt: "2026-11-17T00:00:00.000Z", expiresAt: "2099-11-17T00:05:00.000Z" }
    }, "commerce", new Date("2026-11-17T00:00:00.000Z"));
    const transport = new HttpJsonProviderTransport({
      resolve: async () => ({ endpointUrl: "https://orders.internal/invoke", headers: {} })
    }, vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: "1.0.0", requestId: "request-1", traceId: "trace-1", success: false,
      error: { code: "ORDER_OUT_OF_STOCK", message: "Insufficient stock", retryable: false }
    }), { status: 200, headers: { "content-type": "application/json" } })) as never);
    const runtime = new ExecutionRuntime(assets);
    runtime.registerAdapter("provider", createProviderAdapter({
      capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod", registry: providers, transport
    }));
    const result = await runtime.execute(capability.id, { total: 10 }, context.identity, {
      requestId: context.requestId, traceId: context.traceId, appId: context.appId,
      idempotencyKey: context.idempotencyKey, capabilityVersion: "1.0.0"
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("ORDER_OUT_OF_STOCK");
  });

});
