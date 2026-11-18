# A2API shared runtime conformance (Draft)

This repository vendors the language-neutral A2API 1.0.0 conformance corpus from the Sass protocol branch at:

- `protocols/a2api/1.0.0/conformance/vectors.json`
- `protocols/a2api/1.0.0/test/fixtures/employee.create.valid.json`

The vendored corpus is a versioned snapshot, not a live dependency. A protocol corpus update must be reviewed and copied deliberately. The fixture path is preserved so the corpus remains portable.

## Runtime vector execution

`tests/a2api-runtime-vectors.test.ts` reads the shared corpus and executes the security runtime scenarios through the actual ai_business `ExecutionRuntime`, with the explicit Sass capability-contract → ai_business registry-asset adapter and the Sass wire-result adapter in the path.

The first runtime slice covers:

- `SEC-TENANT-001`: missing trusted tenant context; expected `TENANT_REQUIRED`; provider dispatch count must remain zero.
- `SEC-PERMISSION-001`: required capability permission absent; the ai_business runtime's `FORBIDDEN` result is normalized by the Sass wire adapter to `PERMISSION_DENIED`; provider dispatch count must remain zero.

The test asserts that every security vector in the shared corpus is explicitly dispatched. A newly added security vector therefore fails the harness until an implementation is added.

## Deliberate exclusions

The ai_business registry asset envelope is not byte-identical to the Sass capability-contract schema. The shared JSON Schema vectors are therefore not run against the ai_business registry schema. They are executed against the canonical Sass schemas in the protocol repository and against the Framework's byte-identical wire schemas. ai_business validates its mapped registry asset using its own registry schema and exercises wire semantics through the explicit adapters.

The corpus retains its adapter-neutral `pending-adapter` labels. Per-runtime test outcomes are reported by the adapter's CI; a runtime-specific pass must not mutate a shared scenario into a universal pass.

This first slice does not yet execute conditional audit enforcement, hard timeout/cancellation, durable idempotency replay, idempotency conflict, or stale/ambiguous outcome recovery. The current runtime's in-memory idempotency map is not durable storage and must not be treated as equivalent to the Framework's durable idempotency store. No exactly-once external-effect guarantee is claimed.
