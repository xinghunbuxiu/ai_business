# A2API shared runtime conformance (Draft)

This repository vendors the language-neutral A2API 1.0.0 conformance corpus from the Sass protocol branch:

- `protocols/a2api/1.0.0/conformance/vectors.json`
- `protocols/a2api/1.0.0/test/fixtures/employee.create.valid.json`

The vendored corpus is a versioned snapshot, not a live dependency. Protocol corpus changes must be reviewed and copied deliberately.

## Corpus-driven runtime execution

`tests/a2api-runtime-vectors.test.ts` reads the shared corpus and dispatches six of the seven runtime-contract vectors through the actual ai_business `ExecutionRuntime`, the explicit Sass capability-contract → ai_business registry-asset adapter, and the Sass wire-result adapter:

| Shared vector | Execution | Expected/verified behavior |
|---|---|---|
| `SEC-TENANT-001` | Runtime security check | `TENANT_REQUIRED`; provider not dispatched |
| `SEC-PERMISSION-001` | Runtime permission check | wire error `PERMISSION_DENIED`; provider not dispatched |
| `AUDIT-REQUIRED-001` | Result adapter check after successful provider execution | `AUDIT_REQUIRED` when host requires persisted evidence but supplies none; provider dispatched once |
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

The six-vector runner and PostgreSQL stale-claim regression passed in CI run [44239770473](https://github.com/xinghunbuxiu/ai_business/actions/runs/44239770473) at test commit `3b21988eae043fe8534a5c748cf9d4fcf3ac3594`:

- TypeScript typecheck: passed
- Vitest: 15 files, 84 tests passed
- TypeScript build: passed
- Java SDK verification: passed

A follow-up migration-compatibility update at HEAD `c2aee83c0b1e74f120401cc04e185d6a2f2a0a9c` is awaiting its own CI result.

## Deliberate exclusions

The ai_business registry asset envelope is not byte-identical to the Sass capability-contract schema. Sass JSON-Schema vectors are not run against the ai_business registry envelope; canonical schemas are validated in the protocol repository, while ai_business validates its mapped registry asset and exercises semantics through explicit adapters.

The shared corpus retains adapter-neutral `pending-adapter` labels. Per-runtime outcomes are reported separately and do not mutate shared vector status.

`EXEC-TIMEOUT-001` remains pending in the shared runner. Existing unit tests verify timeout abort signaling, but that is not yet the corpus-driven end-to-end timeout vector with explicit deadline and late-side-effect assertions.

No end-to-end cross-repository conformance or exactly-once external-effect guarantee is claimed.
