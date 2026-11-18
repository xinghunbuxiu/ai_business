# A2 Protocol and SDK Migration Manifest

## Canonical ownership decision

This repository is not the canonical owner of A2API, A2FW, A2UI, App Manifest, Provider Registration, or cross-language SDKs.

Target canonical repositories:
- xinghunbuxiu/a2-protocol (repository to be created before destructive migration).
- xinghunbuxiu/a2-sdk-java or a dedicated multi-language a2-sdk repository, depending on SDK packaging decision.

Until those repositories exist and are CI-published, the files under protocols/ and sdks/ remain compatibility copies. They must not be edited as a second source of truth.

## Current protocol inventory

| Current path | Current Git blob | Target |
|---|---|---|
| protocols/a2api/1.0.0/schema.json | 7d690b8b6db949712bd30b332dd237cd1d13a340 | a2-protocol/a2api/1.0.0 |
| protocols/a2ui/1.0.0/schema.json | 94c62fb712ccca31ce1eba657b1df6b165f960f8 | a2-protocol/a2ui/1.0.0 |
| protocols/a2wf/1.0.0/schema.json | 192c25f32a2b8548c23a7385103e419dc0dc10b9 | a2-protocol/a2wf/1.0.0 |
| protocols/app-manifest/1.0.0/schema.json | 9a0f5527d4f69a73fdeaf67a02a628f5c51c431c | a2-protocol/app-manifest/1.0.0 |
| protocols/provider-registration/1.0.0/schema.json | bf085694bc25001e400e89e003154b456778b876 | a2-protocol/provider-registration/1.0.0 |
| protocols/manifest.json | e6e5fc0eaf590d632692988f4c47a395ab8cede2 | a2-protocol/manifest.json |

## SDK inventory

sdks/java/a2api-java-core and sdks/java/a2api-java-spring-boot-starter are SDK artifacts, not ai_business runtime source.

They must be published independently and consumed by Framework/Runtime through versioned coordinates.

## Deletion gate

Do not delete protocols/ or sdks/ until all gates pass:
1. Canonical repository exists.
2. Canonical repository contains identical source blobs with provenance.
3. SDK coordinates/repository are published.
4. ai_business imports no repository-local protocol/SDK source.
5. Node and Java conformance CI consume canonical artifacts/fixtures.
6. Three-repository CI is green.
7. Migration PR documents the old-to-new path mapping.

This manifest is the migration gate and is intentionally committed before any destructive move.