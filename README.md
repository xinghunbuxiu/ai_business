# AI Business Runtime

An asset-driven runtime for building and operating AI-native business applications. A2UI components, A2API capabilities, A2WF workflows, and App Manifests are versioned assets: create once, validate, publish immutably, and reuse.

> A2API in this repository is a project-defined business capability contract. It is not presented as an official Google protocol.

## Protocol baseline

- Frozen suite: [A2API 1.0.0](docs/a2api.md), [A2WF 1.0.0](docs/a2wf.md), [A2UI 1.0.0](docs/a2ui.md), and [App Manifest 1.0.0](docs/app-manifest.md). See the [suite contract](docs/protocol-suite.md) and [protocol manifest](protocols/manifest.json). Protocol versions, asset versions and runtime releases are independent; every release pins exact dependency versions.
\n## Implemented kernel

- Typed contracts and Zod structural validation for A2UI, A2API, A2WF and App Manifest.
- Publication gate requiring passing test evidence; published versions cannot be overwritten.
- Safe A2UI component allowlist.
- Role- and tenant-aware intent resolution.
- Adapter-based A2API execution with JSON Schema input/output validation (Ajv).
- Initial A2WF runner with form pauses, human confirmation, conditional branches, output bindings, execution history and trace events.
- Standard result/error envelope, trace events, timeout handling and idempotency-key replay protection.
- Example employee creation capability, employee form, merchant onboarding workflow and app manifest.

## Architecture and persistence

See [architecture](docs/architecture.md), [A2API Protocol 1.0.0](docs/a2api.md) ([JSON Schema](protocols/a2api/1.0.0/schema.json)), [A2WF Protocol 1.0.0](docs/a2wf.md) ([JSON Schema](protocols/a2wf/1.0.0/schema.json)), [A2UI Protocol 1.0.0](docs/a2ui.md) ([JSON Schema](protocols/a2ui/1.0.0/schema.json)), [App Manifest Protocol 1.0.0](docs/app-manifest.md) ([JSON Schema](protocols/app-manifest/1.0.0/schema.json)), [protocol suite](docs/protocol-suite.md), [protocol manifest](protocols/manifest.json), [PostgreSQL persistence design](docs/persistence.md), and [roadmap](docs/roadmap.md). The PostgreSQL schema is provided in `migrations/0001_asset_registry.sql`; the in-memory registry remains the current runtime adapter until the production database adapter and tenant RLS are implemented.

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
