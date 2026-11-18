# A2API shared runtime conformance (Draft)

This repository vendors the language-neutral A2API 1.0.0 conformance corpus from the Sass protocol branch:

- `protocols/a2api/1.0.0/conformance/vectors.json`
- `protocols/a2api/1.0.0/test/fixtures/employee.create.valid.json`

The vendored corpus is a versioned snapshot, not a live dependency. Protocol corpus changes must be reviewed and copied deliberately.

## Corpus-driven runtime execution

`tests/a2api-runtime-vectors.test.ts` reads the shared corpus and dispatches all seven runtime-contract vectors through the actual ai_business `ExecutionRuntime`, the explicit Sass capability-contract → ai_business registry-asset adapter, and the Sass wire-result adapter:

| Shared vector | Execution | Expected/verified behavior |
|---|---|---|
| `SEC-TENANT-001` | Runtime security check | `TENANT_REQUIRED`; provider not dispatched |
| `SEC-PERMISSION-001` | Runtime permission check | wire error `PERMISSION_DENIED`; provider not dispatched |
| `AUDIT-REQUIRED-001` | Result adapter check after successful provider execution | `AUDIT_REQUIRED` when host requires persisted evidence but supplies none; provider dispatched once |
| `EXEC-TIMEOUT-001` | Provider waits until the capability timeout abort signal | wire error `TIMEOUT`; provider dispatched once, abort observed, and late adapter completion is discarded |
| `EXEC-IDEMPOTENCY-001` | Two Runtime instances sharing an idempotency store | completed result replayed; total provider dispatch count remains one |
| `EXEC-IDEMPOTENCY-002` | Same scoped key with changed canonical input | wire error `CONFLICT`; total provider dispatch count remains one |
| `EXEC-IDEMPOTENCY-003` | Provider timeout after dispatch, followed by a retry | retry returns `OUTCOME_UNKNOWN`; no second provider dispatch |

The runner asserts the exact vector IDs in corpus order. A newly added security, audit, or idempotency vector fails until explicitly implemented. The idempotency runner uses a deterministic store test double to verify Runtime integration; separate tests exercise the PostgreSQL store's reservation, replay, conflict and stale-claim transitions.

## Durable idempotency safety

The PostgreSQL store now distinguishes `in_progress`, `completed`, and `unknown`:

- An expired `in_progress` claim transitions to `unknown`; it is never deleted and reacquired automatically.
- An `unknown` tombstone remains non-replayable.
- Cleanup removes only expired `completed` result payloads/records; it must not delete an ambiguous in-progress claim.
- Runtime marks timeout and ambiguous adapter failures as `unknown`, rather than releasing the reservation and allowing duplicate dispatch.
- Existing PostgreSQL state constraints are updated to admit the `unknown` state.

This is still not an exactly-once external-effect guarantee. A host must apply the PostgreSQL migration before enabling durable storage, and downstream providers should independently honor idempotency where possible.

## Verification

The six-vector idempotency/audit/security runner and PostgreSQL stale-claim regression passed in CI run [44239770473](https://github.com/xinghunbuxiu/ai_business/actions/runs/44239770473) at test commit `3b21988eae043fe8534a5c748cf9d4fcf3ac3594`:

- TypeScript typecheck: passed
- Vitest: 15 files, 84 tests passed
- TypeScript build: passed
- Java SDK verification: passed

Follow-up migration-compatibility update at commit `c2aee83c0b1e74f120401cc04e185d6a2f2a0a9c` also passed CI run [44239960248](https://github.com/xinghunbuxiu/ai_business/actions/runs/44239960248): typecheck, all 84 Vitest tests, build, and Java SDK verification. The final `EXEC-TIMEOUT-001` corpus-driven test then passed in CI run [44240482599](https://github.com/xinghunbuxiu/ai_business/actions/runs/44240482599) at commit `6d73db10ab82fe8f9651176a0a7982bdea67cdca` (15 files / 84 tests, typecheck, build, Java SDK).

## Deliberate exclusions

The ai_business registry asset envelope is not byte-identical to the Sass capability-contract schema. Sass JSON-Schema vectors are not run against the ai_business registry envelope; canonical schemas are validated in the protocol repository, while ai_business validates its mapped registry asset and exercises semantics through explicit adapters.

The shared corpus retains adapter-neutral `pending-adapter` labels. Per-runtime outcomes are reported separately and do not mutate shared vector status.

The corpus-driven timeout test uses a deterministic provider adapter that remains pending until the capability timeout aborts its signal, then completes late; the Runtime returns `TIMEOUT` and discards that late completion. This verifies the Runtime's timeout/abort boundary, not remote provider cancellation or rollback of a side effect already committed by an external system.

No end-to-end cross-repository conformance or exactly-once external-effect guarantee is claimed.
