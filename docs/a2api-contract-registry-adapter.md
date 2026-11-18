# A2API Capability Contract → Registry Asset Adapter (Draft)

Status: **Draft adapter**, not a protocol/schema migration.

This repository's frozen A2API 1.0.0 schema describes a publishable registry asset. The Sass A2API 1.0.0 capability contract describes portable execution semantics. They are different layers and must not be substituted for one another.

The adapter in `src/a2api-contract-adapter.ts` converts only the fields that can be represented safely and returns a separate provenance record for source semantics that remain host-bound. It does not modify `protocols/a2api/1.0.0/schema.json`, `docs/a2api.md`, or the frozen protocol manifest.

## Explicit mapping

| Sass capability contract | ai_business registry asset | Rule |
|---|---|---|
| `protocolVersion` | `protocolVersion` | Exact 1.0.0 |
| `id`, `version` | `id`, `version` | Exact identity and immutable asset version |
| `title` / mapping metadata name | `name` | Registry display name comes from explicit mapping metadata |
| `input.schema`, `output.schema` | `inputSchema`, `outputSchema` | Schema documents are copied without rewriting |
| `security.permissions` | `permissions` | Permission identifiers copied; no role inference |
| explicit host role mapping | `auth.roles` | Required metadata; roles are never inferred from permissions |
| `security.tenant.mode` | `auth.tenantRequired` | Only required/none; optional is rejected |
| `execution.timeoutMs` | `mapping.timeoutMs` | Direct numeric mapping |
| `execution.idempotency.mode` | `idempotency.required` | required → true; optional/unsupported → false |
| explicit key path mapping | `idempotency.keyFrom` | Must be the path supported by this runtime: `request.idempotencyKey` |
| `errors` | `errors` | Stable code/message/retryable values copied |
| host-selected adapter/operation | `mapping.adapter`, `mapping.operation` | Explicit server metadata; never inferred from a client handler string |
| host metadata | `visibility`, `tenantId`, `dependencies`, `preconditions`, `effects` | Explicit registry metadata, not invented from source contract |

## Fields that must not be silently collapsed

The returned `provenance` preserves the source provider binding, operation kind/HTTP declaration, execution effect/risk/retry/idempotency policy, audit requirement and source tenant scope, plus a SHA-256 digest of the canonical source contract.

Some semantics are not executable in the current ai_business runtime. The adapter therefore fails closed unless the following constraints hold:

- authentication is required and every declared source authentication scheme has an explicit host binding;
- tenant mode is `none` or `required`; `optional` is rejected;
- a declared tenant scope has an explicit host scope binding;
- risk is `low` and `destructive=false`; the target registry/runtime has no equivalent risk/approval gate;
- retry is exactly one attempt with no backoff and no retryable-error schedule;
- durable idempotency scope is `tenant` (principal/global source scopes are not mapped);
- idempotency key extraction uses the target runtime's `request.idempotencyKey` path;
- when source `audit.required=true`, the caller must explicitly attest that the host enforces that requirement; the target registry envelope has no per-capability audit-required field;
- tenant/private visibility includes a tenant ID.

These are deliberate limitations, not claims that the source semantics are fully supported. A future versioned registry profile may add first-class risk, audit, provider and idempotency-scope fields after protocol governance approval.

## Tests

`tests/a2api-contract-adapter.test.ts` covers the supported mapping and negative cases for risk, authentication scheme bindings, optional tenant mode, required audit, idempotency scope, retry semantics and tenant visibility.

The adapter tests do not yet prove end-to-end Invocation/Result wire compatibility. ai_business still uses its own `requestId/traceId/capabilityId/success/data/effects` runtime envelope. A separate versioned Invocation/Result serializer is required; field renaming inside a controller is not an acceptable substitute.

## Invocation / Result envelope adapter (Draft)

`src/a2api-wire-adapter.ts` adds a second, separate boundary adapter:

- Sass Invocation `invocationId` is retained separately; it is never renamed to `requestId`.
- Sass `context.requestId` maps to the runtime request ID.
- Sass `context.correlationId` maps to runtime trace ID. If absent, the host supplies a new trace ID; request ID is never substituted.
- Principal and tenant values in the incoming body are assertions only. They must match the authenticated host identity; runtime `appId` is injected from trusted host context.
- The current ai_business runtime cannot enforce a hard end-to-end deadline, so a wire invocation containing `context.deadline` is rejected rather than silently ignored.
- Runtime `success/data` maps to Sass `ok/output`; known error codes are normalized (for example FORBIDDEN → PERMISSION_DENIED and IDEMPOTENCY_CONFLICT → CONFLICT).
- Runtime `effects[]` are returned in a sidecar, not silently dropped or injected into the frozen Sass Result schema.
- If the source capability requires audit, the caller must provide persisted audit evidence. The adapter validates invocation ID, capability ID/version and principal binding before attaching it to the Sass Result.

This is a serialization boundary, not proof that the runtime itself enforces all Sass semantics. In particular, deadline enforcement and capability-level audit-required enforcement remain host responsibilities.
