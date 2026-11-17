# A2API HTTPS JSON Provider Transport 1.0.0

This transport is the first wire-level bridge between the TypeScript Runtime and independent providers such as Spring Boot services.

## Invocation

The Runtime sends an authenticated HTTPS POST to the server-managed endpoint binding. The JSON body is the existing A2API 1.0.0 invocation envelope:

```json
{
  "protocolVersion": "1.0.0",
  "capabilityId": "commerce.orders.create",
  "capabilityVersion": "1.0.0",
  "requestId": "req-uuid",
  "traceId": "trace-uuid",
  "appId": "merchant-console",
  "idempotencyKey": "tenant-42:create-order:request-99",
  "input": { "sku": "SKU-1", "quantity": 2 }
}
```

The Runtime MUST NOT put caller identity, tenant, roles or permissions into the untrusted JSON body as authoritative claims. The binding resolver supplies service authentication and, where required, a short-lived gateway-signed identity context in protected headers. The Java provider verifies that context and constructs its local `A2ApiContext`.

## Success response

```json
{
  "protocolVersion": "1.0.0",
  "requestId": "req-uuid",
  "traceId": "trace-uuid",
  "success": true,
  "data": { "orderId": "ORD-1001", "status": "created" }
}
```

## Failure response

```json
{
  "protocolVersion": "1.0.0",
  "requestId": "req-uuid",
  "traceId": "trace-uuid",
  "success": false,
  "error": {
    "code": "ORDER_OUT_OF_STOCK",
    "message": "Requested quantity is unavailable",
    "retryable": false
  }
}
```

## Security and delivery semantics

- Provider endpoint URLs are resolved from a server-controlled binding reference; provider registration cannot inject arbitrary destinations.
- HTTPS is mandatory by default. Plain HTTP is only permitted by explicit local-development configuration.
- Redirects are rejected to avoid credential forwarding to an unintended host.
- The response must be JSON and match the strict envelope; request and trace IDs must match.
- Response bodies are size-limited.
- The Runtime validates returned `data` against the published A2API output schema.
- A provider-declared error is preserved as a stable error code.
- No automatic provider failover is performed after a write attempt. A timeout can occur after the provider commits; retries must use the same durable idempotency key and an explicit retry policy.

## Current implementation boundary

The TypeScript SDK now contains a transport interface, HTTPS JSON transport, exact-version adapter factory and unit tests. This is not yet a production gateway: durable provider storage, secret-manager integration, authenticated provider registration, rate limiting, circuit breaking and Java Spring Boot starter remain separate milestones.

## Runtime HTTP entrypoint

The Node Runtime host exposes `POST /a2api/invoke` through `createA2ApiHttpServer(runtime, resolveIdentity, options)`. The host-provided identity resolver is the only source of caller identity; body fields such as `identity`, `tenantId` or `roles` are not used. The host must implement real authentication (for example, its existing OIDC/JWT or session middleware), authorize access to the route, and terminate TLS directly or at a trusted reverse proxy.

The server enforces JSON content type, a configurable request-body limit, exact protocol version and required invocation envelope fields. Valid invocations are passed to `ExecutionRuntime.executeInvocation`; the Runtime remains responsible for exact published capability version, tenant, role, permission, schema and idempotency checks. The default route is `/a2api/invoke` and the default request limit is 1 MiB.

This is a minimal Node HTTP host adapter, not a complete production API gateway. It does not provide a built-in OIDC provider, session store, rate limiter, durable idempotency store, audit database, reverse-proxy configuration or PostgreSQL persistence. Do not expose it publicly without wiring the host authentication resolver and network controls.

## Durable Provider control plane

The SDK now defines a driver-neutral `ProviderRepository` and a PostgreSQL implementation, `PostgresProviderRepository`. Apply `PROVIDER_POSTGRES_MIGRATION` through the host application's migration runner; this package intentionally does not open database connections or embed database credentials.

The repository persists the immutable registration envelope, provider state and lease expiry. Its primary key is the project/service/provider/environment/instance tuple. Active discovery filters by environment, exact capability ID/version, state and unexpired lease. Lease renewal is conditional on the instance still being active and unexpired.

`ProviderControlPlane` adds the policy boundary around the repository:
- Registration requires an authenticated provider principal with `provider:register`, scoped to its exact project, service and provider IDs.
- The project in the registration must equal the authenticated project.
- The server must provision and authorize the `bindingRef`; clients cannot supply an endpoint URL or credentials.
- Every capability must be a published A2API asset with a matching contract hash.
- Registration leases are bounded by server policy (30–3600 seconds; default 300 seconds).
- Heartbeat requires `provider:heartbeat`; drain/revoke require `provider:manage`.

The HTTP framework adapter and concrete authentication mechanism remain host responsibilities. Do not expose repository methods directly to providers. Use a transaction-capable database executor and run schema migrations before enabling the control plane. Production deployments should add rate limits, audit events, secret-manager rotation, database-backed revocation propagation and operational lease-expiry monitoring.

For Runtime routing, use `createRepositoryProviderAdapter` with the same durable repository. It performs asynchronous active-instance discovery by exact capability pin and environment, then invokes the selected provider through the HTTPS transport. The earlier `createProviderAdapter` remains available for the in-memory registry and local tests.
