# AI Business Runtime

An asset-driven runtime for building and operating AI-native business applications. It treats A2UI components, A2API capabilities, A2WF workflows, and App Manifests as versioned assets that are validated before publication and deterministically resolved at runtime.

## Status

Initial implementation scaffold is being built. See `docs/architecture.md` and `docs/roadmap.md`.

## Core principles

- Build assets once, validate them, publish immutable versions, and reuse them across apps.
- AI interprets intent and proposes plans; deterministic runtime validates permissions and executes registered adapters.
- A2UI is declarative and restricted to registered components. No arbitrary client JavaScript.
- A2API maps business capabilities to registered adapters (existing REST, MCP, or Control Bridge).
- Every execution is traceable, tenant-scoped, permission-checked, and idempotent where needed.
- Draft and test assets are never executable in production.

## Planned first milestone

- TypeScript contracts and asset validation
- In-memory registry with immutable published versions
- Intent resolver with role/tenant filtering
- Execution engine with adapter mapping, idempotency, trace and audit events
- Example employee-management assets and tests

## Development

```bash
npm install
npm test
npm run typecheck
```
