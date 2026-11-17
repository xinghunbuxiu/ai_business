import { describe, expect, it } from "vitest";
import { AssetRegistry, ProviderRegistry, type A2APICapability } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion: "1.0", protocolVersion: "1.0.0", id: "commerce.orders.create", version: "1.0.0",
  kind: "a2api", name: "Create order", status: "draft", visibility: "system", permissions: ["order:create"], dependencies: [],
  inputSchema: { type: "object" }, outputSchema: { type: "object" }, errors: [],
  auth: { roles: ["merchant_owner"], tenantRequired: true }, preconditions: [], effects: ["order.created"],
  mapping: { adapter: "provider", operation: "createOrder", timeoutMs: 5000 },
  idempotency: { required: true, keyFrom: "request.idempotencyKey" },
  testEvidence: { suite: "unit", passed: 1, failed: 0 }
};

function setup() {
  const assets = new AssetRegistry();
  assets.register(capability);
  const published = assets.publish(capability.id, capability.version);
  const providers = new ProviderRegistry(assets, bindingRef => bindingRef === "secret://prod/commerce/orders");
  const now = new Date("2026-11-17T00:00:00.000Z");
  const registration = {
    registrationProtocolVersion: "1.0.0",
    projectId: "commerce",
    serviceId: "orders",
    providerId: "orders-java",
    environment: "prod",
    instanceId: "pod-1",
    capabilities: [{ capabilityId: capability.id, capabilityVersion: capability.version, contractHash: published.hash }],
    transport: { type: "https-json", bindingRef: "secret://prod/commerce/orders" },
    lease: { issuedAt: "2026-11-17T00:00:00.000Z", expiresAt: "2026-11-17T00:05:00.000Z" }
  };
  return { providers, registration, now };
}

describe("ProviderRegistry", () => {
  it("registers only a project-authenticated provider with published exact contract pins", () => {
    const { providers, registration, now } = setup();
    expect(() => providers.register(registration, "other-project", now)).toThrow(/PROVIDER_PROJECT_FORBIDDEN/);
    expect(providers.register(registration, "commerce", now).state).toBe("active");
    expect(providers.list({ capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod", now })).toHaveLength(1);
  });

  it("rejects a provider claiming an unpublished version or a mismatched contract hash", () => {
    const { providers, registration, now } = setup();
    const missing = { ...registration, capabilities: [{ ...registration.capabilities[0], capabilityVersion: "9.9.9" }] };
    expect(() => providers.register(missing, "commerce", now)).toThrow(/PROVIDER_CAPABILITY_NOT_PUBLISHED/);
    const tampered = { ...registration, capabilities: [{ ...registration.capabilities[0], contractHash: "a".repeat(64) }] };
    expect(() => providers.register(tampered, "commerce", now)).toThrow(/PROVIDER_CONTRACT_HASH_MISMATCH/);
  });

  it("rejects duplicate instances, expired leases and malformed registration data", () => {
    const { providers, registration, now } = setup();
    providers.register(registration, "commerce", now);
    expect(() => providers.register(registration, "commerce", now)).toThrow(/PROVIDER_INSTANCE_EXISTS/);
    expect(() => providers.register({ ...registration, lease: { issuedAt: "2026-11-17T00:00:00.000Z", expiresAt: "2026-11-17T00:00:00.000Z" } }, "commerce", now)).toThrow(/PROVIDER_REGISTRATION_INVALID/);
    expect(() => providers.register(registration, "commerce", new Date("2026-11-17T00:06:00.000Z"))).toThrow(/PROVIDER_LEASE_INVALID/);
  });

  it("does not route draining, revoked or expired providers", () => {
    const { providers, registration, now } = setup();
    providers.register(registration, "commerce", now);
    const query = { capabilityId: capability.id, capabilityVersion: "1.0.0", environment: "prod" as const, now };
    expect(providers.list(query)).toHaveLength(1);
    providers.setState({ projectId: "commerce", serviceId: "orders", providerId: "orders-java", environment: "prod", instanceId: "pod-1" }, "draining");
    expect(providers.list(query)).toHaveLength(0);
    expect(providers.removeExpired(new Date("2026-11-17T00:06:00.000Z"))).toBe(1);
  });
});
