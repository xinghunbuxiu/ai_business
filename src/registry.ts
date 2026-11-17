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
    for (const dependency of this.getRequiredDependencies(stored.asset)) {
      const resolved = this.get(dependency.id, dependency.version);
      if (!resolved) issues.push({ path: "dependencies", message: `Dependency is not published: ${dependency.id}@${dependency.version}` });
      else if (dependency.kind && resolved.asset.kind !== dependency.kind) issues.push({ path: "dependencies", message: `Dependency kind mismatch: ${dependency.id}@${dependency.version}` });
      else if ((resolved.asset.visibility === "tenant" || resolved.asset.visibility === "private") && resolved.asset.tenantId !== stored.asset.tenantId) issues.push({ path: "dependencies", message: `Dependency is outside the asset tenant: ${dependency.id}@${dependency.version}` });
    }
    if (issues.length) throw new Error(`PUBLISH_BLOCKED: ${issues.map(i => i.message).join("; ")}`);
    const publishedAsset = { ...stored.asset, status: "published" as const };
    const publishedHash = createHash("sha256").update(JSON.stringify(publishedAsset)).digest("hex");
    const published = { asset: publishedAsset, hash: publishedHash, publishedAt: new Date().toISOString() };
    this.assets.set(k, published);
    this.latest.set(id, version);
    return published;
  }

  private getRequiredDependencies(asset: BusinessAsset): Array<{ id: string; version: string; kind?: AssetKind }> {
    const dependencies: Array<{ id: string; version: string; kind?: AssetKind }> = [...asset.dependencies];
    if (asset.kind === "a2ui") {
      for (const event of asset.events) dependencies.push({ id: event.target.id, version: event.target.version, kind: event.target.kind });
    }
    if (asset.kind === "a2wf") {
      for (const step of asset.steps) {
        if (step.type === "action" && step.capability && step.capabilityVersion) dependencies.push({ id: step.capability, version: step.capabilityVersion, kind: "a2api" });
        if (step.type === "form" && step.component && step.componentVersion) dependencies.push({ id: step.component, version: step.componentVersion, kind: "a2ui" });
      }
    }
    if (asset.kind === "app") {
      for (const dependency of asset.assets) dependencies.push(dependency);
    }
    return dependencies;
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
