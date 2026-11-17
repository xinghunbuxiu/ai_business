# A2API business capability contract

A2API is the project's versioned contract for a callable business capability. It is not merely an HTTP endpoint description: it binds the business operation to its input/output contract, authorization policy, preconditions, side effects, idempotency behavior, timeout and server-owned execution adapter.

## Contract shape

A published A2API includes:

- Identity: `id`, immutable `version`, `kind: a2api`, description and visibility.
- Input/output: JSON Schema used by the runtime to validate both sides of the adapter boundary.
- Authorization: allowed roles, tenant requirement and explicit permission strings.
- Preconditions: named server-registered checks evaluated before any side effect.
- Effects: declared business events that describe what successful execution may change.
- Mapping: an adapter name and operation. Adapter names resolve only to functions registered by trusted server code.
- Reliability: timeout and idempotency requirement.

## Runtime order

1. Resolve the exact published capability.
2. Check role, required permissions, tenant identity and tenant visibility.
3. Require an idempotency key when the contract says so.
4. Validate input against the published JSON Schema.
5. Evaluate each named precondition. An unknown precondition fails closed.
6. Resolve the registered adapter and execute with a trace/request context and AbortSignal.
7. Enforce the output JSON Schema and return the standard result envelope.

No model-generated code, dynamic import, arbitrary URL or client-supplied adapter is executed.

## Example

```json
{
  "kind": "a2api",
  "id": "employee.create",
  "version": "1.0.0",
  "permissions": ["employee:create"],
  "auth": { "roles": ["merchant_owner"], "tenantRequired": true },
  "preconditions": ["employee.quota.available"],
  "effects": ["employee.created"],
  "mapping": { "adapter": "control-bridge", "operation": "employee.create", "timeoutMs": 10000 },
  "idempotency": { "required": true, "keyFrom": "request.idempotencyKey" }
}
```

Precondition handlers and adapters are registered by the trusted host application. The runtime deliberately fails closed when a declared precondition has no handler.

## Production boundary

The current runtime keeps idempotency results and adapters in process memory. Production deployment must move idempotency claims/results to a durable shared store with atomic uniqueness, add request-payload fingerprinting for key-reuse conflicts, and ensure adapters honor cancellation where possible. Business side effects must still be protected by downstream idempotency because an AbortSignal cannot undo a remote operation that already committed.
