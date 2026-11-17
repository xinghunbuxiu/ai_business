# AI Business Protocol Suite 1.0.0

This release freezes four complementary contracts. Their protocol versions are independent of asset SemVer and Runtime package releases.

| Protocol | Responsibility | Frozen version |
|---|---|---|
| A2API | Business capability invocation, auth, effects, errors and adapter boundary | 1.0.0 |
| A2WF | Deterministic business workflow graph and execution contract | 1.0.0 |
| A2UI | Declarative safe UI components, props and event dispatch | 1.0.0 |
| App Manifest | Application entrypoints, role profiles and exact dependency composition | 1.0.0 |

## Cross-protocol dependency rules

- A2WF action nodes pin an exact A2API asset version.
- A2WF form nodes pin an exact A2UI component version.
- A2UI event targets pin an exact A2API or A2WF asset version.
- App Manifest pins every A2UI, A2API and A2WF asset by exact ID, kind and version.
- A release resolver verifies publication state, kind, visibility, tenant scope and content hash before release.
- Published assets and app dependency locks are immutable. Updating a dependency creates a new asset/app version; it never mutates a published release.

## Trust boundaries

The model may propose intent, component composition and workflow definitions. The server validates schemas and dependencies. The authenticated server session supplies identity and tenant context. Only trusted server-registered adapters execute business effects. UI payloads and browser confirmation flags are untrusted.

## Version policy

Protocol SemVer describes wire/semantic compatibility. Asset SemVer describes one immutable business asset. Runtime SemVer describes implementation deployment. A protocol major may coexist with older asset versions only when the runtime explicitly supports both; it must reject unsupported protocol versions rather than guess.

## Explicit implementation boundary

A frozen protocol is a normative contract, not proof that every runtime feature is already implemented. In particular, A2WF durable recovery, distributed execution guarantees, retry scheduling and compensation remain outside the current in-memory runner implementation. Schema validation and release-time dependency locking must be completed before claiming production-grade App publishing.
