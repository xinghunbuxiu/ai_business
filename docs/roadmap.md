# Roadmap

## Milestone 1 — Runtime kernel (this initial commit)
- [x] Typed A2UI/A2API/A2WF/App contracts
- [x] Asset validation and safe A2UI renderer allowlist
- [x] Immutable version registration and publication gate
- [x] Intent resolution with role and tenant visibility filtering
- [x] Adapter-based execution, idempotency, trace events and error envelopes
- [x] Employee capability example and runtime tests

## Milestone 2 — Production hardening
- [ ] Persistent registry (PostgreSQL) and content-addressed asset storage
- [ ] JSON Schema validation for API input/output and dependency resolution
- [ ] Signed release manifests, review approvals and compatibility checks
- [ ] Full workflow runner with branching, compensation and human confirmation
- [ ] Durable idempotency store and distributed locking
- [ ] Audit/event persistence, OpenTelemetry export and trace query API
- [ ] REST API server, authentication middleware and OpenAPI document
- [ ] Adapter packages for REST, MCP and existing Control Bridge

## Milestone 3 — Builder and visual workbench
- [ ] Chat-driven App Builder, Component Builder and Workflow Builder
- [ ] Asset search/reuse and gap analysis before generating new assets
- [ ] Validation dashboard and test evidence viewer
- [ ] App preview, role simulation, staged release and rollback
- [ ] React web UI and Tauri 2 desktop shell sharing the same renderer

## Non-goals for the first kernel
- No arbitrary JavaScript execution from JSON.
- No direct model-to-database access.
- No production execution of draft assets.
- No assumption that an adapter response alone proves business-state completion.
