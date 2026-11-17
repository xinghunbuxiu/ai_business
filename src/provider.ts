import { z } from "zod";
import type { AssetRegistry } from "./registry.js";

export const PROVIDER_REGISTRATION_PROTOCOL_VERSION = "1.0.0" as const;

export const ProviderRegistrationSchema = z.object({
  registrationProtocolVersion: z.literal(PROVIDER_REGISTRATION_PROTOCOL_VERSION),
  projectId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  serviceId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  providerId: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  environment: z.enum(["dev", "test", "staging", "prod"]),
  instanceId: z.string().min(1).max(128),
  capabilities: z.array(z.object({
    capabilityId: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
    capabilityVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()).min(1),
  transport: z.object({
    type: z.enum(["https-json", "grpc"]),
    bindingRef: z.string().min(1).max(256)
  }).strict(),
  lease: z.object({
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime()
  }).strict()
}).strict().superRefine((registration, ctx) => {
  if (Date.parse(registration.lease.expiresAt) <= Date.parse(registration.lease.issuedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lease", "expiresAt"], message: "Provider lease must expire after it is issued" });
  }
  const pins = new Set<string>();
  registration.capabilities.forEach((capability, index) => {
    const pin = capability.capabilityId + "@" + capability.capabilityVersion;
    if (pins.has(pin)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capabilities", index], message: "Duplicate capability pin" });
    pins.add(pin);
  });
});

export type ProviderRegistration = z.infer<typeof ProviderRegistrationSchema>;
export type ProviderRegistrationState = "active" | "draining" | "revoked";
export type RegisteredProvider = {
  registration: ProviderRegistration;
  state: ProviderRegistrationState;
};

export type ProviderBindingAuthorizer = (
  bindingRef: string,
  registration: ProviderRegistration
) => boolean;

const providerKey = (r: ProviderRegistration) =>
  [r.projectId, r.serviceId, r.providerId, r.environment, r.instanceId].join("/");

/**
 * In-memory domain registry for the provider-registration contract.
 * Authentication, durable storage, lease scheduling and transport invocation
 * belong to the production control plane and are intentionally not simulated here.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  constructor(
    private readonly assets: AssetRegistry,
    private readonly authorizeBinding: ProviderBindingAuthorizer = () => false
  ) {}

  register(input: unknown, authenticatedProjectId: string, now = new Date()): RegisteredProvider {
    const parsed = ProviderRegistrationSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("PROVIDER_REGISTRATION_INVALID: " + parsed.error.issues.map(issue => issue.message).join("; "));
    }
    const registration = parsed.data;
    if (registration.projectId !== authenticatedProjectId) {
      throw new Error("PROVIDER_PROJECT_FORBIDDEN: authenticated project does not own this registration");
    }
    if (!this.authorizeBinding(registration.transport.bindingRef, registration)) {
      throw new Error("PROVIDER_BINDING_FORBIDDEN: transport binding is not provisioned for this provider");
    }
    if (Date.parse(registration.lease.issuedAt) > now.getTime() || Date.parse(registration.lease.expiresAt) <= now.getTime()) {
      throw new Error("PROVIDER_LEASE_INVALID: registration lease is not currently valid");
    }
    for (const pin of registration.capabilities) {
      const asset = this.assets.get(pin.capabilityId, pin.capabilityVersion);
      if (!asset || asset.asset.kind !== "a2api") {
        throw new Error(`PROVIDER_CAPABILITY_NOT_PUBLISHED: ${pin.capabilityId}@${pin.capabilityVersion}`);
      }
      if (asset.hash !== pin.contractHash) {
        throw new Error(`PROVIDER_CONTRACT_HASH_MISMATCH: ${pin.capabilityId}@${pin.capabilityVersion}`);
      }
    }
    const key = providerKey(registration);
    if (this.providers.has(key)) throw new Error("PROVIDER_INSTANCE_EXISTS: " + key);
    const stored = { registration, state: "active" as const };
    this.providers.set(key, stored);
    return stored;
  }

  list(input: { capabilityId: string; capabilityVersion: string; environment: ProviderRegistration["environment"]; now?: Date }): RegisteredProvider[] {
    const now = (input.now ?? new Date()).getTime();
    return [...this.providers.values()].filter(provider =>
      provider.state === "active" &&
      provider.registration.environment === input.environment &&
      Date.parse(provider.registration.lease.expiresAt) > now &&
      provider.registration.capabilities.some(capability =>
        capability.capabilityId === input.capabilityId &&
        capability.capabilityVersion === input.capabilityVersion
      )
    );
  }

  setState(input: { projectId: string; serviceId: string; providerId: string; environment: ProviderRegistration["environment"]; instanceId: string }, state: Exclude<ProviderRegistrationState, "active">): void {
    const key = [input.projectId, input.serviceId, input.providerId, input.environment, input.instanceId].join("/");
    const current = this.providers.get(key);
    if (!current) throw new Error("PROVIDER_NOT_FOUND: " + key);
    this.providers.set(key, { ...current, state });
  }

  removeExpired(now = new Date()): number {
    let removed = 0;
    for (const [key, provider] of this.providers) {
      if (Date.parse(provider.registration.lease.expiresAt) <= now.getTime()) {
        this.providers.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
