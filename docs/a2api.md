# A2API Protocol 1.0.0 — Frozen Specification

**Status:** v1.0.0 baseline. **Protocol identifier:** `a2api`. **Media type:** `application/vnd.ai-business.a2api+json;version=1.0.0`.

This document is normative for all A2API producers, registries, runtimes, adapters and Builder tools in this repository. The protocol is a project-defined business-capability protocol; it is not represented as an external standards body's specification.

## 1. Version layers

- `protocolVersion`: wire and semantic contract version. A2API v1 messages MUST use `1.0.0`.
- `id`: stable capability identity, e.g. `employee.create`.
- `version`: immutable capability asset SemVer, e.g. `1.4.2`.
- `schemaVersion`: common asset-envelope serialization version. It is not the protocol version.
- Runtime package version: implementation release, independent of the protocol.

A breaking wire or semantic change increments protocol major. Backward-compatible optional additions increment minor. Compatible clarifications and implementation corrections increment patch. Published capability versions are immutable. A runtime MUST reject unsupported protocol major versions and MUST NOT silently reinterpret a different major.

## 2. Capability asset

Every A2API asset MUST include:

| Field | Requirement |
|---|---|
| `protocolVersion` | Required, exactly `1.0.0` for this release |
| `id`, `version` | Required stable ID and SemVer asset version |
| `inputSchema`, `outputSchema` | Required JSON Schema contracts |
| `auth.roles` | At least one permitted role |
| `auth.tenantRequired` | Whether a verified tenant context is mandatory |
| `permissions` | Required permission strings; all must be granted |
| `preconditions` | Named server-registered checks; missing checks fail closed |
| `effects` | Declared business effects/events |
| `mapping` | Server-allowlisted adapter and operation, plus timeout |
| `idempotency` | Required flag and key source |

Adapters are selected by trusted server registration. Asset data MUST NOT contain executable code, arbitrary URLs, shell commands, or client-selectable adapter implementations.

## 3. Invocation message

```json
{
  "protocolVersion": "1.0.0",
  "capabilityId": "employee.create",
  "capabilityVersion": "1.4.2",
  "requestId": "req_01J...",
  "traceId": "trace_01J...",
  "appId": "merchant-console",
  "idempotencyKey": "merchant-42:create-employee:request-99",
  "input": { "name": "Alex", "role": "cashier" }
}
```

The authenticated identity (user, tenant, roles, permissions) is supplied by the trusted server context, never trusted from the invocation JSON. The exact capability version is mandatory. A runtime MUST NOT resolve `latest` for a published workflow or a production invocation.

## 4. Execution order

1. Validate protocol version and invocation envelope.
2. Resolve exact `capabilityId@capabilityVersion` in published registry.
3. Verify user roles, permissions, tenant and asset visibility.
4. Enforce idempotency key and reject key reuse with a different request fingerprint.
5. Validate input JSON Schema.
6. Evaluate all named preconditions (unknown = fail closed).
7. Invoke the allowlisted adapter with trusted identity, app, trace, request, idempotency and cancellation context.
8. Validate output JSON Schema.
9. Return result envelope and emit trace/audit events.

## 5. Result envelope

Success:

```json
{ "protocolVersion":"1.0.0", "success":true, "requestId":"req_01J...", "traceId":"trace_01J...", "capability":"employee.create", "data":{"employeeId":"emp_42"}, "effects":["employee.created"] }
```

Failure:

```json
{ "protocolVersion":"1.0.0", "success":false, "requestId":"req_01J...", "traceId":"trace_01J...", "capability":"employee.create", "error":{"code":"FORBIDDEN","message":"Permission denied","retryable":false} }
```

Error codes are stable machine identifiers. Clients branch on `error.code`, not localized message text. Implementations may add error codes without changing the protocol; existing codes MUST NOT be repurposed.

## 6. Compatibility and security

- Unknown optional fields may be ignored; required fields and semantics cannot be weakened.
- A new required input field, changed meaning, changed auth requirement, or changed side-effect behavior requires a new capability asset version and compatibility review; breaking protocol semantics require a protocol major.
- A2API assets are immutable after publication.
- Payment, refund, deletion and other high-impact effects MUST declare explicit confirmation requirements in the calling A2WF and be audited.
- In-memory idempotency is development-only; production requires durable atomic claims and result storage.
