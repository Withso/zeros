import type pg from "pg";
import { HttpError, roleAtLeast, type OrganizationRole } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import { McpUuidSchema, type RuntimeMcpServer } from "../cloud/contract.js";
import { openMcpMaterial, sealMcpMaterial, type McpBinding, type McpEnvelope } from "./envelope.js";
import type { McpRepository } from "./repositories.js";
import { McpConfigSchema, McpDraftSchema, McpRepositorySchema, McpRepositoryIdSchema, McpSecretsPatchSchema, McpWriteSchema,
  materializeMcp, mergeMcpSecrets, newOAuthBinding, sameOAuthIdentity, selectMcpEntries, type McpConfig, type McpDraft, type McpSecrets } from "./model.js";

export interface McpRow {
  id: string; org_id: string; owner_user_id: string | null; kind: "mcp"; repository: string | null; repository_id: string | null; repository_identity_revision: number | null; revision: number;
  config: McpConfig; secret_names: { env: string[]; headers: string[]; oauthClientSecret: boolean };
  secret_envelope: McpEnvelope; oauth_binding: string; updated_at: Date; connected?: boolean;
}
export interface McpExtension {
  id: string; kind: "mcp"; owner: "organization" | "user"; repository: string | null; revision: number; config: McpConfig;
  secrets: McpRow["secret_names"]; canEdit: boolean; updatedAt: string; oauth: { status: "connected" | "needs-auth" };
}
export type AttachOAuth = (tx: Tx, organizationId: string, userId: string, attemptId: string, row: McpRow) => Promise<void>;
export type CloudMcpRepositoryTarget = { repositoryId: string };
export type CloudMcpRepositoryAdmission = (organizationId: string, userId: string, repository: string) => Promise<
  CloudMcpRepositoryTarget & { assertCurrent(tx: Tx): Promise<void> }>;
export const mcpNotFound = () => new HttpError(404, "not_found", "MCP configuration not found");
export const mcpConflict = () => new HttpError(409, "revision_conflict", "MCP configuration changed. Reload it before saving.");
export function uuid(value: string): string {
  const result = McpUuidSchema.safeParse(value);
  if (!result.success) throw mcpNotFound();
  return result.data.toLowerCase();
}
const publicRow = (row: McpRow, userId: string, role: OrganizationRole): McpExtension => ({
  id: row.id, kind: row.kind, owner: row.owner_user_id ? "user" : "organization", repository: row.repository,
  revision: row.revision, config: McpConfigSchema.parse(row.config), secrets: row.secret_names,
  canEdit: row.owner_user_id === userId || (row.owner_user_id === null && roleAtLeast(role, "admin")),
  updatedAt: row.updated_at.toISOString(), oauth: { status: row.connected ? "connected" : "needs-auth" },
});
const connected = `g.refresh_claim IS NULL AND (g.access_expires_at IS NULL OR g.access_expires_at>clock_timestamp() OR g.refreshable)`;

export class McpStore {
  attachOAuth?: AttachOAuth;
  constructor(readonly pool: pg.Pool, readonly keys: CloudAgentCredentialKeys,
    private readonly repositories: (organizationId: string, userId: string, tx?: Tx) => Promise<readonly (string | McpRepository)[] | null>,
    private readonly cloudRepositoryAdmission?: CloudMcpRepositoryAdmission) {}

  async member(tx: Tx, organizationId: string, userId: string, mutation = false): Promise<OrganizationRole> {
    const result = await tx.query<{ role: OrganizationRole }>(
      `SELECT m.role FROM organization_members m JOIN organizations o ON o.id=m.org_id
       JOIN users u ON u.id=m.user_id
       WHERE m.org_id=$1 AND m.user_id=$2 AND NOT o.is_personal AND o.deleted_at IS NULL AND u.deleted_at IS NULL AND u.auth_status='active'
       ${mutation ? "FOR SHARE OF m,o,u" : ""}`, [uuid(organizationId), uuid(userId)]);
    if (!result.rows[0]) throw mcpNotFound();
    return result.rows[0].role;
  }
  async requireMember(organizationId: string, userId: string): Promise<void> {
    await withSystemTx(this.pool, tx => this.member(tx, organizationId, userId));
  }
  async mutation(tx: Tx, organizationId: string, userId: string): Promise<OrganizationRole> {
    await tx.query("/* lock_purpose='mcp-configuration' */ SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`mcp:${uuid(organizationId)}`]);
    return this.member(tx, organizationId, userId, true);
  }
  async listRepositories(organizationId: string, userId: string): Promise<McpRepository[]> {
    await this.requireMember(organizationId, userId);
    const rows = await this.repositories(organizationId, userId);
    await this.requireMember(organizationId, userId);
    return (rows ?? []).map(row => typeof row === "string" ? { repository: row } : row);
  }
  async requireRepository(organizationId: string, userId: string, repository: string, tx?: Tx): Promise<McpRepository> {
    const parsed = McpRepositorySchema.safeParse(repository);
    const admitted = parsed.success ? (await this.repositories(organizationId, userId, tx))?.find(row => (typeof row === "string" ? row : row.repository).toLowerCase() === parsed.data) : undefined;
    if (!admitted)
      throw new HttpError(404, "repository_not_found", "Select a repository available to this organization");
    return typeof admitted === "string" ? { repository: admitted } : admitted;
  }
  binding(row: McpRow): McpBinding {
    return { organizationId: row.org_id, ownerUserId: row.owner_user_id, id: row.id, revision: row.revision, purpose: "config" };
  }
  secrets(row: McpRow): McpSecrets {
    const material = McpSecretsPatchSchema.parse(openMcpMaterial(row.secret_envelope, this.binding(row), this.keys));
    if (Object.values(material.env ?? {}).some(value => value === null) || Object.values(material.headers ?? {}).some(value => value === null) || material.oauthClientSecret === null)
      throw new Error("Invalid stored MCP secret material");
    return material as McpSecrets;
  }
  private async attemptBinding(tx: Tx, organizationId: string, userId: string, attemptId: string,
    target: { extensionId: string | undefined; expectedRevision: number | null | undefined; config: McpConfig; secrets: McpSecrets; retainedBinding: string | undefined },
    save = false): Promise<string> {
    const invalid = () => save ? new HttpError(422, "mcp_oauth_failed", "MCP sign-in could not complete. Check the client configuration and try again.")
      : new HttpError(409, "mcp_auth_required", "Sign in to this MCP server");
    const attempt = (await tx.query<{ extension_id: string | null; expected_revision: number | null; binding: string; envelope: McpEnvelope }>(
      `SELECT extension_id,expected_revision,binding,envelope FROM organization_mcp_oauth_attempts
       WHERE id=$1 AND org_id=$2 AND owner_user_id=$3 AND status='connected' AND expires_at>clock_timestamp() ${save ? "FOR UPDATE" : ""}`,
      [uuid(attemptId), uuid(organizationId), uuid(userId)])).rows[0];
    // A supplied attempt must be admitted before considering its identity.
    // It cannot bypass a stale revision or another row.
    if (!attempt || (attempt.extension_id !== null && (attempt.extension_id !== target.extensionId || attempt.expected_revision !== target.expectedRevision))) throw invalid();
    const material = openMcpMaterial(attempt.envelope,
      { organizationId, ownerUserId: userId, id: attemptId, revision: 1, purpose: "attempt" }, this.keys) as { config: McpConfig; secrets: McpSecrets };
    if (!sameOAuthIdentity(material, target)) throw invalid();
    // Drafts only read. Saving can reconcile a fresh same-identity attempt to
    // the saved row's opaque binding, preserving every other member's grant.
    // The caller's mutation transaction rolls this back if attach refuses it.
    if (save && target.retainedBinding && attempt.binding !== target.retainedBinding) {
      await tx.query("UPDATE organization_mcp_oauth_attempts SET binding=$2 WHERE id=$1", [attemptId, target.retainedBinding]);
      return target.retainedBinding;
    }
    return attempt.binding;
  }
  async read(tx: Tx, organizationId: string, userId: string, id: string, lock = false): Promise<McpRow> {
    const result = await tx.query<McpRow>(`SELECT * FROM organization_extensions WHERE id=$1 AND org_id=$2
      AND (owner_user_id IS NULL OR owner_user_id=$3) ${lock ? "FOR UPDATE" : ""}`, [uuid(id), uuid(organizationId), uuid(userId)]);
    if (!result.rows[0]) throw mcpNotFound();
    return result.rows[0];
  }
  async get(organizationId: string, userId: string, id: string): Promise<McpRow> {
    return withSystemTx(this.pool, async tx => { await this.member(tx, organizationId, userId); return this.read(tx, organizationId, userId, id); });
  }
  async list(organizationId: string, userId: string): Promise<McpExtension[]> {
    return withSystemTx(this.pool, async tx => {
      const role = await this.member(tx, organizationId, userId);
      const result = await tx.query<McpRow>(`SELECT e.*, EXISTS(SELECT 1 FROM organization_mcp_oauth g
        WHERE g.extension_id=e.id AND g.owner_user_id=$2 AND g.binding=e.oauth_binding AND ${connected}) AS connected
        FROM organization_extensions e WHERE e.org_id=$1 AND (e.owner_user_id IS NULL OR e.owner_user_id=$2)
        ORDER BY e.created_at,e.id LIMIT 129`, [organizationId, userId]);
      if (result.rows.length > 128) throw new HttpError(409, "mcp_limit", "Too many MCP configurations");
      return result.rows.map(row => publicRow(row, userId, role));
    });
  }

  async put(organizationId: string, userId: string, id: string, raw: unknown, githubPlacement: "local" | "cloud" = "local"): Promise<McpExtension> {
    organizationId = uuid(organizationId); userId = uuid(userId); id = uuid(id);
    const parsed = McpWriteSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(422, "invalid_mcp_config", "Invalid MCP configuration");
    const input = parsed.data;
    await this.requireMember(organizationId, userId);
    // The settings chooser is explicit. Cloud provider I/O finishes before
    // the mutation transaction; native runtime admission below stays separate.
    let cloudAdmission: Awaited<ReturnType<CloudMcpRepositoryAdmission>> | undefined;
    if (input.repository && githubPlacement === "cloud") {
      if (!this.cloudRepositoryAdmission) throw new HttpError(503, "cloud_github_unavailable", "Cloud GitHub is unavailable.");
      cloudAdmission = await this.cloudRepositoryAdmission(organizationId, userId, input.repository);
    }
    try {
      return await withSystemTx(this.pool, async tx => {
        // Mutations alone serialize the per-owner bound and name uniqueness.
        const role = await this.mutation(tx, organizationId, userId);
        let repositoryId: string | null = null;
        if (cloudAdmission) {
          await cloudAdmission.assertCurrent(tx);
          repositoryId = McpRepositoryIdSchema.parse(cloudAdmission.repositoryId);
        } else if (input.repository) {
          const admitted = await this.requireRepository(organizationId, userId, input.repository, tx);
          repositoryId = admitted.repositoryId ? McpRepositoryIdSchema.parse(admitted.repositoryId) : null;
        }
        if (input.owner === "organization" && !roleAtLeast(role, "admin")) throw new HttpError(403, "forbidden", "Requires admin role");
        const existing = (await tx.query<McpRow>("SELECT * FROM organization_extensions WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (existing && (existing.org_id !== organizationId || (existing.owner_user_id !== null && existing.owner_user_id !== userId))) throw mcpNotFound();
        if (existing?.owner_user_id === null && !roleAtLeast(role, "admin")) throw new HttpError(403, "forbidden", "Requires admin role");
        if (existing ? existing.revision !== input.expectedRevision : input.expectedRevision !== null) throw mcpConflict();
        // Never downgrade recorded identity, or silently rebind retained secrets
        // when an unrelated repository takes an existing definition's name.
        if (existing?.repository_id && input.repository && (!repositoryId ||
          (existing.repository === input.repository && existing.repository_id !== repositoryId)))
          throw new HttpError(409, "mcp_repository_changed", "This repository changed. Select the original repository's current name before saving.");
        const ownerUserId = input.owner === "user" ? userId : null;
        const count = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM organization_extensions
          WHERE org_id=$1 AND owner_user_id IS NOT DISTINCT FROM $2::uuid AND id<>$3`, [organizationId, ownerUserId, id]);
        if (count.rows[0]!.count >= 64) throw new HttpError(409, "mcp_limit", "This owner already has 64 MCP configurations");
        const previous = existing ? this.secrets(existing) : {}, next = mergeMcpSecrets(input.config, input.secrets ?? {}, previous);
        // Historical SHA/HMAC markers stay opaque; only decrypted identity
        // equality permits retention, independently of the current server key.
        const retainedBinding = existing && sameOAuthIdentity({ config: existing.config, secrets: previous }, next) ? existing.oauth_binding : undefined;
        const binding = input.oauthAttemptId ? await this.attemptBinding(tx, organizationId, userId, input.oauthAttemptId,
          { extensionId: id, expectedRevision: input.expectedRevision, ...next, retainedBinding }, true) : retainedBinding ?? newOAuthBinding();
        const revision = (existing?.revision ?? 0) + 1;
        const names = { env: Object.keys(next.secrets.env ?? {}), headers: Object.keys(next.secrets.headers ?? {}), oauthClientSecret: !!next.secrets.oauthClientSecret };
        const envelope = sealMcpMaterial(next.secrets, { organizationId, ownerUserId, id, revision, purpose: "config" }, this.keys);
        const result = await tx.query<McpRow>(`INSERT INTO organization_extensions(id,org_id,owner_user_id,kind,repository,revision,config,secret_names,secret_envelope,oauth_binding,repository_id,repository_identity_revision)
          VALUES($1,$2,$3,'mcp',$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10::bigint IS NOT NULL THEN $5::integer END)
          ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,repository=excluded.repository,repository_id=excluded.repository_id,
            repository_identity_revision=excluded.repository_identity_revision,revision=excluded.revision,
            config=excluded.config,secret_names=excluded.secret_names,secret_envelope=excluded.secret_envelope,oauth_binding=excluded.oauth_binding,updated_at=clock_timestamp()
          RETURNING *`, [id, organizationId, ownerUserId, input.repository, revision, next.config, names, envelope, binding, repositoryId]);
        const row = result.rows[0]!;
        if (existing && (existing.oauth_binding !== binding || existing.owner_user_id !== ownerUserId ||
          existing.repository_id !== repositoryId || (!repositoryId && existing.repository !== input.repository)))
          await tx.query("DELETE FROM organization_mcp_oauth WHERE extension_id=$1", [id]);
        if (input.oauthAttemptId) {
          if (!this.attachOAuth) throw new HttpError(409, "mcp_auth_unavailable", "OAuth is unavailable");
          await this.attachOAuth(tx, organizationId, userId, input.oauthAttemptId, row);
        }
        row.connected = (await tx.query<{ connected: boolean }>(`SELECT EXISTS(SELECT 1 FROM organization_mcp_oauth g
          WHERE g.extension_id=$1 AND g.owner_user_id=$2 AND g.binding=$3 AND ${connected}) AS connected`, [id, userId, row.oauth_binding])).rows[0]!.connected;
        return publicRow(row, userId, role);
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new HttpError(409, "mcp_name_conflict", "That owner and project already have an MCP server with this name");
      throw error;
    }
  }
  async remove(organizationId: string, userId: string, id: string, revision: number): Promise<void> {
    await withSystemTx(this.pool, async tx => {
      const role = await this.mutation(tx, organizationId, userId), row = await this.read(tx, organizationId, userId, id, true);
      if (row.owner_user_id === null && !roleAtLeast(role, "admin")) throw new HttpError(403, "forbidden", "Requires admin role");
      if (row.revision !== revision) throw mcpConflict();
      await tx.query("DELETE FROM organization_extensions WHERE id=$1", [id]);
    });
  }
  async draft(organizationId: string, userId: string, raw: unknown): Promise<{ input: McpDraft; config: McpConfig; secrets: McpSecrets; binding: string }> {
    const parsed = McpDraftSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(422, "invalid_mcp_config", "Invalid MCP configuration");
    const input = parsed.data;
    return withSystemTx(this.pool, async tx => {
      const role = await this.member(tx, organizationId, userId);
      const row = input.extensionId ? await this.read(tx, organizationId, userId, input.extensionId) : undefined;
      if (row && row.revision !== input.expectedRevision) throw mcpConflict();
      const previous = row ? this.secrets(row) : {}, next = mergeMcpSecrets(input.config, input.secrets ?? {}, previous);
      const retainedBinding = row && sameOAuthIdentity({ config: row.config, secrets: previous }, next) ? row.oauth_binding : undefined;
      // Members can sign in to the shared definition. Redirecting its retained
      // credentials or changing its OAuth identity requires edit authority.
      if (row?.owner_user_id === null && !roleAtLeast(role, "admin") && !retainedBinding)
        throw new HttpError(403, "forbidden", "Requires admin role to change this shared server");
      const binding = input.oauthAttemptId ? await this.attemptBinding(tx, organizationId, userId, input.oauthAttemptId,
        { extensionId: row?.id, expectedRevision: input.expectedRevision, ...next, retainedBinding }) : retainedBinding ?? newOAuthBinding();
      return { input, ...next, binding };
    });
  }
  async resolve(organizationId: string, userId: string, repository: string, admittedWorkspace?: CloudMcpRepositoryTarget): Promise<RuntimeMcpServer[]> {
    await this.requireMember(organizationId, userId);
    repository = McpRepositorySchema.parse(repository);
    // A cloud caller supplies its admitted workspace's immutable source ID.
    // Name-only legacy definitions remain available to Local, but cannot prove
    // cloud provenance; saving them with verified access records their identity.
    return withSystemTx(this.pool, async tx => {
      await this.member(tx, organizationId, userId);
      const admitted = admittedWorkspace ?? await this.requireRepository(organizationId, userId, repository, tx);
      const repositoryId = admitted.repositoryId ? McpRepositoryIdSchema.parse(admitted.repositoryId) : null;
      if (admittedWorkspace && !repositoryId)
        throw new HttpError(409, "mcp_repository_identity_required", "Verify this workspace's original repository before loading its tools.");
      const rows = (await tx.query<McpRow>(`SELECT * FROM organization_extensions WHERE org_id=$1
        AND (owner_user_id IS NULL OR owner_user_id=$2) AND (repository IS NULL OR (repository_id=$4::bigint AND repository_identity_revision=revision)
          OR ($5::boolean AND repository_id IS NULL AND repository=$3))
        ORDER BY id LIMIT 129`, [organizationId, userId, repository, repositoryId, !admittedWorkspace])).rows;
      if (rows.length > 128) throw new HttpError(409, "mcp_limit", "Too many MCP configurations");
      // All scoped rows above already match the admitted identity. Normalize
      // only this selection view so renamed repositories retain override order.
      return selectMcpEntries(rows.map(row => ({ ...row, ownerUserId: row.owner_user_id,
        repository: row.repository === null ? null : repository })), userId, repository).map(row => this.runtime(row));
    });
  }
  runtime(row: McpRow): RuntimeMcpServer {
    const config = materializeMcp(McpConfigSchema.parse(row.config), this.secrets(row));
    if (config.transport === "stdio") return { id: row.id, name: config.name, transport: "stdio", command: config.command,
      ...(config.args ? { args: config.args } : {}), ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: config.env } : {}), ...(config.listen_url ? { listen_url: config.listen_url } : {}) };
    return { id: row.id, name: config.name, transport: config.transport, url: config.url, auth: config.auth ?? "none",
      ...(config.headers ? { headers: config.headers } : {}), ...(config.disabled_tools ? { disabled_tools: config.disabled_tools } : {}) };
  }
}
