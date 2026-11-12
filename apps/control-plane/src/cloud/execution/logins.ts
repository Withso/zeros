import type pg from "pg";
import type { Tx } from "../../db.js";
import { withSystemTx } from "../../db.js";
import { openCloudAgentCredential, parseCloudAgentCredential, type CloudAgentCredentialKeys, type CloudAgentCredentialMaterial } from "../../agent-credentials/agent-credential-envelope.js";
import type { CloudV2Agent } from "../contract.js";
import { DatabaseCodexAuthRenewal, type CodexCredentialVersion } from "../../agent-credentials/codex-auth-renewal.js";
import { actorChanged, AgentLoginRequired, executionUnavailable } from "./errors.js";

export type ExecutionSelection = { source: "personal" | "shared"; credentialId: string; credentialRevision: string; connectionRevision: string };
export type ExecutionLogin = { selection: ExecutionSelection; material: CloudAgentCredentialMaterial };
export type SharedExecutionLogin = (organizationId: string, agent: CloudV2Agent, tx?: Tx) => Promise<ExecutionLogin | null>;

/** The shared-key selection port is deliberately separate from provisioning.
 * A configured shared key that cannot be read must fail, never choose a person. */
export class CloudExecutionLogins {
  constructor(readonly pool: pg.Pool, readonly keys: CloudAgentCredentialKeys, readonly shared?: SharedExecutionLogin) {}

  async refreshCodex(organizationId: string, userId: string, expected: ExecutionSelection, check: () => Promise<unknown>) {
    if (expected.source !== "personal") throw executionUnavailable();
    const renewal = new DatabaseCodexAuthRenewal(this.pool, this.keys);
    const reservation = await withSystemTx(this.pool, async tx => {
      const credential = (await tx.query<CodexCredentialVersion>(`SELECT k.id,k.owner_user_id,k.revision,k.current_version
        FROM cloud_agent_credentials k JOIN cloud_agent_organization_connections c ON c.credential_id=k.id
        WHERE c.org_id=$1 AND c.owner_user_id=$2 AND c.provider='codex' AND k.owner_user_id=$2 AND k.id=$3
          AND k.revision=$4::bigint AND c.revision=$5::bigint AND k.kind='codex-chatgpt' AND k.revoked_at IS NULL FOR UPDATE OF k`,
      [organizationId, userId, expected.credentialId, expected.credentialRevision, expected.connectionRevision])).rows[0];
      if (!credential) throw actorChanged();
      return renewal.reserve(tx, credential);
    });
    await check();
    try { if (reservation) await renewal.complete(reservation); }
    catch { await check(); throw executionUnavailable(); }
    await check();
  }

  async select(organizationId: string, userId: string, agent: CloudV2Agent, expected?: ExecutionSelection, transaction?: Tx): Promise<ExecutionLogin> {
    const read = async (tx: Tx): Promise<ExecutionLogin> => {
      let selected: ExecutionLogin | null;
      try { selected = await this.shared?.(organizationId, agent, tx) ?? null; }
      catch { throw executionUnavailable(); }
      if (selected) {
        try { selected = { ...selected, material: parseCloudAgentCredential(selected.material) }; }
        catch { throw executionUnavailable(); }
        if (selected.selection.source !== "shared" || !selected.material.kind.startsWith(`${agent}-`)) throw executionUnavailable();
      } else {
        type Row = { credential_id: string | null; revision: string; credential_revision: string | null; revoked_at: Date | null;
          kind: CloudAgentCredentialMaterial["kind"]; current_version: number; current_revision: string; owner_user_id: string;
          key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer; material_mode: string | null };
        const row = (await tx.query<Row>(`SELECT c.credential_id,c.revision::text,c.credential_revision::text,k.revoked_at,k.kind,k.current_version,
          k.revision::text AS current_revision,k.owner_user_id,v.key_version,v.nonce,v.ciphertext,v.auth_tag,v.material_mode
          FROM cloud_agent_organization_connections c
          LEFT JOIN cloud_agent_credentials k ON k.id=c.credential_id AND k.owner_user_id=c.owner_user_id
          LEFT JOIN cloud_agent_credential_versions v ON v.credential_id=k.id AND v.version=k.current_version
          WHERE c.org_id=$1 AND c.owner_user_id=$2 AND c.provider=$3`, [organizationId, userId, agent])).rows[0];
        if (!row?.credential_id || row.revoked_at) throw expected ? actorChanged() : new AgentLoginRequired(agent);
        if (row.owner_user_id !== userId || !row.kind.startsWith(`${agent}-`) || row.credential_revision !== row.current_revision ||
            !row.ciphertext || (row.material_mode !== null && row.material_mode !== "local")) throw executionUnavailable();
        let material: CloudAgentCredentialMaterial;
        try { material = openCloudAgentCredential({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
          { credentialId: row.credential_id, ownerUserId: userId, kind: row.kind, version: row.current_version, keyVersion: row.key_version }, this.keys.keys); }
        catch { throw executionUnavailable(); }
        if (material.kind === "cursor-api-key" && material.expiresAt !== undefined && material.expiresAt * 1000 <= Date.now())
          throw expected ? actorChanged() : new AgentLoginRequired(agent);
        selected = { selection: { source: "personal", credentialId: row.credential_id, credentialRevision: row.current_revision, connectionRevision: row.revision }, material };
      }
      if (expected && (["source", "credentialId", "credentialRevision", "connectionRevision"] as const)
        .some(field => selected.selection[field] !== expected[field])) throw actorChanged();
      return selected;
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }
}
