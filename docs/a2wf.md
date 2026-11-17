# A2WF Protocol 1.0.0 — Frozen Specification

**Status:** v1.0.0 baseline. **Protocol identifier:** `a2wf`. **Media type:** `application/vnd.ai-business.a2wf+json;version=1.0.0`.

This is the normative workflow-definition and execution protocol for the AI Business Runtime.

## 1. Version layers

- `protocolVersion`: workflow wire/semantic protocol, required `1.0.0` in this release.
- `id` + `version`: immutable workflow asset identity and SemVer version.
- `schemaVersion`: shared asset-envelope serialization version.
- Every node dependency pins its own asset version. Runtime package version is independent.

Breaking graph semantics or message shapes require protocol major. Optional compatible additions use minor. Compatible corrections use patch. A published workflow is immutable and MUST pin every referenced A2API and A2UI version.

## 2. Workflow definition

A workflow contains a stable ID/version, trigger intents, allowed roles, permissions, tenant visibility and an ordered node list. Node IDs MUST be unique. Every explicit transition target MUST refer to an existing node. Workflow start is the first node in the list.

### Supported v1 node types

| Type | Required fields | Semantics |
|---|---|---|
| `form` | `component`, `componentVersion` | Pause for user input rendered by that exact published A2UI version |
| `action` | `capability`, `capabilityVersion` | Invoke that exact published A2API version |
| `approval` | none beyond node ID | Pause for a server-authorized human decision |
| `condition` | `condition`, `onTrue`, `onFalse` | Deterministic branch using the restricted operators below |
| `end` | node ID | Complete the workflow path |

A node may define `next` to override the default next item in the ordered list. Conditional edges use `onTrue` and `onFalse`. No arbitrary JavaScript, eval, dynamic imports or user-defined executable expressions are permitted.

## 3. Data binding

The only v1 binding form is a single-key object:

```json
{ "$ref": "trigger.region" }
{ "$ref": "outputs.create-merchant.merchantId" }
```

Roots are limited to `trigger` and `outputs`. Paths are dot-separated object properties. Missing paths resolve to undefined and MUST be rejected by downstream input schema validation when required.

## 4. Condition operators

- `eq`: strict JSON-value equality.
- `neq`: strict JSON-value inequality.
- `exists`: value is not undefined.
- `truthy`: JSON truthiness.

Conditions are deterministic and side-effect free. More expressive boolean groups, numeric comparisons, loops and parallel fan-out are deferred to a future protocol version or compatible extension.

## 5. Execution lifecycle

The v1 lifecycle states are `running`, `awaiting_input`, `awaiting_confirmation`, `completed`, `failed`. An execution pins `workflowId@workflowVersion`, records `protocolVersion`, app ID, trusted identity, trigger input, current node, outputs and history.

The runner emits lifecycle and node events with execution ID, workflow ID, node ID, timestamp and trace detail. Resuming an execution MUST authenticate the actor and enforce node-specific authorization. A browser-supplied `confirmed: true` is not proof of approval.

## 6. Execution guarantees and v1 limitations

- A2API action idempotency key is derived from execution ID + node ID; the A2API capability version is passed explicitly.
- Published dependencies are resolved by exact ID/version; missing dependencies fail before execution.
- The default runner remains in-memory. An optional PostgreSQL execution repository now persists execution snapshots and uses optimistic revisions to reject stale snapshot updates. Configure `WorkflowRunnerOptions.repository` with `PostgresWorkflowExecutionRepository` to enable snapshot persistence; apply `WORKFLOW_POSTGRES_MIGRATION` first. The runner saves state at start, wait points, node transitions and terminal outcomes, and can reload a waiting execution for resume.

Snapshot persistence is not a distributed execution lock. Concurrent workers can still race before a node's side effect; the repository alone does not guarantee distributed single execution or exactly-once actions. Parallel joins, retry/backoff, timers, compensation/saga, cancellation, and durable workflow event/audit history remain unsupported. These guarantees must not be inferred from protocol v1.0.0.
- Production resume endpoints, approval records and execution persistence must be implemented before exposing workflows to untrusted clients.

## 7. Compatibility

A protocol major changes only for breaking graph/execution semantics. Adding an optional node field or optional node type with defined fallback can be a minor release, but a runtime that does not support that node type MUST reject the workflow rather than silently skip it. Published workflow asset versions are immutable.
