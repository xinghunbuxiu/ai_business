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

The runner emits lifecycle and node events with execution ID, workflow ID, node ID, timestamp and trace detail. Resuming an execution MUST authenticate the actor and enforce node-specific authorization. A browser-supplied `confirmed: true` is not proof of approval. When a PostgreSQL repository is configured, `WorkflowRunnerOptions.authorizeResume` is mandatory and `resume(executionId, response, caller)` requires a caller identity supplied by the trusted host. The runner checks tenant equality, invokes the host authorization callback for the exact execution/node, claims the execution, reloads its latest snapshot, and only then applies the response. The callback MUST validate the caller's current permissions and role policy; never build `caller` from browser-submitted identity fields.

## 6. Execution guarantees and v1 limitations

- A2API action idempotency key is derived from execution ID + node ID; the A2API capability version is passed explicitly.
- Published dependencies are resolved by exact ID/version; missing dependencies fail before execution.
- The default runner remains in-memory. An optional PostgreSQL execution repository now persists execution snapshots and uses optimistic revisions to reject stale snapshot updates. Configure `WorkflowRunnerOptions.repository` with `PostgresWorkflowExecutionRepository` to enable snapshot persistence; apply `WORKFLOW_POSTGRES_MIGRATION` first. The runner saves state at start, wait points, node transitions and terminal outcomes, and can reload a waiting execution for resume.

Approval decisions are appended to execution history with `approved` or `rejected`, authenticated `actorId`, and `occurredAt`. This is execution-snapshot provenance, not a separately tamper-evident approval ledger; high-assurance deployments should additionally write approval events to the host's append-only audit store.

The PostgreSQL repository supports atomic worker claims, owner-checked lease renewal/release, and owner-checked snapshot writes. Every successful claim increments a monotonic `lease_epoch` and returns it to the runner. Renewal, release and snapshot writes MUST match both worker ID and the exact epoch; a stale worker from an earlier lease cannot renew or overwrite the workflow snapshot after takeover. Configure a stable unique `workerId` per runner process and a `leaseSeconds` value (5–3600; default 60). The migration adds lease columns and `lease_epoch` to existing installations with `ADD COLUMN IF NOT EXISTS`.

This is at-least-once recovery, not exactly-once side effects. Fencing protects repository state, not an already-running external HTTP request: if a worker loses its lease while a provider call is in flight, that provider may still perform the side effect. The runner derives a stable A2API idempotency key from execution ID + node ID; providers MUST honor that key transactionally. High-risk providers should additionally accept and persist the workflow lease epoch, rejecting epochs older than the highest accepted epoch for the execution. A running external action cannot be forcibly cancelled merely because its lease was lost. Worker fencing does not replace authorization, durable A2API idempotency, or provider-side transaction guarantees.

Parallel joins, configurable retry/backoff, timers, compensation/saga, cancellation, and durable workflow event/audit history remain unsupported. These guarantees must not be inferred from protocol v1.0.0.
- Production resume endpoints, approval records and execution persistence must be implemented before exposing workflows to untrusted clients.

## 7. Compatibility

A protocol major changes only for breaking graph/execution semantics. Adding an optional node field or optional node type with defined fallback can be a minor release, but a runtime that does not support that node type MUST reject the workflow rather than silently skip it. Published workflow asset versions are immutable.

## Durable node attempt ledger

`PostgresWorkflowNodeExecutionStore` records each action-node attempt independently from the workflow snapshot. Configure it through `WorkflowRunnerOptions.nodeExecutionStore` and apply `WORKFLOW_NODE_ATTEMPTS_POSTGRES_MIGRATION` after the base `WORKFLOW_POSTGRES_MIGRATION`.

Each attempt has its own UUID, workflow/execution/node identity, monotonic per-node attempt number, lifecycle status (`running`, `succeeded`, `failed`, `unknown`), input/output SHA-256 digests, bounded error code, lease epoch, and timestamps. Raw inputs, outputs, credentials and payment data are not copied into this ledger. In durable mode the runner supplies its claimed lease epoch when creating an attempt; the insert checks that the epoch is still current, and finalization checks it again. A stale worker therefore cannot finalize a node attempt after another worker has taken over. The runner writes `running` before invoking A2API and finalizes the attempt after the call. A thrown transport/runtime exception is marked `unknown`, because the external side effect may have completed even when its response was lost.

The attempt ledger is evidence and observability, not a retry scheduler. An `unknown` attempt MUST NOT be retried automatically unless the provider's durable idempotency contract can safely replay the same operation. Workflow action idempotency keys remain stable per execution and node. The per-node attempt number currently assumes a single active workflow lease; the unique constraint rejects duplicate sequence allocation if a host violates that ownership model. Deployments should run the migration and ledger store together with the workflow repository.

### Worker fencing requirements

A runner MUST retain the epoch returned by its successful claim and MUST supply that epoch for every heartbeat, release, and durable snapshot write. A missing epoch is a fail-closed error. The epoch is monotonic for each execution and is never reset when a lease is released or expires. The current protocol implementation fences workflow repository writes and node-attempt ledger writes; it does not yet propagate the epoch to A2API providers. Until provider-side epoch enforcement is implemented, external side effects remain protected by the stable durable idempotency key and provider transaction semantics, not by the workflow lease alone.
