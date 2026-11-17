import { describe, expect, it } from "vitest";
import { AssetRegistry, ExecutionRuntime, IntentResolver, type A2APICapability } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion:"1.0", id:"employee.create", version:"1.0.0", kind:"a2api", name:"Create employee", status:"draft", visibility:"system", permissions:["employee:create"], dependencies:[],
  inputSchema:{type:"object",required:["name"],properties:{name:{type:"string"}}}, outputSchema:{type:"object",required:["employeeId","status"],properties:{employeeId:{type:"string"},status:{type:"string"}}}, errors:[], auth:{roles:["merchant_owner"],tenantRequired:true}, preconditions:[], effects:["employee.created"], mapping:{adapter:"control",operation:"employee.create",timeoutMs:1000}, idempotency:{required:true,keyFrom:"request.idempotencyKey"},
  testEvidence:{suite:"unit",passed:2,failed:0}
};
function publishedRegistry(asset: A2APICapability = capability) { const r = new AssetRegistry(); r.register(asset); r.publish(asset.id, asset.version); return r; }

describe("AssetRegistry", () => {
  it("requires passing evidence before publish and rejects duplicate immutable versions", () => {
    const r = new AssetRegistry(); const draft = {...capability, testEvidence:undefined};
    r.register(draft);
    expect(() => r.publish(draft.id,draft.version)).toThrow(/PUBLISH_BLOCKED/);
    const next = {...capability, version:"1.0.1"};
    r.register(next);
    expect(() => r.register(next)).toThrow(/ASSET_IMMUTABLE/);
  });
  it("accepts semantic versions and only resolves published assets", () => {
    const r = new AssetRegistry();
    expect(() => r.register({ ...capability, version: "2.4.1" })).not.toThrow();
    r.register(capability);
    expect(r.get(capability.id)).toBeUndefined();
    r.publish(capability.id,capability.version);
    expect(r.get(capability.id)?.asset.status).toBe("published");
  });
});

describe("IntentResolver", () => {
  it("matches only assets allowed for the caller role", () => {
    const r = publishedRegistry(); const resolver = new IntentResolver(r);
    const context = {identity:{userId:"u1",tenantId:"t1",roles:["cashier"]},appId:"merchant",traceId:"t",requestId:"r"};
    expect(resolver.resolve({text:"add employee",intent:"employee.create",appId:"merchant",context}).clarificationRequired).toBe(true);
  });
});

describe("ExecutionRuntime", () => {
  it("enforces role and tenant, then executes once for an idempotency key", async () => {
    const r = publishedRegistry(); const runtime = new ExecutionRuntime(r); let calls = 0;
    runtime.registerAdapter("control", async () => ({employeeId:"e1",status:"created",call:++calls}));
    const identity = {userId:"u1",tenantId:"tenant-a",roles:["merchant_owner"]};
    const first = await runtime.execute("employee.create",{name:"A"},identity,{idempotencyKey:"once"});
    const second = await runtime.execute("employee.create",{name:"A"},identity,{idempotencyKey:"once"});
    expect(first.success).toBe(true); expect(second).toEqual(first); expect(calls).toBe(1);
    const denied = await runtime.execute("employee.create",{name:"A"}, {...identity,roles:["consumer"]},{idempotencyKey:"denied"});
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe("FORBIDDEN");
  });

  it("validates request and response against the A2API contract", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    runtime.registerAdapter("control", async () => ({employeeId:"e1",status:"created"}));
    const identity = {userId:"u1",tenantId:"tenant-a",roles:["merchant_owner"]};
    const invalid = await runtime.execute("employee.create",{},identity,{idempotencyKey:"bad-input"});
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.code).toBe("INVALID_INPUT");
    const valid = await runtime.execute("employee.create",{name:"A"},identity,{idempotencyKey:"good-input"});
    expect(valid.success).toBe(true);
  });

  it("passes an abort signal to adapters when execution times out", async () => {
    const slow = { ...capability, version: "1.0.2", mapping: { ...capability.mapping, timeoutMs: 10 } };
    const runtime = new ExecutionRuntime(publishedRegistry(slow));
    let aborted = false;
    runtime.registerAdapter("control", async (_input, context) => new Promise((resolve) => {
      context.signal?.addEventListener("abort", () => { aborted = true; resolve({ employeeId: "late", status: "created" }); }, { once: true });
    }));
    const result = await runtime.execute("employee.create", { name: "A" }, { userId: "u1", tenantId: "t1", roles: ["merchant_owner"] }, { idempotencyKey: "timeout" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("TIMEOUT");
    expect(aborted).toBe(true);
  });

  it("rejects adapter output that violates the declared output schema", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    runtime.registerAdapter("control", async () => ({unexpected:true}));
    const result = await runtime.execute("employee.create",{name:"A"},{userId:"u1",tenantId:"t1",roles:["merchant_owner"]},{idempotencyKey:"output"});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("OUTPUT_CONTRACT_VIOLATION");
  });
});
