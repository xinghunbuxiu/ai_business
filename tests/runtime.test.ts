import { describe, expect, it } from "vitest";
import { AssetRegistry, ExecutionRuntime, IntentResolver, type A2APICapability } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion:"1.0", id:"employee.create", version:"1.0.0", kind:"a2api", name:"Create employee", status:"draft", visibility:"system", permissions:["employee:create"], dependencies:[],
  inputSchema:{type:"object"}, outputSchema:{type:"object"}, errors:[], auth:{roles:["merchant_owner"],tenantRequired:true}, preconditions:[], effects:["employee.created"], mapping:{adapter:"control",operation:"employee.create",timeoutMs:1000}, idempotency:{required:true,keyFrom:"request.idempotencyKey"},
  testEvidence:{suite:"unit",passed:2,failed:0}
};
function publishedRegistry() { const r = new AssetRegistry(); r.register(capability); r.publish(capability.id, capability.version); return r; }

describe("AssetRegistry", () => {
  it("requires passing evidence before publish and freezes released versions", () => {
    const r = new AssetRegistry(); const draft = {...capability, testEvidence:undefined};
    r.register(draft);
    expect(() => r.publish(draft.id,draft.version)).toThrow(/PUBLISH_BLOCKED/);
    r.register({...capability, version:"1.0.1"});
    expect(() => r.register(capability)).toThrow(/ASSET_IMMUTABLE/);
  });
  it("only resolves published assets", () => {
    const r = new AssetRegistry(); r.register(capability);
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
    const denied = await runtime.execute("employee.create",{}, {...identity,roles:["consumer"]},{idempotencyKey:"denied"});
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe("FORBIDDEN");
  });
});
