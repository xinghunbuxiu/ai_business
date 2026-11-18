# SDK extraction completion

The Java SDK has been extracted to `xinghunbuxiu/a2-sdk-java`.

## Verification

- Standalone Maven CI is green on the extracted repository.
- A repository-wide source search found no `dev.aibusiness.a2api` imports outside the legacy SDK tree.
- The extracted repository preserves the original Maven coordinates for compatibility.
- `ai_business` no longer owns the Java SDK source after this migration commit.

## Canonical ownership

- Protocol contracts: `xinghunbuxiu/a2-protocol`
- Java SDK: `xinghunbuxiu/a2-sdk-java`
- Runtime / registry / business implementation: `ai_business`

The old SDK path is intentionally removed after the independent SDK build passed.