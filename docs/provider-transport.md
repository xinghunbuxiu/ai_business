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
