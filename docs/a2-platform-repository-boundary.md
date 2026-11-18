# A2 Platform Repository Boundary

## Decision

`ai_business` is an implementation/runtime/business-asset repository. It is **not** the canonical home of A2API, A2FW, or A2UI protocol specifications, and it is not the canonical distribution home for cross-project SDKs.

The existing `protocols/` and `sdks/` directories are therefore treated as **legacy in-repository copies** during migration. New protocol definitions or SDK features MUST NOT be added here.

## Final responsibility
- Runtime: generic A2 execution/runtime capabilities reusable by applications.
- Registry: capability/provider/asset registration and resolution.
- Builder: App/Business asset generation and compilation.
- Business assets: App Manifest, examples, application-specific assets.
- Runtime conformance: adapters/tests proving compatibility with canonical protocols.
- Integration adapters: transports and persistence adapters needed by this runtime.

## Must not own
- Canonical A2API/A2FW/A2UI schema/specification.
- Studio/editor/review UI.
- Canonical Component Catalog.
- Cross-language SDK source as canonical distribution.

## Migration rule

The current `protocols/` and `sdks/` trees are not deleted blindly. Their contents must first be mapped to canonical owners, copied with provenance, and then removed in a dedicated migration commit. Runtime imports must consume released protocol/SDK artifacts or pinned conformance fixtures, not repository-local protocol copies.

## Dependency direction

```
A2 Protocols
     ↓
SDKs / generated bindings
     ↓
Runtime implementations
     ↓
Business applications / Builder
```

The reverse dependency is forbidden: protocol packages must never depend on `ai_business`.
