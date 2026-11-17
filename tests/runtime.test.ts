import { describe, expect, it } from "vitest";
import { AssetRegistry, AppBuilderPlanner, ExecutionRuntime, IntentResolver, validateAsset, type A2APICapability } from "../src/index.js";

const capability: A2APICapability = {
  schemaVersion:"1.0", protocolVersion:"1.0.0", id:"employee.create", version:"1.0.0", kind:"a2api", name:"Create employee", status:"draft", visibility:"system", permissions:["employee:create"], dependencies:[],
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
    const identity = {userId:"u1",tenantId:"tenant-a",roles:["merchant_owner"],permissions:["employee:create"]};
    const first = await runtime.execute("employee.create",{name:"A"},identity,{idempotencyKey:"once",capabilityVersion:"1.0.0"});
    const second = await runtime.execute("employee.create",{name:"A"},identity,{idempotencyKey:"once",capabilityVersion:"1.0.0"});
    expect(first.success).toBe(true); expect(second).toEqual(first); expect(calls).toBe(1);
    const denied = await runtime.execute("employee.create",{name:"A"}, {...identity,roles:["consumer"]},{idempotencyKey:"denied",capabilityVersion:"1.0.0"});
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe("FORBIDDEN");
  });

  it("validates request and response against the A2API contract", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    runtime.registerAdapter("control", async () => ({employeeId:"e1",status:"created"}));
    const identity = {userId:"u1",tenantId:"tenant-a",roles:["merchant_owner"],permissions:["employee:create"]};
    const invalid = await runtime.execute("employee.create",{},identity,{idempotencyKey:"bad-input",capabilityVersion:"1.0.0"});
    expect(invalid.success).toBe(false);
    if (!invalid.success) expect(invalid.error.code).toBe("INVALID_INPUT");
    const valid = await runtime.execute("employee.create",{name:"A"},identity,{idempotencyKey:"good-input",capabilityVersion:"1.0.0"});
    expect(valid.success).toBe(true);
  });

  it("passes an abort signal to adapters when execution times out", async () => {
    const slow = { ...capability, version: "1.0.2", mapping: { ...capability.mapping, timeoutMs: 10 } };
    const runtime = new ExecutionRuntime(publishedRegistry(slow));
    let aborted = false;
    runtime.registerAdapter("control", async (_input, context) => new Promise((resolve) => {
      context.signal?.addEventListener("abort", () => { aborted = true; resolve({ employeeId: "late", status: "created" }); }, { once: true });
    }));
    const result = await runtime.execute("employee.create", { name: "A" }, { userId: "u1", tenantId: "t1", roles: ["merchant_owner"], permissions: ["employee:create"] }, { idempotencyKey: "timeout", capabilityVersion: "1.0.2" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("TIMEOUT");
    expect(aborted).toBe(true);
  });

  it("deduplicates concurrent A2API calls and rejects idempotency-key payload changes", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    let calls = 0;
    runtime.registerAdapter("control", async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 15));
      return { employeeId: "e1", status: "created" };
    });
    const identity = { userId: "u1", tenantId: "t1", roles: ["merchant_owner"], permissions: ["employee:create"] };
    const [first, second] = await Promise.all([
      runtime.execute("employee.create", { name: "Alex" }, identity, { idempotencyKey: "same", capabilityVersion: "1.0.0" }),
      runtime.execute("employee.create", { name: "Alex" }, identity, { idempotencyKey: "same", capabilityVersion: "1.0.0" })
    ]);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    const conflict = await runtime.execute("employee.create", { name: "Bob" }, identity, { idempotencyKey: "same", capabilityVersion: "1.0.0" });
    expect(conflict.success).toBe(false);
    if (!conflict.success) expect(conflict.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects a caller missing the A2API permission even when its role matches", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    runtime.registerAdapter("control", async () => ({ employeeId: "e1", status: "created" }));
    const result = await runtime.execute("employee.create", { name: "A" }, { userId: "u", tenantId: "t", roles: ["merchant_owner"], permissions: [] }, { idempotencyKey: "no-permission", capabilityVersion: "1.0.0" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("requires an exact A2API capability version instead of resolving latest", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    const result = await runtime.execute("employee.create", { name: "A" }, { userId: "u", tenantId: "t", roles: ["merchant_owner"], permissions: ["employee:create"] }, { idempotencyKey: "no-version" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("CAPABILITY_VERSION_REQUIRED");
  });

  it("rejects unsupported A2API protocol versions and resolves an explicitly pinned capability version", async () => {
    const old = { ...capability, version: "1.0.0" };
    const next = { ...capability, version: "1.1.0", name: "Create employee v1.1" };
    const registry = new AssetRegistry(); registry.register(old); registry.publish(old.id, old.version); registry.register(next); registry.publish(next.id, next.version);
    const runtime = new ExecutionRuntime(registry);
    runtime.registerAdapter("control", async (_input, context) => ({ employeeId: context.appId, status: "created" }));
    const identity = { userId: "u", tenantId: "t", roles: ["merchant_owner"], permissions: ["employee:create"] };
    const result = await runtime.execute("employee.create", { name: "A" }, identity, { idempotencyKey: "pin", capabilityVersion: "1.0.0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ employeeId: "runtime" });
    const rejected = await runtime.executeInvocation({ protocolVersion: "2.0.0", capabilityId: "employee.create", capabilityVersion: "1.0.0", requestId: "r", traceId: "t", appId: "app", idempotencyKey: "k", input: { name: "A" } }, identity);
    expect(rejected.success).toBe(false);
    if (!rejected.success) expect(rejected.error.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
  });

  it("enforces declared A2API preconditions before invoking the adapter", async () => {
    const guarded = { ...capability, version: "1.0.3", preconditions: ["employee.active"] };
    const registry = publishedRegistry(guarded);
    const runtime = new ExecutionRuntime(registry);
    let invoked = false;
    runtime.registerPrecondition("employee.active", async () => false);
    runtime.registerAdapter("control", async () => { invoked = true; return { employeeId: "e1", status: "created" }; });
    const result = await runtime.execute("employee.create", { name: "A" }, { userId: "u", tenantId: "t", roles: ["merchant_owner"], permissions: ["employee:create"] }, { idempotencyKey: "precondition", capabilityVersion: "1.0.3" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("PRECONDITION_FAILED");
    expect(invoked).toBe(false);
  });

  it("rejects adapter output that violates the declared output schema", async () => {
    const runtime = new ExecutionRuntime(publishedRegistry());
    runtime.registerAdapter("control", async () => ({unexpected:true}));
    const result = await runtime.execute("employee.create",{name:"A"},{userId:"u1",tenantId:"t1",roles:["merchant_owner"],permissions:["employee:create"]},{idempotencyKey:"output",capabilityVersion:"1.0.0"});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("OUTPUT_CONTRACT_VIOLATION");
  });
});


describe("WorkflowRunner", () => {
  it("waits for a form and confirmation, executes A2API and takes a condition branch", async () => {
    const { WorkflowRunner } = await import("../src/index.js");
    const r = new AssetRegistry(); r.register(capability); r.publish(capability.id, capability.version);
    const form = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "merchant.form", version: "1.0.0", kind: "a2ui" as const, name: "Merchant form", status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [], component: "Form", propsSchema: {}, events: [], testEvidence: { suite: "unit", passed: 1, failed: 0 } };
    r.register(form); r.publish(form.id, form.version);
    const wf = {
      schemaVersion: "1.0", protocolVersion: "1.0.0", id: "merchant.onboarding.test", version: "1.0.0", kind: "a2wf" as const, name: "Onboarding",
      status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [],
      trigger: { intents: ["merchant.onboard"], roles: ["merchant_owner"] },
      steps: [
        { id: "details", type: "form" as const, component: "merchant.form", componentVersion: "1.0.0", input: {} },
        { id: "create", type: "action" as const, capability: "employee.create", capabilityVersion: "1.0.0", input: { name: { $ref: "outputs.details.name" } }, requiresConfirmation: true },
        { id: "check", type: "condition" as const, condition: { path: "outputs.create.status", operator: "eq" as const, value: "created" }, onTrue: "done", onFalse: "failed" },
        { id: "done", type: "end" as const }, { id: "failed", type: "end" as const }
      ],
      testEvidence: { suite: "unit", passed: 1, failed: 0 }
    };
    r.register(wf); r.publish(wf.id, wf.version);
    const runtime = new ExecutionRuntime(r);
    runtime.registerAdapter("control", async input => ({ employeeId: "e1", status: "created", name: (input as {name:string}).name }));
    const runner = new WorkflowRunner(r, runtime);
    const identity = { userId: "u1", tenantId: "t1", roles: ["merchant_owner"], permissions: ["employee:create"] };
    const first = await runner.start(wf.id, {}, identity);
    expect(first.execution.status).toBe("awaiting_input");
    const second = await runner.resume(first.execution.id, { name: "Alex" });
    expect(second.execution.status).toBe("awaiting_confirmation");
    const third = await runner.resume(first.execution.id, { confirmed: true });
    expect(third.execution.status).toBe("completed");
    expect(third.execution.outputs.create).toMatchObject({ employeeId: "e1", name: "Alex" });
  });
  it("enforces workflow trigger roles", async () => {
    const { WorkflowRunner } = await import("../src/index.js");
    const r = new AssetRegistry();
    const wf = { schemaVersion:"1.0", protocolVersion:"1.0.0", id:"restricted.workflow", version:"1.0.0", kind:"a2wf" as const, name:"Restricted", status:"draft" as const, visibility:"system" as const, permissions:[], dependencies:[], trigger:{intents:["restricted"],roles:["platform_admin"]}, steps:[{id:"end",type:"end" as const}], testEvidence:{suite:"unit",passed:1,failed:0} };
    r.register(wf); r.publish(wf.id,wf.version);
    const runner = new WorkflowRunner(r,new ExecutionRuntime(r));
    await expect(runner.start(wf.id,{}, {userId:"u",roles:["consumer"]})).rejects.toThrow(/WORKFLOW_FORBIDDEN/);
  });
});


describe("Protocol Suite 1.0.0 contracts", () => {
  it("requires the A2UI protocol version and only accepts declarative safe components", () => {
    const valid = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "employee.form", version: "1.0.0", kind: "a2ui", name: "Employee form", status: "draft", visibility: "system", permissions: [], dependencies: [], component: "EmployeeForm", propsSchema: { type: "object" }, events: [{ name: "submit", target: { kind: "a2api", id: "employee.create", version: "1.0.0" } }] };
    expect(validateAsset(valid).valid).toBe(true);
    expect(validateAsset({ ...valid, protocolVersion: undefined }).valid).toBe(false);
    expect(validateAsset({ ...valid, component: "ArbitraryHtml" }).valid).toBe(false);
  });

  it("requires exact versioned app dependencies and a routable entrypoint", () => {
    const valid = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "merchant.app", version: "1.0.0", kind: "app", name: "Merchant", status: "draft", visibility: "system", permissions: [], dependencies: [], entrypoints: [{ id: "home", label: "Home", roles: ["merchant_owner"], intent: "merchant.home" }], assets: [{ id: "employee.form", version: "1.0.0", kind: "a2ui" }] };
    expect(validateAsset(valid).valid).toBe(true);
    expect(validateAsset({ ...valid, protocolVersion: "2.0.0" }).valid).toBe(false);
    expect(validateAsset({ ...valid, assets: [{ id: "employee.form", version: "latest", kind: "a2ui" }] }).valid).toBe(false);
    expect(validateAsset({ ...valid, entrypoints: [{ id: "home", label: "Home", roles: [] }] }).valid).toBe(false);
  });
});


describe("Published dependency locking", () => {
  it("blocks publishing A2UI and App assets until exact event and app dependencies are published", () => {
    const r = new AssetRegistry();
    const ui = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "employee.form", version: "1.0.0", kind: "a2ui" as const, name: "Employee form", status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [], component: "EmployeeForm" as const, propsSchema: { type: "object" }, events: [{ name: "submit", target: { kind: "a2api" as const, id: "employee.create", version: "1.0.0" } }], testEvidence: { suite: "unit", passed: 1, failed: 0 } };
    r.register(ui);
    expect(() => r.publish(ui.id, ui.version)).toThrow(/Dependency is not published: employee.create@1.0.0/);
    r.register(capability); r.publish(capability.id, capability.version);
    r.publish(ui.id, ui.version);
    const app = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "merchant.app", version: "1.0.0", kind: "app" as const, name: "Merchant", status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [], entrypoints: [{ id: "home", label: "Home", roles: ["merchant_owner"], intent: "merchant.home" }], assets: [{ id: "employee.form", version: "1.0.0", kind: "a2ui" as const }, { id: "employee.create", version: "1.0.0", kind: "a2api" as const }], testEvidence: { suite: "unit", passed: 1, failed: 0 } };
    r.register(app);
    expect(() => r.publish(app.id, app.version)).not.toThrow();
  });

  it("blocks App publication when a dependency version is missing or mismatched", () => {
    const r = new AssetRegistry();
    const app = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "broken.app", version: "1.0.0", kind: "app" as const, name: "Broken", status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [], entrypoints: [{ id: "home", label: "Home", roles: ["owner"], intent: "home" }], assets: [{ id: "employee.create", version: "9.9.9", kind: "a2api" as const }], testEvidence: { suite: "unit", passed: 1, failed: 0 } };
    r.register(app);
    expect(() => r.publish(app.id, app.version)).toThrow(/Dependency is not published/);
  });
});


describe("AppBuilderPlanner", () => {
  it("reports explicit asset gaps and does not fabricate a manifest", () => {
    const planner = new AppBuilderPlanner(new AssetRegistry());
    const plan = planner.plan({
      appId: "food.merchant", appVersion: "1.0.0", name: "Food Merchant", visibility: "system", roles: ["merchant_owner"],
      requiredCapabilities: ["order.create"], requiredComponents: ["order.form"], workflowIntents: ["order.place"],
      entrypoints: [{ id: "orders", label: "Orders", roles: ["merchant_owner"], workflowIntent: "order.place" }]
    }, {});
    expect(plan.readyForManifest).toBe(false);
    expect(plan.manifestDraft).toBeUndefined();
    expect(plan.gaps.map(g => g.kind + ":" + g.id)).toEqual(["a2api:order.create", "a2ui:order.form", "a2wf:order.place"]);
  });

  it("reuses published assets and emits a manifest with exact immutable pins", () => {
    const registry = new AssetRegistry();
    registry.register(capability); registry.publish(capability.id, capability.version);
    const form = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "employee.form", version: "1.2.0", kind: "a2ui" as const, name: "Employee form", status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [], component: "EmployeeForm" as const, propsSchema: { type: "object" }, events: [], testEvidence: { suite: "unit", passed: 1, failed: 0 } };
    registry.register(form); registry.publish(form.id, form.version);
    const workflow = { schemaVersion: "1.0", protocolVersion: "1.0.0", id: "employee.onboard", version: "2.1.0", kind: "a2wf" as const, name: "Employee onboarding", status: "draft" as const, visibility: "system" as const, permissions: [], dependencies: [], trigger: { intents: ["employee.onboard"], roles: ["merchant_owner"] }, steps: [{ id: "form", type: "form" as const, component: "employee.form", componentVersion: "1.2.0" }, { id: "create", type: "action" as const, capability: "employee.create", capabilityVersion: "1.0.0" }, { id: "end", type: "end" as const }], testEvidence: { suite: "unit", passed: 1, failed: 0 } };
    registry.register(workflow); registry.publish(workflow.id, workflow.version);
    const planner = new AppBuilderPlanner(registry);
    const plan = planner.plan({
      appId: "employee.console", appVersion: "1.0.0", name: "Employee Console", visibility: "system", roles: ["merchant_owner"],
      requiredCapabilities: ["employee.create"], requiredComponents: ["employee.form"], workflowIntents: ["employee.onboard"],
      entrypoints: [{ id: "onboard", label: "Onboard employee", roles: ["merchant_owner"], workflowIntent: "employee.onboard" }]
    }, {});
    expect(plan.readyForManifest).toBe(true);
    expect(plan.gaps).toHaveLength(0);
    expect(plan.manifestDraft?.assets).toEqual([
      { kind: "a2api", id: "employee.create", version: "1.0.0" },
      { kind: "a2ui", id: "employee.form", version: "1.2.0" },
      { kind: "a2wf", id: "employee.onboard", version: "2.1.0" }
    ]);
    expect(plan.manifestDraft?.entrypoints[0].workflow).toBe("employee.onboard");
    expect(plan.matched.every(x => /^[a-f0-9]{64}$/.test(x.hash))).toBe(true);
  });

  it("rejects tenant scope mismatches and malformed business requirements", () => {
    const planner = new AppBuilderPlanner(new AssetRegistry());
    expect(() => planner.plan({ appId: "x", appVersion: "latest", name: "X", roles: [], entrypoints: [] }, {})).toThrow(/APP_REQUIREMENT_INVALID/);
    expect(() => planner.plan({ appId: "tenant.app", appVersion: "1.0.0", name: "Tenant", tenantId: "tenant-a", roles: ["owner"], entrypoints: [{ id: "home", label: "Home", roles: ["owner"], intent: "home" }] }, { tenantId: "tenant-b" })).toThrow(/TENANT_SCOPE_MISMATCH/);
  });
});
