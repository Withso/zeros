import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { memberOnHoldSql, organizationMemberOnHold } from "../organization-seats.js";
import type { CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import { CLOUD_V2_LIVE_ACCESS, requireWorkspaceCreator } from "./workspace-access.js";
import { hashCloudV2Token } from "./tokens.js";
import { notifyCloudV2WorkerReady } from "./worker-ready.js";
import type { CloudV2Workspace } from "./store.js";
import { CLOUD_ENVIRONMENT_ERRORS, CLOUD_ENVIRONMENT_LIMITS, CloudEnvironmentMaterialSchema, CloudEnvironmentPatchSchema,
  CloudEnvironmentReportSchema, CloudEnvironmentRepositoryIdSchema, cloudEnvironmentMetadata,
  type CloudEnvironmentMaterial, type CloudEnvironmentMetadata, type CloudWorkspaceEnvironment } from "./environment-contract.js";
import { openCloudEnvironment, sealCloudEnvironment, type CloudEnvironmentEnvelope } from "./environment-envelope.js";

export type CloudEnvironmentAdmission = (organizationId: string, userId: string, repository: string) => Promise<{
  repositoryId: string; assertCurrent(tx: Tx): Promise<void>; assertReadable(): Promise<void>;
}>;
type Scope = { organizationId: string; userId: string; repositoryId: string };
type Head = { revision: string; version_id: string | null; updated_at: Date; envelope: CloudEnvironmentEnvelope | null };
const empty = (): CloudEnvironmentMaterial => ({ variables: {}, files: [] });
const notFound = () => new HttpError(404, "cloud_environment_not_found", "Cloud environment is unavailable for this repository.");
const conflict = () => new HttpError(409, "cloud_environment_changed", "The environment changed elsewhere. Reload it before saving.");
const unreadable = () => new HttpError(503, "cloud_environment_unreadable", "The saved environment could not be read. Its values were retained.");
const uuid = (value: string) => { if (!z.string().uuid().safeParse(value).success) throw notFound(); return value.toLowerCase(); };
const target = (organizationId: string, userId: string, repositoryId: string): Scope => {
  const parsed = CloudEnvironmentRepositoryIdSchema.safeParse(repositoryId);
  if (!parsed.success) throw notFound();
  return { organizationId: uuid(organizationId), userId: uuid(userId), repositoryId: parsed.data };
};
const params = (scope: Scope) => [scope.organizationId, scope.userId, scope.repositoryId];
function invalid(issues: readonly { message: string }[]): HttpError {
  const code = issues.find(issue => (CLOUD_ENVIRONMENT_ERRORS as readonly string[]).includes(issue.message))?.message ?? "cloud_environment_invalid";
  const messages: Record<string, string> = {
    cloud_environment_reserved: "This variable name is reserved for the cloud runtime. Use an application-specific name or a .env file.",
    cloud_environment_variable_limit: "Keep at most 128 application variables per repository.",
    cloud_environment_value_limit: "Each application value must be at most 16 KiB.",
    cloud_environment_file_limit: "Choose at most 16 .env files, each at most 64 KiB.",
    cloud_environment_total_limit: "The complete environment must be at most 256 KiB.",
    cloud_environment_path_invalid: "Choose distinct relative .env or .env.* paths outside private and nested repositories.",
  };
  return new HttpError(422, code, messages[code] ?? "Invalid cloud environment input.");
}

async function member(tx: Tx, scope: Scope, lock = false): Promise<void> {
  const result = await tx.query<{ held: boolean }>(
    `SELECT ${memberOnHoldSql("m.org_id", "m.user_id")} AS held FROM organization_members m
     JOIN organizations o ON o.id=m.org_id JOIN users u ON u.id=m.user_id
     WHERE m.org_id=$1 AND m.user_id=$2 AND NOT o.is_personal AND o.deleted_at IS NULL AND u.deleted_at IS NULL AND u.auth_status='active'
     ${lock ? "FOR SHARE OF m,o,u" : ""}`, [scope.organizationId, scope.userId]);
  if (!result.rows[0]) throw notFound();
  if (result.rows[0].held) throw organizationMemberOnHold();
}
async function lockScope(tx: Tx, scope: Pick<Scope, "organizationId" | "userId">): Promise<void> {
  await tx.query("/* lock_purpose='cloud-environment-write' */ SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`cloud-environment:${scope.organizationId}:${scope.userId}`]);
}

async function environmentHead(tx: Tx, scope: Scope): Promise<Head | undefined> {
  return (await tx.query<Head>(`SELECT h.revision::text,h.version_id,h.updated_at,v.envelope FROM cloud_environment_heads h
    LEFT JOIN cloud_environment_versions v ON v.id=h.version_id AND v.org_id=h.org_id AND v.owner_user_id=h.owner_user_id AND v.repository_id=h.repository_id
    WHERE h.org_id=$1 AND h.owner_user_id=$2 AND h.repository_id=$3`, params(scope))).rows[0];
}
function environmentMaterial(scope: Scope, head: Head | undefined, keys: CloudAgentCredentialKeys): CloudEnvironmentMaterial {
  if (!head || head.version_id === null) return empty();
  try { return openCloudEnvironment(head.envelope, { ...scope, versionId: head.version_id, revision: Number(head.revision) }, keys); }
  catch { throw unreadable(); }
}

/** Called in the creation/idempotency transaction; concurrent default edits
 * cannot change the version between selecting it and retaining its pin. */
export async function pinCloudEnvironment(tx: Tx, workspace: Pick<CloudV2Workspace, "id" | "organizationId" | "creatorUserId">, repositoryId: string,
  overrides?: { variables: Record<string, string>; keys: CloudAgentCredentialKeys }): Promise<void> {
  requireWorkspaceCreator(workspace);
  const scope = target(workspace.organizationId, workspace.creatorUserId, repositoryId);
  await lockScope(tx, scope);
  if (overrides) {
    const current = environmentMaterial(scope, await environmentHead(tx, scope), overrides.keys);
    const material = CloudEnvironmentMaterialSchema.safeParse({ variables: { ...current.variables, ...overrides.variables }, files: current.files });
    if (!material.success) {
      const error = invalid(material.error.issues);
      throw new HttpError(400, error.code, error.message);
    }
    const versionId = randomUUID(), revision = 1;
    const envelope = sealCloudEnvironment(material.data, { ...scope, versionId, revision }, overrides.keys);
    await tx.query("INSERT INTO cloud_environment_versions(id,org_id,owner_user_id,repository_id,revision,envelope) VALUES($4,$1,$2,$3,$5,$6)",
      [...params(scope), versionId, revision, envelope]);
    await tx.query(`INSERT INTO cloud_workspace_environment_pins(workspace_id,org_id,owner_user_id,repository_id,version_id)
      VALUES($4,$1,$2,$3,$5)`, [...params(scope), workspace.id, versionId]);
    return;
  }
  await tx.query(`INSERT INTO cloud_workspace_environment_pins(workspace_id,org_id,owner_user_id,repository_id,version_id)
    SELECT $4,org_id,owner_user_id,repository_id,version_id FROM cloud_environment_heads
    WHERE org_id=$1 AND owner_user_id=$2 AND repository_id=$3 AND version_id IS NOT NULL`, [...params(scope), workspace.id]);
}

async function prune(tx: Tx, scope: Scope): Promise<void> {
  await tx.query(`DELETE FROM cloud_environment_versions v WHERE org_id=$1 AND owner_user_id=$2 AND repository_id=$3
    AND NOT EXISTS (SELECT 1 FROM cloud_environment_heads h WHERE h.version_id=v.id)
    AND NOT EXISTS (SELECT 1 FROM cloud_workspace_environment_pins p WHERE p.version_id=v.id)
      AND NOT EXISTS (SELECT 1 FROM cloud_v2_execution_contexts e WHERE e.environment_version_id=v.id)`, params(scope));
}

/** Callers hold the workspace row before the creator lock, matching deletion. */
export async function releaseCloudEnvironment(tx: Tx, workspaceId: string): Promise<void> {
  const row = (await tx.query<{ org_id: string; owner_user_id: string; repository_id: string }>(
    `SELECT p.org_id,p.owner_user_id,p.repository_id::text FROM cloud_workspace_environment_pins p
     JOIN cloud_v2_workspaces w ON w.id=p.workspace_id WHERE w.id=$1 AND w.state='deleted'`, [workspaceId])).rows[0];
  if (!row) return;
  const scope = { organizationId: row.org_id, userId: row.owner_user_id, repositoryId: row.repository_id };
  await lockScope(tx, scope);
  await tx.query("DELETE FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [workspaceId]);
  await prune(tx, scope);
}

export class CloudEnvironments {
  constructor(private readonly pool: pg.Pool, private readonly keys: CloudAgentCredentialKeys, private readonly authorize: CloudEnvironmentAdmission) {}

  async prune(): Promise<void> {
    // Older writers cannot release pins. Physical deletion can also leave an
    // unreferenced version after the pin's cascading foreign key fires.
    const deleted = await withSystemTx(this.pool, tx => tx.query<{ id: string }>(
      `SELECT w.id FROM cloud_v2_workspaces w JOIN cloud_workspace_environment_pins p ON p.workspace_id=w.id
       WHERE w.state='deleted' ORDER BY w.id LIMIT 100`));
    for (const { id } of deleted.rows) await withSystemTx(this.pool, async tx => {
      const locked = await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 AND state='deleted' FOR UPDATE SKIP LOCKED", [id]);
      if (locked.rowCount) await releaseCloudEnvironment(tx, id);
    });
    const unused = await withSystemTx(this.pool, tx => tx.query<{ org_id: string; owner_user_id: string; repository_id: string }>(
      `SELECT DISTINCT v.org_id,v.owner_user_id,v.repository_id::text FROM cloud_environment_versions v
       WHERE NOT EXISTS (SELECT 1 FROM cloud_environment_heads h WHERE h.version_id=v.id)
       AND NOT EXISTS (SELECT 1 FROM cloud_workspace_environment_pins p WHERE p.version_id=v.id)
      AND NOT EXISTS (SELECT 1 FROM cloud_v2_execution_contexts e WHERE e.environment_version_id=v.id) LIMIT 100`));
    for (const row of unused.rows) await withSystemTx(this.pool, async tx => {
      const scope = { organizationId: row.org_id, userId: row.owner_user_id, repositoryId: row.repository_id };
      await lockScope(tx, scope); await prune(tx, scope);
    });
  }

  private async admission(scope: Scope, repository: string) {
    await withSystemTx(this.pool, tx => member(tx, scope));
    const proof = await this.authorize(scope.organizationId, scope.userId, repository);
    if (proof.repositoryId !== scope.repositoryId) throw notFound();
    return proof;
  }
  async get(organizationId: string, userId: string, repositoryId: string, repository: string): Promise<CloudEnvironmentMetadata> {
    const scope = target(organizationId, userId, repositoryId), proof = await this.admission(scope, repository);
    const result = await withSystemTx(this.pool, async tx => {
      await member(tx, scope);
      const head = await environmentHead(tx, scope), material = environmentMaterial(scope, head, this.keys);
      return cloudEnvironmentMetadata(repositoryId, Number(head?.revision ?? 0), head?.version_id ?? null, head?.updated_at.toISOString() ?? null, material);
    });
    await proof.assertReadable();
    await withSystemTx(this.pool, tx => member(tx, scope));
    return result;
  }

  async patch(organizationId: string, userId: string, repositoryId: string, repository: string, raw: unknown): Promise<CloudEnvironmentMetadata> {
    const parsed = CloudEnvironmentPatchSchema.safeParse(raw);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const scope = target(organizationId, userId, repositoryId), proof = await this.admission(scope, repository), input = parsed.data;
    return withSystemTx(this.pool, async tx => {
      await member(tx, scope, true); await proof.assertCurrent(tx); await lockScope(tx, scope);
      const current = await environmentHead(tx, scope), previous = environmentMaterial(scope, current, this.keys);
      if (Number(current?.revision ?? 0) !== input.expectedRevision || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw conflict();
      if (!current) {
        const count = await tx.query<{ count: string }>("SELECT count(*)::text AS count FROM cloud_environment_heads WHERE org_id=$1 AND owner_user_id=$2", params(scope).slice(0, 2));
        if (Number(count.rows[0]!.count) >= CLOUD_ENVIRONMENT_LIMITS.heads) throw new HttpError(409, "cloud_environment_repository_limit", "Too many repository environment scopes.");
      }
      const material = input.clear ? empty() : { variables: { ...previous.variables }, files: previous.files.map(file => ({ ...file })) };
      for (const [name, value] of Object.entries(input.variables ?? {})) {
        if (value === null) delete material.variables[name]; else material.variables[name] = value;
      }
      const files = new Map(material.files.map(file => [file.path, file.content]));
      for (const file of input.files ?? []) { if (file.content === null) files.delete(file.path); else files.set(file.path, file.content); }
      material.files = [...files].map(([path, content]) => ({ path, content }));
      const bounded = CloudEnvironmentMaterialSchema.safeParse(material);
      if (!bounded.success) throw invalid(bounded.error.issues);
      const revision = input.expectedRevision + 1, versionId = Object.keys(material.variables).length || material.files.length ? randomUUID() : null;
      if (versionId) {
        const envelope = sealCloudEnvironment(material, { ...scope, versionId, revision }, this.keys);
        await tx.query("INSERT INTO cloud_environment_versions(id,org_id,owner_user_id,repository_id,revision,envelope) VALUES($4,$1,$2,$3,$5,$6)",
          [...params(scope), versionId, revision, envelope]);
      }
      const saved = await tx.query<{ updated_at: Date }>(`INSERT INTO cloud_environment_heads(org_id,owner_user_id,repository_id,revision,version_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_id,owner_user_id,repository_id) DO UPDATE
        SET revision=EXCLUDED.revision,version_id=EXCLUDED.version_id,updated_at=clock_timestamp() RETURNING updated_at`, [...params(scope), revision, versionId]);
      await prune(tx, scope);
      return cloudEnvironmentMetadata(repositoryId, revision, versionId, saved.rows[0]!.updated_at.toISOString(), material);
    });
  }

  async resolve(workspace: CloudV2Workspace, transaction?: Tx): Promise<CloudWorkspaceEnvironment | undefined> {
    requireWorkspaceCreator(workspace);
    const read = async (tx: Tx): Promise<CloudWorkspaceEnvironment | undefined> => {
      const row = (await tx.query<{ id: string; repository_id: string; revision: string; envelope: CloudEnvironmentEnvelope }>(
        `SELECT v.id,p.repository_id::text,v.revision::text,v.envelope FROM cloud_workspace_environment_pins p
         JOIN cloud_v2_workspaces w ON w.id=p.workspace_id AND w.org_id=p.org_id AND w.creator_user_id=p.owner_user_id
         JOIN cloud_v2_github_sources s ON s.workspace_id=w.id AND s.source_repository=lower(w.repository) AND s.repository_id=p.repository_id
         JOIN cloud_environment_versions v ON v.id=p.version_id AND v.org_id=p.org_id AND v.owner_user_id=p.owner_user_id AND v.repository_id=p.repository_id
         WHERE w.id=$1 AND w.org_id=$2 AND w.creator_user_id=$3 AND w.state IN ('creating','starting','running') AND ${CLOUD_V2_LIVE_ACCESS}`,
        [workspace.id, workspace.organizationId, workspace.creatorUserId])).rows[0];
      if (!row) {
        const pin = await tx.query("SELECT 1 FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [workspace.id]);
        if (pin.rowCount) throw notFound();
        return undefined;
      }
      try {
        return { versionId: row.id, repositoryId: row.repository_id, ...openCloudEnvironment(row.envelope,
          { organizationId: workspace.organizationId, userId: workspace.creatorUserId, repositoryId: row.repository_id, versionId: row.id, revision: Number(row.revision) }, this.keys) };
      } catch { throw unreadable(); }
    };
    return transaction ? read(transaction) : withSystemTx(this.pool, read);
  }

  async resolveExecution(workspace: CloudV2Workspace, userId: string, contextId: string, tx: Tx): Promise<CloudWorkspaceEnvironment | undefined> {
    // Selection and pruning share this lock. The context pin (including an
    // empty selection) is fixed before a competing material fetch can read it.
    await lockScope(tx, { organizationId: workspace.organizationId, userId });
    const context = (await tx.query<{ environment_version_id: string | null; environment_repository_id: string | null;
      repository_id: string | null; version_id: string | null; revision: string | null; envelope: CloudEnvironmentEnvelope | null }>(`SELECT
        c.environment_version_id,c.environment_repository_id::text,s.repository_id::text,
        coalesce(c.environment_version_id,p.version_id,h.version_id) AS version_id,v.revision::text,v.envelope
      FROM cloud_v2_execution_contexts c
      LEFT JOIN cloud_v2_github_sources s ON s.workspace_id=c.workspace_id AND s.source_repository=lower($5)
      LEFT JOIN cloud_workspace_environment_pins p ON p.workspace_id=c.workspace_id AND p.owner_user_id=c.user_id
      LEFT JOIN cloud_environment_heads h ON h.org_id=c.org_id AND h.owner_user_id=c.user_id AND h.repository_id=s.repository_id
      LEFT JOIN cloud_environment_versions v ON v.id=coalesce(c.environment_version_id,p.version_id,h.version_id)
        AND v.org_id=c.org_id AND v.owner_user_id=c.user_id AND v.repository_id=s.repository_id
      WHERE c.id=$1 AND c.workspace_id=$2 AND c.org_id=$3 AND c.user_id=$4 AND c.state='active' FOR UPDATE OF c`,
      [contextId, workspace.id, workspace.organizationId, userId, workspace.repository])).rows[0];
    if (!context) throw notFound();
    if (context.environment_repository_id && !context.environment_version_id) return undefined;
    if (!context.repository_id) throw notFound();
    // A legacy pin belongs to its person even after the workspace is reassigned.
    const version = context.version_id;
    await tx.query("UPDATE cloud_v2_execution_contexts SET environment_version_id=$2,environment_repository_id=$3 WHERE id=$1 AND environment_repository_id IS NULL",
      [contextId, version, context.repository_id]);
    if (!version) return undefined;
    if (!context.envelope || !context.revision) throw unreadable();
    try { return { versionId: version, repositoryId: context.repository_id, ...openCloudEnvironment(context.envelope,
      { organizationId: workspace.organizationId, userId, repositoryId: context.repository_id, versionId: version, revision: Number(context.revision) }, this.keys) }; }
    catch { throw unreadable(); }
  }

  async report(token: string, bootId: string, raw: unknown): Promise<void> {
    const parsed = CloudEnvironmentReportSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(422, "cloud_environment_report_invalid", "Invalid environment status.");
    const report = parsed.data, boot = uuid(bootId);
    await withSystemTx(this.pool, async tx => {
      const row = (await tx.query<{ id: string; state: string; version_id: string; ready_boot_id: string | null; report_boot_id: string | null;
        report_sequence: string | null; report_state: string | null; report_error: string | null }>(
        `SELECT w.id,w.state,p.version_id,p.ready_boot_id,p.report_boot_id,p.report_sequence::text,p.report_state,p.report_error
         FROM cloud_v2_workspaces w JOIN cloud_workspace_environment_pins p ON p.workspace_id=w.id
         WHERE w.worker_token_hash=$1 AND w.worker_boot_id=$2 AND w.state IN ('creating','starting','running','failed') AND ${CLOUD_V2_LIVE_ACCESS}
         FOR UPDATE OF w,p`, [hashCloudV2Token(token), boot])).rows[0];
      if (!row || row.version_id !== report.versionId) throw new HttpError(401, "worker_unauthorized", "Worker authorization changed.");
      if (row.report_boot_id === boot && Number(row.report_sequence) === report.sequence && row.report_state === report.state && row.report_error === (report.errorCode ?? null)) return;
      if (row.state === "failed" || (row.report_boot_id === boot && Number(row.report_sequence) >= report.sequence) ||
        (row.ready_boot_id === boot && report.state !== "ready")) throw new HttpError(409, "cloud_environment_report_stale", "Environment status is already settled.");
      await tx.query(`UPDATE cloud_workspace_environment_pins SET report_boot_id=$2,report_sequence=$3,report_state=$4,report_error=$5,
        ready_boot_id=CASE WHEN $4='ready' THEN $2::uuid ELSE NULL END WHERE workspace_id=$1`, [row.id, boot, report.sequence, report.state, report.errorCode ?? null]);
      if (report.state === "ready") {
        await tx.query(`UPDATE cloud_v2_workspaces SET state='running',attempts=0,next_attempt_at=NULL,
          active_at=CASE WHEN state='running' THEN active_at ELSE clock_timestamp() END,
          updated_at=CASE WHEN state='running' THEN updated_at ELSE clock_timestamp() END WHERE id=$1`, [row.id]);
        if (row.state !== "running") await notifyCloudV2WorkerReady(tx, row.id);
      } else {
        await tx.query(`UPDATE cloud_v2_workspaces SET state='failed',error_code=$2,access_epoch=access_epoch+1,worker_route_url=NULL,worker_port_token=NULL,
          attempts=0,next_attempt_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [row.id, report.errorCode]);
      }
    });
  }
}
