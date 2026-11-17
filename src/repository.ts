import type { AssetKind, BusinessAsset } from "./types.js";

/** Persistence boundary. Implementations must preserve immutable published versions. */
export type AssetVersionRecord = {
  assetId: string;
  version: string;
  kind: AssetKind;
  status: BusinessAsset["status"];
  content: BusinessAsset;
  contentHash: string;
  createdAt: string;
  publishedAt?: string;
};

export type AssetVisibilityScope = {
  tenantId?: string;
  includeSystem?: boolean;
  kind?: AssetKind;
};

export interface AssetRepository {
  /** Insert a new version. Must fail if (assetId, version) already exists. */
  insertDraft(asset: BusinessAsset, contentHash: string, actorId: string): Promise<AssetVersionRecord>;
  /** Load a specific version. Production callers should request publishedOnly. */
  getVersion(assetId: string, version: string, options?: { publishedOnly?: boolean }): Promise<AssetVersionRecord | undefined>;
  /** Resolve the latest published version visible to this tenant. */
  getLatestPublished(assetId: string, scope: AssetVisibilityScope): Promise<AssetVersionRecord | undefined>;
  listPublished(scope: AssetVisibilityScope): Promise<AssetVersionRecord[]>;
  /** Publish must atomically verify evidence, approvals and pinned dependency versions. */
  publish(assetId: string, version: string, actorId: string): Promise<AssetVersionRecord>;
}
