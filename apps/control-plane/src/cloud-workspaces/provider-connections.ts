import type { Tx } from "../db.js";
import {
  isSupportedCloudWorkspaceProviderBinding,
  type CloudWorkspaceProviderName,
} from "./provider.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CloudProviderConnection = {
  id: string;
  organizationId: string;
  provider: CloudWorkspaceProviderName;
  credentialSource: "hosted" | "delegated";
  endpoint: string;
  region: string | null;
  credentialVersion: number;
};

type StoredProviderConnection = {
  id: string;
  org_id: string;
  provider: CloudWorkspaceProviderName;
  credential_source: "hosted" | "delegated";
  endpoint: string;
  region: string | null;
  current_version: string | number;
};

function document(row: StoredProviderConnection): CloudProviderConnection {
  const credentialVersion = Number(row.current_version);
  if (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1) {
    throw new Error("cloud provider connection version is invalid");
  }
  return {
    id: row.id,
    organizationId: row.org_id,
    provider: row.provider,
    credentialSource: row.credential_source,
    endpoint: row.endpoint,
    region: row.region,
    credentialVersion,
  };
}

/**
 * Resolve the deployment-hosted provider identity for a new generation.
 * Callers hold the organization row lock, which serializes first creation and
 * keeps the connection/version cycle atomic without a global advisory lock.
 */
export async function ensureHostedCloudProviderConnection(
  tx: Tx,
  input: {
    organizationId: string;
    ownerUserId: string;
    isPersonal: boolean;
    provider: CloudWorkspaceProviderName;
    actorUserId: string;
  },
): Promise<CloudProviderConnection> {
  const existing = await tx.query<StoredProviderConnection>(
    `SELECT connection.id, connection.org_id, connection.provider,
            connection.credential_source, version.endpoint,
            connection.region, connection.current_version
     FROM provider_connections connection
     JOIN provider_connection_versions version
       ON version.connection_id = connection.id
      AND version.org_id = connection.org_id
      AND version.version = connection.current_version
     WHERE connection.org_id = $1
       AND connection.provider = $2
       AND connection.credential_source = 'hosted'
       AND connection.state = 'active'
       AND connection.owner_kind = $3::cloud_profile_owner
       AND connection.owner_user_id IS NOT DISTINCT FROM $4::uuid
     ORDER BY connection.created_at, connection.id
     LIMIT 2`,
    [
      input.organizationId,
      input.provider,
      input.isPersonal ? "user" : "organization",
      input.isPersonal ? input.ownerUserId : null,
    ],
  );
  if (existing.rows.length > 1) {
    throw new Error("cloud provider connection identity is ambiguous");
  }
  if (existing.rows[0]) return document(existing.rows[0]);

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO provider_connections (
       org_id, owner_kind, owner_user_id, provider, display_name,
       credential_source, current_version, state
     ) VALUES (
       $1, $2::cloud_profile_owner, $3, $4, $5,
       'hosted', 1, 'active'
     ) RETURNING id`,
    [
      input.organizationId,
      input.isPersonal ? "user" : "organization",
      input.isPersonal ? input.ownerUserId : null,
      input.provider,
      `Hosted ${input.provider}`,
    ],
  );
  const connectionId = inserted.rows[0]!.id;
  const endpoint = `hosted://${input.provider}`;
  await tx.query(
    `INSERT INTO provider_connection_versions (
       connection_id, org_id, version, credential_source, endpoint, created_by
     ) VALUES ($1, $2, 1, 'hosted', $3, $4)`,
    [connectionId, input.organizationId, endpoint, input.actorUserId],
  );
  return {
    id: connectionId,
    organizationId: input.organizationId,
    provider: input.provider,
    credentialSource: "hosted",
    endpoint,
    region: null,
    credentialVersion: 1,
  };
}

/** Select an explicitly requested hosted account for a new immutable
 * generation, enforcing its tenant and owner. Existing generations never call
 * this helper and remain pinned to their original connection version. */
export async function selectCloudProviderConnectionForNewGeneration(
  tx: Tx,
  input: {
    connectionId: string;
    organizationId: string;
    ownerUserId: string;
    isPersonal: boolean;
    providers: readonly CloudWorkspaceProviderName[];
  },
): Promise<CloudProviderConnection | null> {
  if (!UUID_PATTERN.test(input.connectionId)) return null;
  const selected = await tx.query<StoredProviderConnection>(
    `SELECT connection.id, connection.org_id, connection.provider,
            connection.credential_source, connection.region,
            connection.current_version, version.endpoint
     FROM provider_connections connection
     JOIN provider_connection_versions version
       ON version.connection_id = connection.id
      AND version.org_id = connection.org_id
      AND version.version = connection.current_version
     WHERE connection.id = $1 AND connection.org_id = $2
       AND connection.provider = ANY($3::text[]) AND connection.state = 'active'
       AND connection.credential_source = 'hosted'
       AND version.credential_source = 'hosted'
       AND version.retired_at IS NULL
       AND (
         (connection.owner_kind = 'user' AND connection.owner_user_id = $4)
         OR (
           NOT $5::boolean AND connection.owner_kind = 'organization'
           AND connection.owner_user_id IS NULL
         )
       )
     FOR SHARE OF connection, version`,
    [
      input.connectionId,
      input.organizationId,
      input.providers,
      input.ownerUserId,
      input.isPersonal,
    ],
  );
  const row = selected.rows[0];
  if (!row || !isSupportedCloudWorkspaceProviderBinding({ provider: row.provider, credentialSource: row.credential_source })) return null;
  return document(row);
}

export async function loadGenerationCloudProviderConnection(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    requireActive?: boolean;
  },
): Promise<CloudProviderConnection | null> {
  const result = await tx.query<StoredProviderConnection>(
    `SELECT connection.id, connection.org_id, connection.provider,
            connection.credential_source, version.endpoint,
            connection.region, version.version AS current_version, generation.sandbox_class
     FROM cloud_workspace_generations generation
     JOIN provider_connections connection
       ON connection.id = generation.provider_connection_id
      AND connection.org_id = generation.org_id
     JOIN provider_connection_versions version
       ON version.connection_id = connection.id
      AND version.org_id = connection.org_id
      AND version.version = generation.provider_connection_version
     WHERE generation.workspace_id = $1
       AND generation.org_id = $2
       AND generation.generation = $3
       AND connection.credential_source = 'hosted'
       AND version.credential_source = 'hosted'
       AND (
         $4::boolean = false
         OR (
           connection.state = 'active'
           AND version.retired_at IS NULL
         )
       )`,
    [
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.requireActive !== false,
    ],
  );
  const row = result.rows[0];
  return row && isSupportedCloudWorkspaceProviderBinding({ provider: row.provider, credentialSource: row.credential_source, sandboxClass: (row as StoredProviderConnection & { sandbox_class?: unknown }).sandbox_class }) ? document(row) : null;
}
