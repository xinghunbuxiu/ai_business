# A2UI Protocol 1.0.0 — Frozen Specification

**Identifier:** `a2ui` · **Version:** `1.0.0` · **Status:** frozen.

A2UI defines declarative, renderer-safe UI assets. It does not transport executable UI code.

## Component asset

Every component asset MUST include `protocolVersion: "1.0.0"`, `id`, immutable SemVer `version`, `kind: "a2ui"`, `component`, `propsSchema`, and `events`. The component name MUST be one of the runtime safe-renderer allowlist: `Form`, `Table`, `Card`, `List`, `Chart`, `OrderSummary`, `EmployeeForm`.

`propsSchema` is a JSON Schema object validated before rendering. Layout is declarative data only; it MUST NOT contain HTML, CSS expressions, JavaScript, executable templates, script URLs or arbitrary remote resources.

## Events and binding

An event is declarative and names a stable event plus a typed target. A target MUST resolve to a published, exact-version A2API capability or A2WF workflow. A client event payload is untrusted input: the server revalidates schema, caller identity, tenant, role, permission, app scope, target publication and target version before dispatch.

A UI asset MUST NOT select an adapter, provide an arbitrary URL, embed credentials, or request execution of arbitrary code. A renderer MUST ignore or reject unknown component types and unknown event target kinds; it MUST NOT dynamically load code based on asset data.

## Runtime envelopes

A render request identifies `appId`, `componentId`, `componentVersion`, `requestId` and validated `props`. A UI event identifies `appId`, `componentId`, `componentVersion`, `eventName`, `requestId` and untrusted `payload`. Authenticated identity is supplied by the server session, never by the UI event.

## Versioning

Breaking renderer semantics or event envelope changes require a protocol major. Compatible optional fields may use minor; clarifications use patch. Published component versions are immutable. Apps and workflows MUST pin exact component versions.
