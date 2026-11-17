import { describe, expect, it } from "vitest";
import { createRepositoryProviderAdapter } from "../src/provider-repository-adapter.js";
import type { ProviderRepository } from "../src/provider-repository.js";
import type { RegisteredProvider } from "../src/provider.js";
import { HttpJsonProviderTransport } from "../src/provider-transport.js";

const provider: RegisteredProvider = {
  state:"active",
  registration:{
    registrationProtocolVersion:"1.0.0",projectId:"commerce",serviceId:"orders",providerId:"orders-java",environment:"prod",instanceId:"pod-1",
    capabilities:[{capabilityId:"orders.create",capabilityVersion:"1.0.0",contractHash:"a".repeat(64)}],
    transport:{type:"https-json",bindingRef:"secret://commerce/orders"},
    lease:{issuedAt:"2026-11-17T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"}
  }
};
describe("createRepositoryProviderAdapter",()=>{
  it("discovers providers from the durable repository and forwards correlation metadata",async()=>{
    let requestBody: Record<string,unknown> | undefined;
    const repository: ProviderRepository = {
      async insert(){}, async get(){return provider;}, async listActive(){return [provider];},
      async updateState(){return true;}, async renewLease(){return provider;}, async deleteExpired(){return 0;}
    };
    const transport = new HttpJsonProviderTransport({async resolve(){return {endpointUrl:"https://provider.example/a2api/invoke",headers:{}};}},async (_url,init)=>{
      requestBody=JSON.parse(String(init?.body));
      return new Response(JSON.stringify({protocolVersion:"1.0.0",requestId:"req-1",traceId:"trace-1",success:true,data:{ok:true}}),{status:200,headers:{"content-type":"application/json"}});
    });
    const adapter=createRepositoryProviderAdapter({capabilityId:"orders.create",capabilityVersion:"1.0.0",environment:"prod",repository,transport});
    await expect(adapter({orderId:"o1"},{identity:{userId:"u1",roles:["merchant_owner"]},appId:"merchant",requestId:"req-1",traceId:"trace-1"})).resolves.toEqual({ok:true});
    expect(requestBody).toMatchObject({capabilityId:"orders.create",capabilityVersion:"1.0.0",requestId:"req-1",traceId:"trace-1"});
  });
});
