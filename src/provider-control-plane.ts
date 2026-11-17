import type { AssetRegistry } from "./registry.js";
import { ProviderRegistrationSchema, type ProviderBindingAuthorizer, type ProviderRegistration as Registration } from "./provider.js";
import type { ProviderRepository, ProviderRecordKey } from "./provider-repository.js";

export type AuthenticatedProviderProject = { projectId: string; subject: string; permissions: string[] };
export type ProviderControlPlanePolicy = { authorizeBinding: ProviderBindingAuthorizer; leaseSeconds?: number; clock?: () => Date };

export class ProviderControlPlane {
  private readonly leaseSeconds: number;
  private readonly clock: () => Date;
  constructor(private readonly assets: AssetRegistry, private readonly repository: ProviderRepository, private readonly policy: ProviderControlPlanePolicy) {
    this.leaseSeconds = policy.leaseSeconds ?? 300;
    this.clock = policy.clock ?? (() => new Date());
    if (!Number.isInteger(this.leaseSeconds) || this.leaseSeconds < 30 || this.leaseSeconds > 3600) throw new Error("PROVIDER_POLICY_INVALID: leaseSeconds must be between 30 and 3600");
  }

  async register(input: unknown, actor: AuthenticatedProviderProject) {
    if (!actor.permissions.includes("provider:register")) throw new Error("PROVIDER_FORBIDDEN: provider:register permission required");
    const parsed = ProviderRegistrationSchema.safeParse(input);
    if (!parsed.success) throw new Error("PROVIDER_REGISTRATION_INVALID: " + parsed.error.issues.map(issue => issue.message).join("; "));
    const registration = parsed.data;
    if (registration.projectId !== actor.projectId) throw new Error("PROVIDER_PROJECT_FORBIDDEN: project identity mismatch");
    if (!this.policy.authorizeBinding(registration.transport.bindingRef, registration)) throw new Error("PROVIDER_BINDING_FORBIDDEN: binding reference is not provisioned for this provider");
    const now = this.clock();
    const issuedAt = Date.parse(registration.lease.issuedAt);
    const expiresAt = Date.parse(registration.lease.expiresAt);
    if (Math.abs(issuedAt - now.getTime()) > 30_000 || expiresAt <= now.getTime() || expiresAt - now.getTime() > this.leaseSeconds * 1000) {
      throw new Error("PROVIDER_LEASE_INVALID: registration lease is outside the allowed window");
    }
    for (const pin of registration.capabilities) {
      const asset = this.assets.get(pin.capabilityId, pin.capabilityVersion);
      if (!asset || asset.asset.kind !== "a2api" || asset.asset.status !== "published") throw new Error("PROVIDER_CAPABILITY_NOT_PUBLISHED: " + pin.capabilityId + "@" + pin.capabilityVersion);
      if (asset.hash !== pin.contractHash) throw new Error("PROVIDER_CONTRACT_HASH_MISMATCH: " + pin.capabilityId + "@" + pin.capabilityVersion);
    }
    await this.repository.insert({ registration, state: "active" });
    return { provider: registration.providerId, instance: registration.instanceId, state: "active" as const, leaseExpiresAt: registration.lease.expiresAt };
  }

  async heartbeat(input: ProviderRecordKey, actor: AuthenticatedProviderProject) {
    this.assertOwner(input, actor, "provider:heartbeat");
    const now = this.clock();
    const current = await this.repository.get(input);
    if (!current || current.state !== "active") throw new Error("PROVIDER_NOT_ACTIVE: provider cannot renew its lease");
    const updated = await this.repository.renewLease(input, now, new Date(now.getTime() + this.leaseSeconds * 1000));
    return { state: updated.state, leaseExpiresAt: updated.registration.lease.expiresAt };
  }

  async drain(input: ProviderRecordKey, actor: AuthenticatedProviderProject) {
    this.assertOwner(input, actor, "provider:manage");
    if (!await this.repository.updateState(input, "draining")) throw new Error("PROVIDER_NOT_FOUND: provider instance does not exist");
    return { state: "draining" as const };
  }

  async revoke(input: ProviderRecordKey, actor: AuthenticatedProviderProject) {
    this.assertOwner(input, actor, "provider:manage");
    if (!await this.repository.updateState(input, "revoked")) throw new Error("PROVIDER_NOT_FOUND: provider instance does not exist");
    return { state: "revoked" as const };
  }

  private assertOwner(input: ProviderRecordKey, actor: AuthenticatedProviderProject, permission: string) {
    if (input.projectId !== actor.projectId || !actor.permissions.includes(permission)) throw new Error("PROVIDER_FORBIDDEN: project ownership or permission check failed");
  }
}
