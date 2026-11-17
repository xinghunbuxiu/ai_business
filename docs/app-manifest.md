# App Manifest Protocol 1.0.0 — Frozen Specification

**Identifier:** `app-manifest` · **Version:** `1.0.0` · **Status:** frozen.

An App Manifest is the immutable assembly contract for one independently addressable business application. It composes published A2UI, A2API and A2WF assets; it is not a place to embed business implementation code.

## Required contract

An app asset MUST include `protocolVersion: "1.0.0"`, `id`, immutable SemVer `version`, `kind: "app"`, `entrypoints` and `assets`. Each dependency MUST declare `id`, exact `version` and `kind`; floating tags such as `latest`, ranges and wildcards are forbidden in a release manifest.

Entrypoints define a stable ID, user-facing label, allowed roles and a target intent, component or workflow. At least one target MUST be declared. The server derives the actual user role and tenant from its authenticated session and filters entrypoints accordingly; manifest role declarations are not authorization credentials.

## Release resolution

Before publication, the platform MUST verify that every dependency exists, is published, is visible to the app tenant, and matches its declared kind and exact version. The release MUST store a resolved dependency lock with content hashes. Missing, ambiguous, incompatible or unauthorized dependencies block publication. A published app version and its dependency lock are immutable.

## Runtime and security

The server resolves the app manifest and dependency lock. The client cannot override dependency versions, tenant scope, role grants, permissions or adapter mappings. Navigation and layout are declarative. Manifests MUST NOT contain executable JavaScript, arbitrary HTML, shell commands, credentials or arbitrary adapter URLs.

## Versioning

Breaking app entrypoint, dependency-resolution or runtime-envelope semantics require a protocol major. Compatible optional fields may use minor; clarifications use patch. App asset SemVer is independent of this protocol version and of the Runtime package version.
