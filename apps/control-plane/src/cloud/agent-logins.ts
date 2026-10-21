// Reads the agent login a workspace creator selected for an organization in
// Settings → Agents. Storage, encryption and consent are the existing vault's;
// cloud v2 only opens the selected, current, unrevoked version.
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { DatabaseCodexAuthRenewal, type CodexCredentialVersion } from "../agent-credentials/codex-auth-renewal.js";
import {
  openCloudAgentCredential,
  type CloudAgentCredentialKeys,
  type CloudAgentCredentialKind,
  type CloudAgentCredentialMaterial,
} from "../agent-credentials/agent-credential-envelope.js";

export type CloudV2AgentProvider = "codex" | "claude" | "cursor";
export type CloudV2AgentLogins = (ownerUserId: string, organizationId: string, provider: CloudV2AgentProvider) =>
  Promise<CloudAgentCredentialMaterial | null>;

type Row = {
  id: string; owner_user_id: string; kind: CloudAgentCredentialKind; current_version: number;
  key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer;
};

const KINDS: Record<CloudV2AgentProvider, readonly CloudAgentCredentialKind[]> = {
  codex: ["codex-chatgpt", "codex-api-key"],
  claude: ["claude-setup-token", "claude-api-key"],
  cursor: ["cursor-api-key"],
};

export function createCloudV2AgentLogins(pool: pg.Pool, keys: CloudAgentCredentialKeys): CloudV2AgentLogins {
  return async (ownerUserId, organizationId, provider) => {
    const { rows } = await withSystemTx(pool, tx => tx.query<Row>(
      `SELECT credential.id, credential.owner_user_id, credential.kind, credential.current_version,
              material.key_version, material.nonce, material.ciphertext, material.auth_tag
       FROM cloud_agent_organization_connections connection
       JOIN cloud_agent_credentials credential ON credential.id = connection.credential_id
         AND credential.owner_user_id = connection.owner_user_id AND credential.revoked_at IS NULL
       JOIN cloud_agent_credential_versions material ON material.credential_id = credential.id
         AND material.version = credential.current_version
       WHERE connection.org_id = $1 AND connection.owner_user_id = $2 AND connection.provider = $3
         AND coalesce(material.material_mode, 'local') = 'local'`,
      [organizationId, ownerUserId, provider],
    ));
    const row = rows[0];
    if (!row || !KINDS[provider].includes(row.kind)) return null;
    return openCloudAgentCredential(
      { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      { credentialId: row.id, ownerUserId: row.owner_user_id, kind: row.kind, version: row.current_version, keyVersion: row.key_version },
      keys.keys,
    );
  };
}

/** Renews the ChatGPT login the creator selected, with the vault's fenced,
 * single-use refresh, so concurrent requests never spend a refresh token twice. */
export function createCloudV2CodexRefresh(pool: pg.Pool, keys: CloudAgentCredentialKeys, renewal = new DatabaseCodexAuthRenewal(pool, keys)) {
  return async (ownerUserId: string, organizationId: string): Promise<void> => {
    const reservation = await withSystemTx(pool, async tx => {
      const credential = (await tx.query<CodexCredentialVersion>(
        `SELECT credential.id, credential.owner_user_id, credential.revision, credential.current_version
         FROM cloud_agent_organization_connections connection
         JOIN cloud_agent_credentials credential ON credential.id = connection.credential_id
           AND credential.owner_user_id = connection.owner_user_id AND credential.revoked_at IS NULL AND credential.kind = 'codex-chatgpt'
         WHERE connection.org_id = $1 AND connection.owner_user_id = $2 AND connection.provider = 'codex'
         FOR UPDATE OF credential`,
        [organizationId, ownerUserId],
      )).rows[0];
      return credential ? renewal.reserve(tx, credential) : null;
    });
    if (reservation) await renewal.complete(reservation);
  };
}
