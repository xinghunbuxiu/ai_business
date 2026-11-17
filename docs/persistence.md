# PostgreSQL persistence

Migration: `migrations/0001_asset_registry.sql` (PostgreSQL 15+).

The schema separates logical assets from immutable version rows and stores dependency pins, test runs, approvals, release manifests, release pins and audit events. A database trigger rejects updates/deletes to published versions. Publication still must be performed by a trusted service in one transaction: verify passing evidence, approval policy, dependency versions and content hash, then change the version state and set `published_at`.

The TypeScript persistence port is `AssetRepository`. The existing `AssetRegistry` remains an in-memory test adapter for the runtime kernel; it is not durable storage and should not be used as the production registry.

Before exposing this schema to tenant traffic, enable PostgreSQL Row-Level Security for tenant-owned rows and use a restricted application role. System assets should be writable only by platform administration services. Never rely on a client-provided tenant ID for database authorization.
