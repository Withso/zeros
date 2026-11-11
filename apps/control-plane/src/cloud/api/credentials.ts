import { randomBytes } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { audit } from "../../audit.js";
import { HttpError, type OrganizationRole } from "../../authz.js";
import { withSystemStatement, withSystemTx, type Tx } from "../../db.js";
import { memberOnHoldSql, PRO_ORGANIZATION_FREE_MEMBER_LIMIT, PRO_ORGANIZATION_MEMBER_LIMIT } from "../../organization-seats.js";
import { sql, SqlFragment } from "../../sql-fragment.js";
import { hashCloudV2Token, isCloudV2Token } from "../tokens.js";
import type { CloudExecutionContexts } from "../execution/store.js";
import type { ExecutionAdmission } from "../execution/authority.js";

export type CloudApiCredential = {
  credentialId: string;
  kind: "api_key" | "workspace_token";
  userId: string;
  email: string;
  name: string | null;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  workspaceId?: string;
  contextId?: string;
  executionProof?: ExecutionAdmission;
};
export type CloudApiKey = { id: string; name: string; ownerUserId: string; ownerName: string | null;
  prefix: string; createdAt: string; lastUsedAt: string | null };
type KeyRow = { id: string; name: string; owner_user_id: string; owner_name: string | null; prefix: string;
  created_at: Date; last_used_at: Date | null };
type CredentialRow = { id: string; user_id: string; email: string; display_name: string | null;
  org_id: string; organization_slug: string; organization_name: string; workspace_id?: string; last_used_at?: Date | null };
const keyDocument = (row: KeyRow): CloudApiKey => ({ id: row.id, name: row.name, ownerUserId: row.owner_user_id,
  ownerName: row.owner_name, prefix: row.prefix, createdAt: row.created_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null });
export const CloudApiKeyNameSchema = z.string().trim().min(1).max(80);
const KEY = /^zk_[A-Za-z0-9_-]{43}$/;
const unauthorized = () => new HttpError(401, "unauthorized", "Invalid API credential");
const notFound = () => new HttpError(404, "not_found", "Not found");
const LIVE_MEMBER = sql`u.auth_status='active' AND u.deleted_at IS NULL AND o.deleted_at IS NULL
  AND NOT o.is_personal AND o.cloud_workspaces_allowed
  AND NOT organization_member_on_hold(m.org_id,m.user_id,
    ${SqlFragment.integer(PRO_ORGANIZATION_MEMBER_LIMIT, 1, 1000)},
    ${SqlFragment.integer(PRO_ORGANIZATION_FREE_MEMBER_LIMIT, 0, 1000)})`;

export class CloudApiCredentials {
  execution?: CloudExecutionContexts;
  private readonly used = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  constructor(private readonly pool: pg.Pool) {}

  private async lookup(kind: CloudApiCredential["kind"], condition: SqlFragment, tx?: Tx): Promise<CloudApiCredential | null> {
    const query = kind === "api_key"
      ? sql`SELECT k.id,k.owner_user_id AS user_id,k.org_id,k.last_used_at,
          u.email,u.display_name,o.slug AS organization_slug,o.name AS organization_name FROM cloud_api_keys k
          JOIN users u ON u.id=k.owner_user_id JOIN organizations o ON o.id=k.org_id
          JOIN organization_members m ON m.org_id=k.org_id AND m.user_id=k.owner_user_id
          WHERE ${condition} AND k.revoked_at IS NULL AND ${LIVE_MEMBER}`
      : sql`SELECT t.id,w.creator_user_id AS user_id,w.org_id,w.id AS workspace_id,
          u.email,u.display_name,o.slug AS organization_slug,o.name AS organization_name FROM cloud_v2_tokens t
          JOIN cloud_v2_workspaces w ON w.id=t.workspace_id JOIN users u ON u.id=w.creator_user_id
          JOIN organizations o ON o.id=w.org_id JOIN organization_members m ON m.org_id=w.org_id AND m.user_id=w.creator_user_id
          WHERE ${condition} AND t.kind='api' AND w.execution_mode<>'active' AND w.api_access AND w.stop_generation=t.api_stop_generation
            AND w.state IN ('creating','starting','running')
            AND w.archived_at IS NULL AND ${LIVE_MEMBER}`;
    const result = tx ? await tx.query<CredentialRow>(query.text) : await withSystemStatement<CredentialRow>(this.pool, query);
    const row = result.rows[0];
    if (!row) return null;
    if (kind === "api_key" && (!row.last_used_at || Date.now() - row.last_used_at.getTime() >= 60_000)) this.recordUsed(row.id);
    return { credentialId: row.id, kind, userId: row.user_id, email: row.email, name: row.display_name,
      organizationId: row.org_id, organizationSlug: row.organization_slug, organizationName: row.organization_name,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}) };
  }

  async resolve(authorization: string | undefined): Promise<CloudApiCredential> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (/^zw2x_[A-Za-z0-9_-]{43}$/.test(token) && this.execution) return this.contextCredential({ token });
    const kind = KEY.test(token) ? "api_key" : isCloudV2Token(token, "api") ? "workspace_token" : null;
    if (!kind) throw unauthorized();
    const hash = SqlFragment.text(hashCloudV2Token(token).toString("hex"), /^[0-9a-f]{64}$/);
    const found = await this.lookup(kind, kind === "api_key" ? sql`k.token_hash=decode(${hash},'hex')` : sql`t.token_hash=decode(${hash},'hex')`);
    if (!found) throw unauthorized();
    return found;
  }

  async assertCurrent(credential: CloudApiCredential, tx?: Tx): Promise<void> {
    if (credential.contextId) {
      if (!this.execution || !credential.executionProof) throw unauthorized();
      const read = async (current: Tx) => {
        await this.execution!.assertToken(current, credential.credentialId, credential.contextId!, "api", credential.executionProof!);
      };
      if (tx) await read(tx); else await withSystemTx(this.pool, read);
      return;
    }
    const id = SqlFragment.uuid(credential.credentialId);
    const current = await this.lookup(credential.kind, credential.kind === "api_key" ? sql`k.id=${id}` : sql`t.id=${id}`, tx);
    if (!current || current.userId !== credential.userId || current.organizationId !== credential.organizationId) throw unauthorized();
  }

  private async contextCredential(value: { token: string } | { id: string }, transaction?: Tx): Promise<CloudApiCredential> {
    if (!this.execution) throw unauthorized();
    const { context, proof } = await this.execution.tokenContext("api", value, transaction);
    const read = async (tx: Tx) => {
      const row = (await tx.query<CredentialRow>(`SELECT u.email,u.display_name,o.slug AS organization_slug,o.name AS organization_name
        FROM users u JOIN organizations o ON o.id=$2 WHERE u.id=$1`, [context.user_id, context.org_id])).rows[0];
      await this.execution!.assertContext(tx, context, proof);
      if (!row) throw unauthorized();
      return { credentialId: context.token_id, kind: "workspace_token" as const, userId: context.user_id!, email: row.email, name: row.display_name,
        organizationId: context.org_id, organizationSlug: row.organization_slug, organizationName: row.organization_name,
        workspaceId: context.workspace_id, contextId: context.id, executionProof: proof };
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }

  private async member(tx: Tx, org: string, user: string, lock = false): Promise<OrganizationRole> {
    const { rows } = await tx.query<{ role: OrganizationRole }>(`SELECT m.role FROM organization_members m
      JOIN organizations o ON o.id=m.org_id JOIN users u ON u.id=m.user_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND o.deleted_at IS NULL AND NOT o.is_personal
        AND u.deleted_at IS NULL AND u.auth_status='active' AND NOT ${memberOnHoldSql("m.org_id", "m.user_id")}
      ${lock ? "FOR UPDATE OF m" : ""}`, [org, user]);
    if (!rows[0]) throw notFound();
    return lock ? this.member(tx, org, user) : rows[0].role;
  }

  list(org: string, user: string): Promise<{ apiKeys: CloudApiKey[] }> {
    return withSystemTx(this.pool, async tx => {
      const role = await this.member(tx, org, user);
      const { rows } = await tx.query<KeyRow>(`SELECT k.id,k.name,k.owner_user_id,u.display_name AS owner_name,k.prefix,k.created_at,k.last_used_at
        FROM cloud_api_keys k JOIN users u ON u.id=k.owner_user_id
        WHERE k.org_id=$1 AND k.revoked_at IS NULL AND ($3::boolean OR k.owner_user_id=$2)
        ORDER BY k.created_at DESC,k.id`, [org, user, role !== "member"]);
      return { apiKeys: rows.map(keyDocument) };
    });
  }

  create(org: string, user: string, name: string): Promise<{ apiKey: CloudApiKey; key: string }> {
    const parsed = CloudApiKeyNameSchema.safeParse(name);
    if (!parsed.success) throw new HttpError(400, "invalid_request", "Name must contain 1 to 80 characters");
    return withSystemTx(this.pool, async tx => {
      await this.member(tx, org, user, true);
      if (!(await tx.query("SELECT 1 FROM organizations WHERE id=$1 AND cloud_workspaces_allowed", [org])).rowCount)
        throw new HttpError(409, "cloud_workspaces_not_enabled", "Cloud workspaces are not enabled for this organization");
      const count = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM cloud_api_keys WHERE org_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL", [org, user])).rows[0]!.n;
      if (count >= 20) throw new HttpError(409, "api_key_limit", "At most 20 active API keys are allowed per organization");
      const key = `zk_${randomBytes(32).toString("base64url")}`;
      const { rows } = await tx.query<KeyRow>(`INSERT INTO cloud_api_keys(org_id,owner_user_id,name,prefix,token_hash)
        VALUES($1,$2,$3,$4,$5) RETURNING id,name,owner_user_id,prefix,created_at,last_used_at,
          (SELECT display_name FROM users WHERE id=$2) AS owner_name`, [org, user, parsed.data, key.slice(0, 7), hashCloudV2Token(key)]);
      const apiKey = keyDocument(rows[0]!);
      await audit(tx, org, user, "cloud_api_key.created", { apiKeyId: apiKey.id });
      return { apiKey, key };
    });
  }

  revoke(org: string, user: string, id: string): Promise<void> {
    return withSystemTx(this.pool, async tx => {
      const role = await this.member(tx, org, user, true);
      const changed = await tx.query(`UPDATE cloud_api_keys SET revoked_at=clock_timestamp()
        WHERE id=$1 AND org_id=$2 AND revoked_at IS NULL AND ($4::boolean OR owner_user_id=$3) RETURNING id`, [id, org, user, role !== "member"]);
      if (!changed.rowCount) throw notFound();
      await audit(tx, org, user, "cloud_api_key.revoked", { apiKeyId: id });
    });
  }

  access(org: string, user: string): Promise<{ workspaceApiAccess: boolean }> {
    return withSystemTx(this.pool, async tx => {
      await this.member(tx, org, user);
      const { rows } = await tx.query<{ workspace_api_access: boolean }>(
        "SELECT workspace_api_access FROM cloud_api_access_settings WHERE org_id=$1 AND user_id=$2", [org, user]);
      return { workspaceApiAccess: rows[0]?.workspace_api_access ?? true };
    });
  }

  setAccess(org: string, user: string, value: boolean): Promise<{ workspaceApiAccess: boolean }> {
    return withSystemTx(this.pool, async tx => {
      await this.member(tx, org, user, true);
      await tx.query(`INSERT INTO cloud_api_access_settings(org_id,user_id,workspace_api_access) VALUES($1,$2,$3)
        ON CONFLICT(org_id,user_id) DO UPDATE SET workspace_api_access=EXCLUDED.workspace_api_access,updated_at=clock_timestamp()`, [org, user, value]);
      return { workspaceApiAccess: value };
    });
  }

  private recordUsed(id: string): void {
    if (this.used.size < 10_000 || this.used.has(id)) this.used.set(id, Date.now());
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flushUsed().catch(() => {}); }, 60_000);
      this.timer.unref();
    }
  }

  /** Approximate usage timestamps never put an UPDATE on an authenticated read. */
  flushUsed(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.used.size) return Promise.resolve();
    const batch = [...this.used]; this.used.clear();
    this.flushing = withSystemTx(this.pool, async tx => {
      await tx.query(`UPDATE cloud_api_keys k SET last_used_at=greatest(k.last_used_at,used.at)
        FROM unnest($1::uuid[],$2::timestamptz[]) AS used(id,at) WHERE k.id=used.id AND k.revoked_at IS NULL`,
        [batch.map(([id]) => id), batch.map(([, at]) => new Date(at))]);
    }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async close(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    await this.flushing;
    await this.flushUsed();
  }
}
