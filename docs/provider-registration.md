# Cross-project Provider Registration 1.0.0

**Status:** proposed foundational contract, separate from frozen A2API 1.0.0.  
**Purpose:** register implementations from independent projects and route exact A2API capability versions to trusted providers.

## 1. Separation of concerns

- **A2API Capability Asset** describes what a business operation means: input/output schema, permissions, preconditions, effects, idempotency and stable errors.
- **Provider Registration** describes where and how one implementation is made available: owning project, service, provider instance, environment, supported capability pins and server-side transport binding.
- **Runtime Binding** is a private server-side record that connects a published capability pin to an authenticated provider. It is never supplied by the model or browser.

Do not put a provider URL, secret, Java class name or arbitrary method name in an A2API asset.

## 2. Namespacing and collision policy

A2API 1.0.0 uses `id@version` as its asset reference. Until a future protocol major introduces structured scope references, capability IDs MUST be globally namespaced:

`<projectNamespace>.<serviceNamespace>.<operation>`

Examples:

- `commerce.orders.create`
- `merchant.staff.create`
- `gameops.session.launch`

The short local method name may remain `create` in Java. The provider binding maps that method to the fully qualified A2API ID. The registry MUST reject duplicate fully qualified `id@version` assets. Never silently overwrite or resolve by “latest” in a pinned production workflow.

A single capability may have multiple provider implementations (for example, regional deployments or a migration). Those providers advertise the same exact capability ID and version, but have distinct provider IDs and deployment scopes. The runtime selects only among explicitly authorized, healthy bindings using server policy.

## 3. Provider identity

The stable provider identity is the tuple:

`projectId / serviceId / providerId / environment`

- `projectId`: owning product/repository/business project, not a tenant.
- `serviceId`: independently deployable service within the project.
- `providerId`: stable logical provider identity, not a process/pod ID.
- `environment`: isolated deployment lane such as dev, staging or prod.

A running process/pod reports a separate ephemeral `instanceId`. Tenant identity is never inferred from project/provider identity.

## 4. Registration record

A registration contains:

- registration protocol version;
- provider identity tuple and instance ID;
- supported capability ID, exact capability version and contract hash;
- transport type and a server-managed endpoint/credential reference;
- environment, health and lease metadata.

The endpoint and credential reference are provisioned by an administrator or deployment control plane. They are not accepted from model-generated assets. A provider cannot claim a capability version unless its contract hash matches the published capability asset.

## 5. Registration lifecycle

`provisioned -> authenticated -> contract-verified -> active -> draining -> revoked`

1. An administrator provisions provider identity and transport credentials.
2. Provider authenticates using mTLS or OAuth2 client credentials.
3. Provider submits its registration and exact capability pins.
4. Registry verifies ownership, publication state, contract hash and environment.
5. Provider receives a short-lived registration lease.
6. Heartbeats renew the lease; expired or revoked providers are removed from routing.
7. Deployment shutdown enters draining; in-flight requests complete or time out under policy.

Provider self-registration MUST NOT grant project ownership or permission to publish capabilities.

## 6. Invocation and routing

A2API 1.0.0 invocation/result envelopes remain unchanged. This avoids silently breaking the frozen protocol.

The Runtime resolves the invocation as follows:

1. Resolve exact globally namespaced `capabilityId@capabilityVersion`.
2. Verify caller identity, app scope, tenant, role and permission.
3. Resolve active provider bindings for that exact capability pin and environment.
4. Apply server-side provider selection policy (project ownership, region, health, rollout percentage and allowlist).
5. Invoke the selected provider using the trusted transport binding.
6. Validate response schema and correlate request/trace IDs.
7. Record provider ID, project ID, service ID, instance ID, contract hash and outcome in the audit trace.

The client does not choose `providerId`, endpoint, adapter URL or environment. If a specific provider must be pinned for compliance, the pin belongs in a signed deployment/release policy, not in model output.

## 7. Cross-project reuse

There are two supported cases:

**Reuse a capability contract:** another project may depend on a published capability asset only when visibility, ownership policy and permissions allow it. The dependency is pinned to its exact ID/version.

**Provide another implementation:** a different project may register as an implementation provider only after the capability owner authorizes that project/provider and its contract hash matches. Registration does not transfer ownership of the capability definition.

Tenant access remains independent from project ownership. A provider may serve multiple tenants only when its service is explicitly designed and authorized for tenant isolation.

## 8. Security invariants

- Project, provider and environment are authenticated claims/control-plane records, never trusted request-body fields.
- Tenant, user, roles and permissions come from the verified caller context.
- Provider credentials are stored in a secret manager or protected deployment configuration; never in the registry's public asset document.
- Only allowlisted transport types are supported.
- Registration and capability publication are separate permissions.
- Revocation blocks new calls; in-flight behavior follows explicit drain/cancel policy.
- Provider responses are untrusted until output schema and response identity/correlation checks pass.
- Cross-project calls are denied by default until an explicit dependency/authorization grant exists.

## 9. Required conformance tests

1. Two projects using the same local method name do not collide when fully namespaced.
2. Duplicate global capability ID/version is rejected.
3. A provider cannot advertise an unpublished capability or mismatched contract hash.
4. A provider from an unapproved project cannot bind to another project's capability.
5. Expired, revoked and unhealthy registrations are not routed new requests.
6. Browser/model input cannot select provider URL, environment or credentials.
7. Tenant and role claims in provider request bodies cannot elevate privileges.
8. Exact capability pins are honored; no production “latest” fallback.
9. Multiple authorized providers follow deterministic policy and produce auditable routing records.
10. Provider response schema mismatch fails closed.

## 10. Implementation sequence

1. Add namespaced capability ID validation and migration checks to the registry.
2. Define provider registration storage and lifecycle/lease service.
3. Add provider transport SPI and HTTP provider adapter.
4. Implement Java Spring Boot provider starter and typed Java client.
5. Add TypeScript provider SDK and REST/MCP/Control Bridge adapters.
6. Add gateway authentication, policy routing, audit persistence and conformance suite.

This specification defines the cross-project boundary. It does not claim the registration service, gateway router or SDKs have already shipped.
