# A2WF executable contract

A2WF describes a published business process as a directed graph of typed steps. The current runner supports five node types:

| Type | Purpose | Runtime behavior |
|---|---|---|
| `form` | Collect user/business data | Pauses with `awaiting_input`; UI renders the referenced A2UI component |
| `action` | Invoke a published A2API | Calls ExecutionRuntime using a deterministic execution/step idempotency key |
| `approval` | Require human approval | Pauses with `awaiting_confirmation` |
| `condition` | Branch on execution data | Evaluates a safe, declarative comparison; no user code is evaluated |
| `end` | End a path | Marks the execution completed |

## Example step

```json
{
  "id": "create-merchant",
  "type": "action",
  "capability": "merchant.create",
  "input": {
    "name": { "$ref": "outputs.merchant-form.name" },
    "region": { "$ref": "trigger.region" }
  },
  "requiresConfirmation": true,
  "next": "check-result"
}
```

Supported references are deliberately constrained to `trigger.*` and `outputs.*`. They are resolved as data paths; there is no eval, expression language, arbitrary JavaScript, or dynamic module loading.

A condition node declares `condition.path`, one of `eq`, `neq`, `exists`, `truthy`, and explicit `onTrue` / `onFalse` targets. `next` overrides the default next item in the steps array for linear nodes.

## Runtime boundary

The initial `WorkflowRunner` stores executions in process memory. It supports start, pause, resume, A2API dispatch, condition routing, execution history and trace events. It is suitable for kernel tests and UI integration, but not yet a durable production orchestrator. Restart recovery, distributed locking, retry/backoff, parallel fan-out, compensation/saga, deadlines, durable event storage and authorization of external resume callbacks remain subsequent work.

The caller must supply a trusted server-side identity. Resume endpoints must additionally authenticate the actor and verify that the actor is allowed to submit the requested form or approval response. Never accept a browser-supplied `confirmed: true` without server-side authorization and an auditable approval policy.
