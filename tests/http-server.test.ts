import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AssetRegistry, ExecutionRuntime, createA2ApiHttpServer, type A2APICapability } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion: "1.0", protocolVersion: "1.0.0", id: "employee.create", version: "1.0.0",
  kind: "a2api", name: "Create employee", status: "draft", visibility: "system", permissions: ["employee:create"], dependencies: [],
  inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  outputSchema: { type: "object", required: ["employeeId"], properties: { employeeId: { type: "string" } } },
  errors: [], auth: { roles: ["merchant_owner"], tenantRequired: true }, preconditions: [], effects: ["employee.created"],
  mapping: { adapter: "test", operation: "employee.create", timeoutMs: 1000 }, idempotency: { required: true, keyFrom: "request.idempotencyKey" },
  testEvidence: { suite: "unit", passed: 1, failed: 0 }
};

describe("A2API HTTP server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function start(resolveIdentity: (request: import("node:http").IncomingMessage) => unknown = () => ({
    userId: "u1", tenantId: "tenant-a", roles: ["merchant_owner"], permissions: ["employee:create"]
  })) {
    const registry = new AssetRegistry();
    registry.register(capability);
    registry.publish(capability.id, capability.version);
    const runtime = new ExecutionRuntime(registry);
    runtime.registerAdapter("test", async input => ({ employeeId: "emp-1", name: (input as {name:string}).name }));
    const server = createA2ApiHttpServer(runtime, resolveIdentity as never);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    close = () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return `http://127.0.0.1:${address.port}/a2api/invoke`;
  }

  const invocation = {
    protocolVersion: "1.0.0", capabilityId: "employee.create", capabilityVersion: "1.0.0",
    requestId: "req-1", traceId: "trace-1", appId: "merchant-app", idempotencyKey: "once",
    input: { name: "Alex" }
  };

  it("authenticates at the host boundary and returns the runtime envelope", async () => {
    const url = await start();
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invocation) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ protocolVersion: "1.0.0", success: true, requestId: "req-1", traceId: "trace-1", data: { employeeId: "emp-1" } });
  });

  it("does not trust identity fields supplied in the request body", async () => {
    const url = await start(() => undefined);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...invocation, identity: { userId: "attacker", roles: ["merchant_owner"], tenantId: "tenant-a" } }) });
    expect(response.status).toBe(401);
  });

  it("rejects malformed envelopes and non-JSON requests", async () => {
    const url = await start();
    const malformed = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...invocation, capabilityVersion: undefined }) });
    expect(malformed.status).toBe(400);
    const media = await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(media.status).toBe(415);
  });
});
