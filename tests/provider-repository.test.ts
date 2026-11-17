import { describe, expect, it } from "vitest";
import { PostgresProviderRepository, PROVIDER_POSTGRES_MIGRATION, type PostgreSqlExecutor } from "../src/provider-repository.js";

class FakeDb implements PostgreSqlExecutor {
  calls: Array<{sql:string;parameters:readonly unknown[]}> = [];
  nextRows: Record<string, unknown>[] = [];
  count = 1;
  async query<T extends Record<string, unknown>>(sql:string, parameters:readonly unknown[] = []) {
    this.calls.push({sql,parameters});
    return { rows: this.nextRows as T[], rowCount: this.count };
  }
}

const registration = {
  registrationProtocolVersion:"1.0.0" as const, projectId:"commerce", serviceId:"orders", providerId:"orders-java",
  environment:"prod" as const, instanceId:"pod-1",
  capabilities:[{capabilityId:"orders.create",capabilityVersion:"1.0.0",contractHash:"a".repeat(64)}],
  transport:{type:"https-json" as const,bindingRef:"secret://commerce/orders"},
  lease:{issuedAt:"2026-11-17T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"}
};
const key = {projectId:"commerce",serviceId:"orders",providerId:"orders-java",environment:"prod" as const,instanceId:"pod-1"};

describe("PostgresProviderRepository", () => {
  it("inserts with a database-enforced unique identity", async () => {
    const db = new FakeDb(); const repo = new PostgresProviderRepository(db);
    await repo.insert({registration,state:"active"});
    expect(db.calls[0].sql).toContain("INSERT INTO a2api_providers");
    expect(db.calls[0].parameters[5]).toContain("secret://commerce/orders");
    expect(PROVIDER_POSTGRES_MIGRATION).toContain("PRIMARY KEY");
  });
  it("queries only active, unexpired providers with the exact capability pin", async () => {
    const db = new FakeDb(); const repo = new PostgresProviderRepository(db);
    db.nextRows = [{registration,state:"active"}];
    const result = await repo.listActive({capabilityId:"orders.create",capabilityVersion:"1.0.0",environment:"prod"});
    expect(result).toHaveLength(1);
    expect(db.calls[0].sql).toContain("lease_expires_at >");
    expect(db.calls[0].parameters[2]).toContain('"capabilityVersion":"1.0.0"');
  });
  it("renews only active, unexpired leases and rejects invalid windows", async () => {
    const db = new FakeDb(); const repo = new PostgresProviderRepository(db);
    await expect(repo.renewLease(key,new Date("2099-01-01T00:00:00Z"),new Date("2099-01-01T00:05:00Z"))).rejects.toThrow(/PROVIDER_LEASE_RENEWAL_REJECTED/);
    await expect(repo.renewLease(key,new Date("2099-01-01T00:00:00Z"),new Date("2098-12-31T00:00:00Z"))).rejects.toThrow(/PROVIDER_LEASE_INVALID/);
  });
  it("supports state transitions and expiry cleanup", async () => {
    const db = new FakeDb(); const repo = new PostgresProviderRepository(db);
    expect(await repo.updateState(key,"draining")).toBe(true);
    expect(await repo.deleteExpired()).toBe(1);
  });
});
