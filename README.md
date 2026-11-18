# AI Business Runtime

An asset-driven runtime for building and operating AI-native business applications. A2UI components, A2API capabilities, A2WF workflows, and App Manifests are versioned assets: create once, validate, publish immutably, and reuse.

> A2API in this repository is a project-defined business capability contract. It is not presented as an official Google protocol.

## Protocol baseline

- Canonical suite: [A2 Protocol Suite](https://github.com/xinghunbuxiu/a2-protocol). Frozen 1.0.0 contracts are consumed from the canonical repository; Runtime releases pin exact protocol versions.

## Implemented kernel

- Typed contracts and Zod structural validation for A2UI, A2API, A2WF and App Manifest.
- Publication gate requiring passing test evidence; published versions cannot be overwritten.
- Safe A2UI component allowlist.
- Role- and tenant-aware intent resolution.
- Adapter-based A2API execution with JSON Schema input/output validation (Ajv).
- Initial A2WF runner with form pauses, human confirmation, conditional branches, output bindings, execution history and trace events.
- Standard result/error envelope, trace events, timeout handling and idempotency-key replay protection.
- Example employee creation capability, employee form, merchant onboarding workflow and app manifest.

## Cross-project integration

- [A2API Java adapter design](docs/a2api-java.md) defines Java/Spring provider and consumer mappings.
- [Cross-project Provider Registration 1.0.0](docs/provider-registration.md) defines project/service/provider identity, namespaced capability IDs, registration lifecycle and routing.
- TypeScript Runtime now has a fail-closed provider binding registry, HTTPS JSON transport, exact-version adapter factory and response correlation checks. See [provider transport contract](docs/provider-transport.md).
- Java SDK: [a2-sdk-java](https://github.com/xinghunbuxiu/a2-sdk-java). The Runtime repository does not own SDK source.
- The four core protocols remain frozen at 1.0.0.

## Architecture and persistence

See [architecture](docs/architecture.md), [A2 Protocol Suite](https://github.com/xinghunbuxiu/a2-protocol), [PostgreSQL persistence design](docs/persistence.md), and [roadmap](docs/roadmap.md). Runtime-local protocol schema copies are intentionally removed; conformance consumes the canonical protocol repository. The PostgreSQL schema is provided in `migrations/0001_asset_registry.sql`; the in-memory registry remains the current runtime adapter until the production database adapter and tenant RLS are implemented.

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Runtime usage

```ts
import { randomUUID } from "node:crypto";
import { AssetRegistry, ExecutionRuntime } from "./src/index.js";

const registry = new AssetRegistry();
// Register draft assets, attach passing testEvidence, then publish the exact version.
registry.register(capabilityDraft);
registry.publish("employee.create", "1.0.0");

const runtime = new ExecutionRuntime(registry);
runtime.registerAdapter("control-bridge", async (input, context) => {
  // Forward only allowlisted operations to your existing control plane.
  return controlBridge.invoke("employee.create", input, context);
});

const result = await runtime.executeInvocation({
  protocolVersion: "1.0.0",
  capabilityId: "employee.create",
  capabilityVersion: "1.0.0",
  requestId: crypto.randomUUID(),
  traceId: crypto.randomUUID(),
  appId: "merchant-console",
  idempotencyKey: "request-unique-key",
  input: { name: "Alex", phone: "..." }
}, verifiedIdentity);
```

The caller must construct `verifiedIdentity` from a trusted server-side session. Never trust client-supplied roles or tenant IDs.

## Trust and integration boundaries

- The model may propose assets and intent plans; the server validates and executes.
- Asset JSON never contains executable JavaScript or arbitrary URLs.
- Adapter names map to server-registered functions, not dynamic imports.
- Existing REST, MCP and Control Bridge services remain the business system of record.
- Chat history is not business state; orders, employees, payments and workflow state must be persisted independently.

## Current scope

This is the first runtime-kernel milestone, not yet a production-ready hosted platform. Persistence, authentication middleware, workflow compensation, distributed idempotency, audit storage, OpenTelemetry and the React/Tauri workbench are tracked in the roadmap.
