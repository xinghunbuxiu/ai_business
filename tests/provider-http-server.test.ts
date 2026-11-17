import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createProviderHttpServer } from "../src/provider-http-server.js";
import type { ProviderControlPlane } from "../src/provider-control-plane.js";

describe("Provider control-plane HTTP server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function start(actor: unknown = {
    projectId: "commerce", serviceId: "orders", providerId: "orders-java",
    subject: "svc-orders", permissions: ["provider:register", "provider:heartbeat", "provider:manage", "provider:read", "provider:discover"]
  }) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const controlPlane = {
      async register(...args: unknown[]) { calls.push({ method: "register", args }); return { state: "active" }; },
      async heartbeat(...args: unknown[]) { calls.push({ method: "heartbeat", args }); return { state: "active" }; },
      async drain(...args: unknown[]) { calls.push({ method: "drain", args }); return { state: "draining" }; },
      async revoke(...args: unknown[]) { calls.push({ method: "revoke", args }); return { state: "revoked" }; },
      async status(...args: unknown[]) { calls.push({ method: "status", args }); return { state: "active", instanceId: "pod-1" }; },
      async discover(...args: unknown[]) { calls.push({ method: "discover", args }); return [{ instanceId: "pod-1" }]; }
    } as unknown as ProviderControlPlane;
    const server = createProviderHttpServer(controlPlane, () => actor as never);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    close = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return { base: `http://127.0.0.1:${address.port}/providers`, calls };
  }

  it("derives ownership keys from authenticated identity, not request JSON", async () => {
    const { base, calls } = await start();
    const response = await fetch(base + "/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "attacker", serviceId: "other", providerId: "other", environment: "prod", instanceId: "pod-1" })
    });
    expect(response.status).toBe(200);
    expect(calls[0].args[0]).toEqual({
      projectId: "commerce", serviceId: "orders", providerId: "orders-java",
      environment: "prod", instanceId: "pod-1"
    });
  });

  it("exposes scoped status and discovery routes", async () => {
    const { base, calls } = await start();
    const status = await fetch(base + "/prod/pod-1/status");
    expect(status.status).toBe(200);
    const discovery = await fetch(base + "/discover?capabilityId=orders.create&capabilityVersion=1.0.0&environment=prod");
    expect(discovery.status).toBe(200);
    expect(calls.map(call => call.method)).toEqual(["status", "discover"]);
  });

  it("rejects missing authenticated identity and non-JSON writes", async () => {
    const unauthenticated = await start(null);
    const denied = await fetch(unauthenticated.base + "/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    expect(denied.status).toBe(401);
    await close?.(); close = undefined;

    const authenticated = await start();
    const media = await fetch(authenticated.base + "/heartbeat", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}"
    });
    expect(media.status).toBe(415);
  });

  it("maps duplicate provider registration to HTTP 409", async () => {
    const server = createProviderHttpServer({
      async register() { throw new Error("PROVIDER_ALREADY_REGISTERED: duplicate"); }
    } as unknown as ProviderControlPlane, () => ({
      projectId: "commerce", serviceId: "orders", providerId: "orders-java",
      subject: "svc-orders", permissions: ["provider:register"]
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/providers/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}"
    });
    expect(response.status).toBe(409);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
});
