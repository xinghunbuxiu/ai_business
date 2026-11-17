# App Builder — Requirement IR and Planning Pipeline

## Scope

The first Builder increment is deterministic and reviewable. It does not ask an LLM to execute code or publish assets. It converts a structured business requirement into a reuse/gap plan and, only when all dependencies are found, a draft App Manifest with exact version pins.

## Requirement IR

`AppRequirementSchema` accepts:
- app identity: `appId`, `appVersion`, `name`, optional description
- visibility: system / tenant / private and tenantId where required
- target roles
- `requiredCapabilities[]`: exact A2API asset IDs
- `requiredComponents[]`: exact A2UI asset IDs
- `workflowIntents[]`: user intents to be implemented by A2WF
- entrypoints: stable ID, label, allowed roles and an intent/component/workflow target

This is a structured IR, not free-form model output. A future natural-language intake step must compile into this schema and pass validation before planning.

## Planner algorithm

1. Validate IR and tenant scope.
2. Query only published assets visible in the tenant/system scope.
3. Resolve A2API and A2UI by stable ID; resolve A2WF by declared trigger intent.
4. Record each reused asset's exact version and SHA-256 content hash.
5. Emit a generation brief for every missing requirement. Do not silently substitute a similar capability.
6. If any gap remains, return `readyForManifest=false` and no manifest.
7. If there are no gaps, create a draft App Manifest that pins every matched asset's exact kind, ID and version. Nothing is published by the planner.

## Trust and release boundary

The planner is read-only against the registry. It cannot execute adapters, create business side effects, modify published assets or publish an app. Generated assets must be registered as new drafts, validated, tested, reviewed and published through the normal registry lifecycle. A later release resolver must re-check every exact dependency and persist a content-hash lock at publication time.

## Current limitation

The first version uses explicit requirement IDs and workflow intents. Semantic search, natural-language requirement extraction, LLM-assisted draft generation, visual editing, test orchestration, approval UI and staged deployment are subsequent Builder milestones. Missing assets are described, not fabricated.
