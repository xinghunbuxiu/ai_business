import { A2APICapabilitySchema, A2UIComponentSchema, A2WFWorkflowSchema, AppManifestSchema, type BusinessAsset } from "./types.js";

export type ValidationIssue = { path: string; message: string };
export function validateAsset(input: unknown): { valid: true; asset: BusinessAsset } | { valid: false; issues: ValidationIssue[] } {
  if (!input || typeof input !== "object" || !("kind" in input)) return { valid: false, issues: [{ path: "kind", message: "Asset kind is required" }] };
  const kind = (input as { kind: string }).kind;
  const schema = kind === "a2ui" ? A2UIComponentSchema : kind === "a2api" ? A2APICapabilitySchema : kind === "a2wf" ? A2WFWorkflowSchema : kind === "app" ? AppManifestSchema : null;
  if (!schema) return { valid: false, issues: [{ path: "kind", message: `Unsupported asset kind: ${kind}` }] };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { valid: false, issues: parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message })) };
  if (parsed.data.status === "published") return { valid: false, issues: [{ path: "status", message: "Assets must enter the registry as drafts; publish through the registry lifecycle" }] };
  if (parsed.data.visibility === "tenant" && !parsed.data.tenantId) return { valid: false, issues: [{ path: "tenantId", message: "tenantId is required for tenant-scoped assets" }] };
  return { valid: true, asset: parsed.data as BusinessAsset };
}

export function validateForPublish(asset: BusinessAsset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!asset.testEvidence) issues.push({ path: "testEvidence", message: "A passing test evidence record is required before publication" });
  else if (asset.testEvidence.failed > 0 || asset.testEvidence.passed < 1) issues.push({ path: "testEvidence", message: "Publication requires at least one passing test and zero failures" });
  if (asset.status === "deprecated") issues.push({ path: "status", message: "Deprecated assets cannot be published" });
  if (asset.kind === "a2ui" && !["Form", "Table", "Card", "List", "Chart", "OrderSummary", "EmployeeForm"].includes(asset.component)) {
    issues.push({ path: "component", message: "Component is not in the safe renderer allowlist" });
  }
  return issues;
}
