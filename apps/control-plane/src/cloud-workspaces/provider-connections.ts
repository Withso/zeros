import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { Tx } from "../db.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CREDENTIAL_BYTES = 64 * 1024;

export type CloudProviderConnection = {
  id: string;
  organizationId: string;
  provider: "daytona";
  credentialSource: "hosted" | "delegated";
  endpoint: string;
  region: string | null;
  credentialVersion: number;
};

type StoredProviderConnection = {
  id: string;
  org_id: string;
  provider: "daytona";
  credential_source: "hosted" | "delegated";
  endpoint: string;
  region: string | null;
  current_version: string | number;
};

type SelectableProviderConnection = StoredProviderConnection & {
  owner_kind: "user" | "organization";
  owner_user_id: string | null;
  state: "active" | "revoked" | "invalid";
  capabilities: Record<string, unknown>;
  credential_expires_at: Date | string | null;
  retired_at: Date | string | null;
};

function parseEnvelopeKey(encodedKey: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new Error("cloud credential key must be 32-byte base64url");
  }
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    key.fill(0);
    throw new Error("cloud credential key must be canonical base64url");
  }
  return key;
}

function credentialAad(input: {
  connectionId: string;
  organizationId: string;
  version: number;
  provider: "daytona";
  endpoint: string;
}): Buffer {
  return Buffer.from(
    [
      "zeros-cloud-provider-credential-v1",
      input.organizationId,
      input.connectionId,
      String(input.version),
      input.provider,
      input.endpoint,
    ].join("\0"),
    "utf8",
  );
}

function validCredentialBinding(input: {
  connectionId: string;
  organizationId: string;
  version: number;
  provider: "daytona";
  endpoint: string;
}): boolean {
  if (
    !UUID_PATTERN.test(input.connectionId) ||
    !UUID_PATTERN.test(input.organizationId) ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1
  ) {
    return false;
  }
  try {
    const endpoint = new URL(input.endpoint);
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.hash === "" &&
      endpoint.search === "" &&
      endpoint.hostname.length > 0 &&
      input.endpoint.length <= 2_048
    );
  } catch {
    return false;
  }
}

export function sealCloudProviderCredential(
  credential: string,
  binding: {
    connectionId: string;
    organizationId: string;
    version: number;
    provider: "daytona";
    endpoint: string;
  },
  encodedKey: string,
): {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  credentialSha256: Buffer;
} {
  const bytes = Buffer.byteLength(credential, "utf8");
  if (
    bytes < 16 ||
    bytes > MAX_CREDENTIAL_BYTES ||
    /[\0\r\n]/.test(credential) ||
    !validCredentialBinding(binding)
  ) {
    throw new Error("cloud provider credential input is invalid");
  }
  const key = parseEnvelopeKey(encodedKey);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(credentialAad(binding));
    const ciphertext = Buffer.concat([
      cipher.update(credential, "utf8"),
      cipher.final(),
    ]);
    return {
      nonce,
      ciphertext,
      authTag: cipher.getAuthTag(),
      credentialSha256: createHash("sha256")
        .update(credential, "utf8")
        .digest(),
    };
  } finally {
    key.fill(0);
  }
}

export function openCloudProviderCredential(
  sealed: {
    keyVersion: number;
    nonce: Buffer;
    ciphertext: Buffer;
    authTag: Buffer;
  },
  binding: {
    connectionId: string;
    organizationId: string;
    version: number;
    provider: "daytona";
    endpoint: string;
  },
  encodedKey: string,
): string {
  if (
    !Number.isSafeInteger(sealed.keyVersion) ||
    sealed.keyVersion < 1 ||
    sealed.nonce.length !== 12 ||
    sealed.authTag.length !== 16 ||
    sealed.ciphertext.length < 1 ||
    sealed.ciphertext.length > MAX_CREDENTIAL_BYTES ||
    !validCredentialBinding(binding)
  ) {
    throw new Error("cloud provider credential is invalid");
  }
  const key = parseEnvelopeKey(encodedKey);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
    decipher.setAAD(credentialAad(binding));
    decipher.setAuthTag(sealed.authTag);
    const credential = Buffer.concat([
      decipher.update(sealed.ciphertext),
      decipher.final(),
    ]).toString("utf8");
    if (
      Buffer.byteLength(credential, "utf8") < 16 ||
      Buffer.byteLength(credential, "utf8") > MAX_CREDENTIAL_BYTES ||
      /[\0\r\n]/.test(credential)
    ) {
      throw new Error("cloud provider credential is invalid");
    }
    return credential;
  } catch {
    throw new Error("cloud provider credential is invalid");
  } finally {
    key.fill(0);
  }
}

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
    provider: "daytona";
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
      `Hosted ${input.provider === "daytona" ? "Daytona" : input.provider}`,
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

/** Select an explicitly requested provider account for a new immutable
 * generation. Personal tenants may use only their account-owned connection;
 * an Organization owner may choose either their own delegated account or an
 * Organization-owned connection. Existing generations never call this helper
 * and remain pinned to their original credential version. */
export async function selectCloudProviderConnectionForNewGeneration(
  tx: Tx,
  input: {
    connectionId: string;
    organizationId: string;
    ownerUserId: string;
    isPersonal: boolean;
    provider: "daytona";
  },
): Promise<CloudProviderConnection | null> {
  if (!UUID_PATTERN.test(input.connectionId)) return null;
  const selected = await tx.query<SelectableProviderConnection>(
    `SELECT connection.id, connection.org_id, connection.provider,
            connection.credential_source, connection.owner_kind,
            connection.owner_user_id, connection.state,
            version.capabilities, connection.region,
            connection.current_version, version.endpoint,
            version.credential_expires_at, version.retired_at
     FROM provider_connections connection
     JOIN provider_connection_versions version
       ON version.connection_id = connection.id
      AND version.org_id = connection.org_id
      AND version.version = connection.current_version
     WHERE connection.id = $1 AND connection.org_id = $2
       AND connection.provider = $3 AND connection.state = 'active'
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
      input.provider,
      input.ownerUserId,
      input.isPersonal,
    ],
  );
  const row = selected.rows[0];
  if (!row) return null;
  if (
    row.credential_source === "delegated" &&
    (row.capabilities.qualified !== true ||
      row.capabilities.lifecycle !== true ||
      row.capabilities.commandExecution !== true ||
      (row.credential_expires_at !== null &&
        new Date(row.credential_expires_at).getTime() <= Date.now() + 5 * 60_000))
  ) {
    return null;
  }
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
            connection.region, version.version AS current_version
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
       AND (
         $4::boolean = false
         OR (
           connection.state = 'active'
           AND version.retired_at IS NULL
           AND (
             version.credential_source = 'hosted'
             OR (
               version.capabilities ->> 'qualified' = 'true'
               AND version.capabilities ->> 'lifecycle' = 'true'
               AND version.capabilities ->> 'commandExecution' = 'true'
               AND (
                 version.credential_expires_at IS NULL
                 OR version.credential_expires_at > now() + interval '5 minutes'
               )
             )
           )
         )
       )`,
    [
      input.workspaceId,
      input.organizationId,
      input.generation,
      input.requireActive !== false,
    ],
  );
  return result.rows[0] ? document(result.rows[0]) : null;
}
