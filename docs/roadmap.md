# Roadmap

## Milestone 1 — Runtime kernel (this initial commit)
- [x] Typed A2UI/A2API/A2WF/App contracts
- [x] Asset validation and safe A2UI renderer allowlist
- [x] Immutable version registration and publication gate
- [x] Intent resolution with role and tenant visibility filtering
- [x] Adapter-based A2API execution, role/permission/tenant checks, named preconditions, idempotency, trace events and error envelopes
- [x] Employee capability example and runtime tests

## Protocol baseline — A2API/A2WF 1.0.0\n- [x] Freeze A2API and A2WF protocol identifiers and compatibility policy\n- [x] Require protocolVersion on A2API/A2WF assets\n- [x] Pin A2API/A2UI dependency versions in workflow nodes and resolve exact published versions\n- [x] Define invocation/result envelope and workflow execution lifecycle\n\n## Cross-project provider integration
- [x] Provider Registration 1.0.0 companion contract and JSON Schema
- [x] Provider identity, exact capability pins, contract-hash verification and lease-aware in-memory registry
- [ ] Durable provider registry, authenticated registration/heartbeat/revocation API and lease scheduler
- [ ] Provider transport SPI, policy router and audit trail
- [ ] Java Spring Boot provider starter and typed client
- [ ] TypeScript/Python SDKs and REST/MCP/Control Bridge adapters

## Milestone 2 — Production hardening
- [x] PostgreSQL asset-registry schema and persistence port (adapter implementation/RLS still pending)
- [ ] JSON Schema validation for API input/output and dependency resolution
- [ ] Signed release manifests, review approvals and compatibility checks
- [x] Initial A2WF runner: action steps, forms, approval pauses, conditions, transitions and execution trace (durable recovery and compensation pending)
- [ ] Durable idempotency store and distributed locking
- [ ] Audit/event persistence, OpenTelemetry export and trace query API
- [ ] REST API server, authentication middleware and OpenAPI document
- [ ] Adapter packages for REST, MCP and existing Control Bridge

## Milestone 3 — Builder and visual workbench
- [x] Structured App Requirement IR and deterministic App Builder planning
- [x] Published asset reuse by ID/intent with exact version and SHA-256 evidence
- [x] Missing-asset gap report and generation briefs; block manifest composition while gaps remain
- [x] Draft App Manifest composition from exact matched dependency pins
- [ ] Chat-driven App Builder, Component Builder and Workflow Builder
- [ ] Semantic asset search and LLM-assisted draft generation
- [ ] Validation dashboard and test evidence viewer
- [ ] App preview, role simulation, staged release and rollback
- [ ] React web UI and Tauri 2 desktop shell sharing the same renderer

## Non-goals for the first kernel
- No arbitrary JavaScript execution from JSON.
- No direct model-to-database access.
- No production execution of draft assets.
- No assumption that an adapter response alone proves business-state completion.
