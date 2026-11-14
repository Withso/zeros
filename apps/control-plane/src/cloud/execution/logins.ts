import type pg from "pg";
import type { Tx } from "../../db.js";
import { withSystemTx } from "../../db.js";
import { openCloudAgentCredential, parseCloudAgentCredential, type CloudAgentCredentialKeys, type CloudAgentCredentialMaterial } from "../../agent-credentials/agent-credential-envelope.js";
import type { CloudV2Agent } from "../contract.js";
import { DatabaseCodexAuthRenewal, type CodexCredentialVersion } from "../../agent-credentials/codex-auth-renewal.js";
import { memberOnHoldSql } from "../../organization-seats.js";
import { cloudAgentModels } from "../../agent-credentials/agent-models.js";
import { actorChanged, AgentLoginRequired, executionUnavailable, workspaceCreatorRequired } from "./errors.js";

export type ExecutionPayer = { userId: string; accountRevision: string; memberRevision: string; memberCreatedAt: string };
export type ExecutionSelection = { source: "personal" | "shared"; credentialId: string; credentialRevision: string; connectionRevision: string } &
  ({ version?: undefined; payer?: undefined } | { version: 2; payer: ExecutionPayer });
export type ExecutionLogin = { selection: ExecutionSelection; material: CloudAgentCredentialMaterial };
export type SharedExecutionLogin = (organizationId: string, agent: CloudV2Agent, tx?: Tx) => Promise<ExecutionLogin | null>;
type AgentPresentation = { agentLogins: Partial<Record<CloudV2Agent, true>>; agentModels: Partial<Record<CloudV2Agent, string[]>> };

export async function selectedAgentLoginAvailability(tx: Tx, organizationId: string, userId: string): Promise<Partial<Record<CloudV2Agent, true>>> {
  return (await selectedAgentPresentation(tx, organizationId, userId)).agentLogins;
}

async function selectedAgentPresentation(tx: Tx, organizationId: string, userId: string): Promise<AgentPresentation> {
  const rows = (await tx.query<{ provider: CloudV2Agent; models: string[]; all_models: boolean }>(`SELECT c.provider,c.models,c.all_models FROM cloud_agent_organization_connections c
    JOIN cloud_agent_credentials k ON k.id=c.credential_id AND k.owner_user_id=c.owner_user_id
    JOIN cloud_agent_credential_versions v ON v.credential_id=k.id AND v.version=k.current_version
    WHERE c.org_id=$1 AND c.owner_user_id=$2 AND k.revoked_at IS NULL AND c.credential_revision=k.revision
      AND (v.material_mode IS NULL OR v.material_mode='local')`, [organizationId, userId])).rows;
  return {
    agentLogins: Object.fromEntries(rows.map(row => [row.provider, true as const])),
    agentModels: Object.fromEntries(rows.map(row => [row.provider, [...new Set(row.all_models ? cloudAgentModels(row.provider) : row.models)]])),
  };
}

/** The shared-key selection port is deliberately separate from provisioning.
 * A configured shared key that cannot be read must fail, never choose a person. */
export class CloudExecutionLogins {
  constructor(readonly pool: pg.Pool, readonly keys: CloudAgentCredentialKeys, readonly shared?: SharedExecutionLogin) {}

  private async payer(tx: Tx, organizationId: string, userId: string): Promise<ExecutionPayer | undefined> {
    return (await tx.query<ExecutionPayer>(`SELECT u.id AS "userId",u.auth_revision::text AS "accountRevision",
      m.authorization_revision::text AS "memberRevision",m.created_at::text AS "memberCreatedAt"
      FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2
        AND u.auth_status='active' AND u.deleted_at IS NULL AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")}`,
    [organizationId, userId])).rows[0];
  }

  async assertPayer(tx: Tx, organizationId: string, selection: ExecutionSelection) {
    if (selection.version === undefined) return;
    if (selection.version !== 2 || !selection.payer) throw actorChanged();
    const current = await this.payer(tx, organizationId, selection.payer.userId);
    if (!current || (["userId", "accountRevision", "memberRevision", "memberCreatedAt"] as const)
      .some(key => current[key] !== selection.payer[key])) throw actorChanged();
  }

  private async creator(tx: Tx, workspaceId: string) {
    const workspace = (await tx.query<{ org_id: string; creator_user_id: string | null }>(
      "SELECT org_id,creator_user_id FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active'", [workspaceId])).rows[0];
    const payer = workspace?.creator_user_id && await this.payer(tx, workspace.org_id, workspace.creator_user_id);
    if (!workspace || !payer) throw workspaceCreatorRequired();
    return { organizationId: workspace.org_id, payer };
  }

  async forWorkspace(workspaceId: string, actorId: string, agent: CloudV2Agent, expected?: ExecutionSelection, transaction?: Tx): Promise<ExecutionLogin> {
    const read = async (tx: Tx): Promise<ExecutionLogin> => {
      const { organizationId, payer } = await this.creator(tx, workspaceId);
      if (expected && (expected.version !== 2 || expected.payer.userId !== payer.userId)) throw actorChanged();
      let login: ExecutionLogin;
      try { login = await this.select(organizationId, payer.userId, agent, expected, tx); }
      catch (error) {
        if (error instanceof AgentLoginRequired) throw new AgentLoginRequired(agent, payer.userId === actorId ? "self" : "creator");
        throw error;
      }
      return { ...login, selection: { ...login.selection, version: 2, payer } };
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }

  async availability(workspaceId: string, transaction?: Tx): Promise<Partial<Record<CloudV2Agent, true>>> {
    return (await this.presentation(workspaceId, transaction)).agentLogins;
  }

  async presentation(workspaceId: string, transaction?: Tx): Promise<AgentPresentation> {
    const read = async (tx: Tx): Promise<AgentPresentation> => {
      let current: Awaited<ReturnType<CloudExecutionLogins["creator"]>>;
      try { current = await this.creator(tx, workspaceId); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "workspace_creator_required") return { agentLogins: {}, agentModels: {} }; throw error; }
      return selectedAgentPresentation(tx, current.organizationId, current.payer.userId);
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read, { consistentRead: true });
  }

  async refreshAvailability(workspaceId: string, transaction?: Tx): Promise<string | null> {
    return (await this.refreshPresentation(workspaceId, transaction))?.loginRevision ?? null;
  }

  async refreshPresentation(workspaceId: string, transaction?: Tx): Promise<{ loginRevision: string; presentation: AgentPresentation } | null> {
    const refresh = async (tx: Tx) => {
      const row = (await tx.query<{ login_revision: string; org_id: string }>(
        "SELECT login_revision::text,org_id FROM cloud_v2_workspaces WHERE id=$1 AND execution_mode='active' AND state<>'deleted'", [workspaceId])).rows[0];
      if (!row) return null;
      const presentation = await this.presentation(workspaceId, tx);
      const available = presentation.agentLogins;
      const updated = await tx.query<{ revision: string }>(`UPDATE cloud_v2_workspaces
        SET creator_agent_logins=$2,login_revision=login_revision+1
        WHERE id=$1 AND creator_agent_logins IS DISTINCT FROM $2::jsonb RETURNING login_revision::text AS revision`, [workspaceId, available]);
      if (updated.rowCount) await tx.query("SELECT pg_notify('zeros_cloud_v2_logins',$1)",
        [JSON.stringify({ ownerUserId: null, organizationId: row.org_id, availabilityOnly: true })]);
      return { loginRevision: updated.rows[0]?.revision ?? row.login_revision, presentation };
    };
    if (transaction) return refresh(transaction);
    // Only a changed public map writes. Serializable snapshots prevent a late
    // read on another replica from replacing a newer map at the same revision.
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await withSystemTx(this.pool, refresh, { serializable: true }); }
      catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "40001") || attempt === 2) throw error; }
    }
    throw executionUnavailable();
  }

  async refreshCodex(organizationId: string, userId: string, expected: ExecutionSelection, check: () => Promise<unknown>) {
    if (expected.source !== "personal") throw executionUnavailable();
    const ownerId = expected.version === 2 ? expected.payer.userId : userId;
    const renewal = new DatabaseCodexAuthRenewal(this.pool, this.keys);
    const reservation = await withSystemTx(this.pool, async tx => {
      await this.assertPayer(tx, organizationId, expected);
      const credential = (await tx.query<CodexCredentialVersion>(`SELECT k.id,k.owner_user_id,k.revision,k.current_version
        FROM cloud_agent_credentials k JOIN cloud_agent_organization_connections c ON c.credential_id=k.id
        WHERE c.org_id=$1 AND c.owner_user_id=$2 AND c.provider='codex' AND k.owner_user_id=$2 AND k.id=$3
          AND k.revision=$4::bigint AND c.revision=$5::bigint AND k.kind='codex-chatgpt' AND k.revoked_at IS NULL FOR UPDATE OF k`,
      [organizationId, ownerId, expected.credentialId, expected.credentialRevision, expected.connectionRevision])).rows[0];
      if (!credential) throw actorChanged();
      return renewal.reserve(tx, credential);
    });
    await check();
    try { if (reservation) await renewal.complete(reservation); }
    catch { await check(); throw executionUnavailable(); }
    await check();
  }

  async select(organizationId: string, userId: string, agent: CloudV2Agent, expected?: ExecutionSelection, transaction?: Tx): Promise<ExecutionLogin> {
    const ownerId = expected?.version === 2 ? expected.payer.userId : userId;
    const read = async (tx: Tx): Promise<ExecutionLogin> => {
      if (expected) await this.assertPayer(tx, organizationId, expected);
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
          WHERE c.org_id=$1 AND c.owner_user_id=$2 AND c.provider=$3`, [organizationId, ownerId, agent])).rows[0];
        if (!row?.credential_id || row.revoked_at) throw expected ? actorChanged() : new AgentLoginRequired(agent);
        if (row.owner_user_id !== ownerId || !row.kind.startsWith(`${agent}-`) || row.credential_revision !== row.current_revision ||
            !row.ciphertext || (row.material_mode !== null && row.material_mode !== "local")) throw executionUnavailable();
        let material: CloudAgentCredentialMaterial;
        try { material = openCloudAgentCredential({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
          { credentialId: row.credential_id, ownerUserId: ownerId, kind: row.kind, version: row.current_version, keyVersion: row.key_version }, this.keys.keys); }
        catch { throw executionUnavailable(); }
        if (material.kind === "cursor-api-key" && material.expiresAt !== undefined && material.expiresAt * 1000 <= Date.now())
          throw expected ? actorChanged() : new AgentLoginRequired(agent);
        selected = { selection: { source: "personal", credentialId: row.credential_id, credentialRevision: row.current_revision, connectionRevision: row.revision }, material };
      }
      if (expected && (["source", "credentialId", "credentialRevision", "connectionRevision"] as const)
        .some(field => selected.selection[field] !== expected[field])) throw actorChanged();
      if (expected?.version === 2) selected.selection = { ...selected.selection, version: 2, payer: expected.payer };
      return selected;
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }
}
