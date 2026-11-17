import type { ProviderRegistration, ProviderRegistrationState, RegisteredProvider } from "./provider.js";

export type ProviderRecordKey = {
  projectId: string;
  serviceId: string;
  providerId: string;
  environment: ProviderRegistration["environment"];
  instanceId: string;
};

/** Minimal driver-neutral PostgreSQL query contract. Adapt pg Pool/Client or a framework DB client. */
export interface PostgreSqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface ProviderRepository {
  insert(provider: RegisteredProvider): Promise<void>;
  get(key: ProviderRecordKey): Promise<RegisteredProvider | undefined>;
  listActive(input: {
    capabilityId: string;
    capabilityVersion: string;
    environment: ProviderRegistration["environment"];
    now?: Date;
  }): Promise<RegisteredProvider[]>;
  updateState(key: ProviderRecordKey, state: Exclude<ProviderRegistrationState, "active">): Promise<boolean>;
  renewLease(key: ProviderRecordKey, issuedAt: Date, expiresAt: Date): Promise<RegisteredProvider>;
  deleteExpired(now?: Date): Promise<number>;
}

type ProviderRow = {
  registration: ProviderRegistration;
  state: ProviderRegistrationState;
};

/**
 * PostgreSQL implementation. The database unique key is the final concurrency
 * guard; callers must authenticate project ownership and authorize bindingRef
 * before insert/renewal. Never expose this repository directly to provider HTTP.
 */
export class PostgresProviderRepository implements ProviderRepository {
  constructor(private readonly db: PostgreSqlExecutor) {}

  async insert(provider: RegisteredProvider): Promise<void> {
    const r = provider.registration;
    await this.db.query(
      `INSERT INTO a2api_providers
       (project_id, service_id, provider_id, environment, instance_id, registration, state, lease_expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,NOW())`,
      [r.projectId, r.serviceId, r.providerId, r.environment, r.instanceId, JSON.stringify(r), provider.state, r.lease.expiresAt]
    );
  }

  async get(key: ProviderRecordKey): Promise<RegisteredProvider | undefined> {
    const result = await this.db.query<ProviderRow>(
      `SELECT registration, state FROM a2api_providers
       WHERE project_id=$1 AND service_id=$2 AND provider_id=$3 AND environment=$4 AND instance_id=$5`,
      [key.projectId, key.serviceId, key.providerId, key.environment, key.instanceId]
    );
    return result.rows[0] ? { registration: result.rows[0].registration, state: result.rows[0].state } : undefined;
  }

  async listActive(input: { capabilityId: string; capabilityVersion: string; environment: ProviderRegistration["environment"]; now?: Date }): Promise<RegisteredProvider[]> {
    const result = await this.db.query<ProviderRow>(
      `SELECT registration, state FROM a2api_providers
       WHERE state='active' AND environment=$1 AND lease_expires_at > $2
         AND registration @> $3::jsonb
       ORDER BY project_id, service_id, provider_id, instance_id`,
      [input.environment, input.now ?? new Date(), JSON.stringify({ capabilities: [{ capabilityId: input.capabilityId, capabilityVersion: input.capabilityVersion }] })]
    );
    return result.rows.map(row => ({ registration: row.registration, state: row.state }));
  }

  async updateState(key: ProviderRecordKey, state: Exclude<ProviderRegistrationState, "active">): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE a2api_providers SET state=$6, updated_at=NOW()
       WHERE project_id=$1 AND service_id=$2 AND provider_id=$3 AND environment=$4 AND instance_id=$5`,
      [key.projectId, key.serviceId, key.providerId, key.environment, key.instanceId, state]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async renewLease(key: ProviderRecordKey, issuedAt: Date, expiresAt: Date): Promise<RegisteredProvider> {
    if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt || expiresAt <= new Date()) {
      throw new Error("PROVIDER_LEASE_INVALID: renewal window is invalid");
    }
    const result = await this.db.query<ProviderRow>(
      `UPDATE a2api_providers
       SET registration=jsonb_set(jsonb_set(registration, '{lease,issuedAt}', to_jsonb($6::text)), '{lease,expiresAt}', to_jsonb($7::text)),
           lease_expires_at=$7, updated_at=NOW()
       WHERE project_id=$1 AND service_id=$2 AND provider_id=$3 AND environment=$4 AND instance_id=$5
         AND state='active' AND lease_expires_at > NOW()
       RETURNING registration, state`,
      [key.projectId, key.serviceId, key.providerId, key.environment, key.instanceId, issuedAt.toISOString(), expiresAt.toISOString()]
    );
    if (!result.rows[0]) throw new Error("PROVIDER_LEASE_RENEWAL_REJECTED: provider is missing, inactive or expired");
    return { registration: result.rows[0].registration, state: result.rows[0].state };
  }

  async deleteExpired(now = new Date()): Promise<number> {
    const result = await this.db.query(
      "DELETE FROM a2api_providers WHERE lease_expires_at <= $1",
      [now]
    );
    return result.rowCount ?? 0;
  }
}

export const PROVIDER_POSTGRES_MIGRATION = `
CREATE TABLE IF NOT EXISTS a2api_providers (
  project_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('dev','test','staging','prod')),
  instance_id TEXT NOT NULL,
  registration JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','draining','revoked')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, service_id, provider_id, environment, instance_id),
  CHECK (jsonb_typeof(registration->'capabilities') = 'array')
);
CREATE INDEX IF NOT EXISTS idx_a2api_providers_capability
  ON a2api_providers (environment, state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_a2api_providers_project
  ON a2api_providers (project_id, environment);
`;
