import { createHash } from "node:crypto";
import type { BusinessAsset, AssetKind } from "./types.js";
import { validateAsset, validateForPublish } from "./validator.js";

const key = (id: string, version: string) => `${id}@${version}`;
export type StoredAsset = { asset: BusinessAsset; hash: string; publishedAt?: string };
export class AssetRegistry {
  private readonly assets = new Map<string, StoredAsset>();
  private readonly latest = new Map<string, string>();

  register(input: unknown): StoredAsset {
    const result = validateAsset(input);
    if (!result.valid) throw new Error(`ASSET_INVALID: ${result.issues.map(i => `${i.path}: ${i.message}`).join("; ")}`);
    const asset = result.asset;
    const id = key(asset.id, asset.version);
    if (this.assets.has(id)) throw new Error(`ASSET_IMMUTABLE: ${id} already exists`);
    const hash = createHash("sha256").update(JSON.stringify(asset)).digest("hex");
    const stored = { asset, hash };
    this.assets.set(id, stored);
    return stored;
  }

  publish(id: string, version: string): StoredAsset {
    const k = key(id, version);
    const stored = this.assets.get(k);
    if (!stored) throw new Error(`ASSET_NOT_FOUND: ${k}`);
    if (stored.asset.status === "published") throw new Error(`ASSET_ALREADY_PUBLISHED: ${k}`);
    const issues = validateForPublish(stored.asset);
    if (issues.length) throw new Error(`PUBLISH_BLOCKED: ${issues.map(i => i.message).join("; ")}`);
    const published = { ...stored, asset: { ...stored.asset, status: "published" as const }, publishedAt: new Date().toISOString() };
    this.assets.set(k, published);
    this.latest.set(id, version);
    return published;
  }

  get(id: string, version?: string): StoredAsset | undefined {
    const resolved = version ?? this.latest.get(id);
    if (!resolved) return undefined;
    const stored = this.assets.get(key(id, resolved));
    return stored?.asset.status === "published" ? stored : undefined;
  }

  list(options: { kind?: AssetKind; tenantId?: string; includeSystem?: boolean } = {}): StoredAsset[] {
    return [...this.assets.values()].filter(({ asset }) =>
      asset.status === "published" &&
      (!options.kind || asset.kind === options.kind) &&
      (asset.visibility === "system" || (asset.visibility === "tenant" && asset.tenantId === options.tenantId) || (asset.visibility === "private" && asset.tenantId === options.tenantId)) &&
      (options.includeSystem !== false || asset.visibility !== "system")
    );
  }
}
