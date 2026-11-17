import { describe, expect, it } from "vitest";
import { ProviderControlPlane } from "../src/provider-control-plane.js";
import type { ProviderRepository } from "../src/provider-repository.js";
import { AssetRegistry } from "../src/registry.js";
import type { RegisteredProvider } from "../src/provider.js";

const asset = {
  schemaVersion:"1.0",protocolVersion:"1.0.0",id:"orders.create",version:"1.0.0",kind:"a2api" as const,name:"Create order",
  status:"published" as const,visibility:"system" as const,permissions:[],dependencies:[],
  inputSchema:{type:"object"},outputSchema:{type:"object"},errors:[],auth:{roles:["merchant_owner"],tenantRequired:true},
  preconditions:[],effects:[],mapping:{adapter:"provider",operation:"create",timeoutMs:1000},
  idempotency:{required:true,keyFrom:"request.idempotencyKey"},testEvidence:{suite:"test",passed:1,failed:0}
};
const now = new Date("2026-11-17T00:00:00.000Z");
const registration = {
  registrationProtocolVersion:"1.0.0" as const,projectId:"commerce",serviceId:"orders",providerId:"orders-java",environment:"prod" as const,instanceId:"pod-1",
  capabilities:[{capabilityId:"orders.create",capabilityVersion:"1.0.0",contractHash:""}],
  transport:{type:"https-json" as const,bindingRef:"secret://commerce/orders"},
  lease:{issuedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60_000).toISOString()}
};
const actor = {projectId:"commerce",subject:"svc-orders",permissions:["provider:register","provider:heartbeat","provider:manage"]};
function setup() {
  const assets = new AssetRegistry(); assets.register(asset); const published = assets.publish(asset.id,asset.version);
  const input = {...registration,capabilities:[{...registration.capabilities[0],contractHash:published.hash}]};
  let stored: RegisteredProvider | undefined;
  const repo: ProviderRepository = {
    async insert(p){ if(stored) throw new Error("duplicate key"); stored=p; },
    async get(){ return stored; },
    async listActive(){ return stored ? [stored] : []; },
    async updateState(_key,state){ if(!stored)return false; stored={...stored,state}; return true; },
    async renewLease(_key,issuedAt,expiresAt){ if(!stored || stored.state!=="active") throw new Error("PROVIDER_LEASE_RENEWAL_REJECTED"); stored={...stored,registration:{...stored.registration,lease:{issuedAt:issuedAt.toISOString(),expiresAt:expiresAt.toISOString()}}}; return stored; },
    async deleteExpired(){ return 0; }
  };
  const service = new ProviderControlPlane(assets,repo,{authorizeBinding:ref=>ref==="secret://commerce/orders",clock:()=>now});
  return {service,input};
}
describe("ProviderControlPlane",()=>{
  it("registers a project-owned provider only with provisioned binding and published contract hash",async()=>{
    const {service,input}=setup();
    await expect(service.register(input,{...actor,projectId:"other"})).rejects.toThrow(/PROJECT_FORBIDDEN/);
    expect(await service.register(input,actor)).toMatchObject({state:"active",provider:"orders-java"});
  });
  it("requires explicit permissions for registration and management",async()=>{
    const {service,input}=setup();
    await expect(service.register(input,{...actor,permissions:[]})).rejects.toThrow(/FORBIDDEN/);
  });
  it("renews leases and supports drain/revoke state transitions",async()=>{
    const {service,input}=setup(); await service.register(input,actor);
    const key={projectId:"commerce",serviceId:"orders",providerId:"orders-java",environment:"prod" as const,instanceId:"pod-1"};
    expect(await service.heartbeat(key,actor)).toMatchObject({state:"active"});
    expect(await service.drain(key,actor)).toEqual({state:"draining"});
    await expect(service.heartbeat(key,actor)).rejects.toThrow(/NOT_ACTIVE/);
    expect(await service.revoke(key,actor)).toEqual({state:"revoked"});
  });
});
