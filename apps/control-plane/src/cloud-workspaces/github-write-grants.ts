import { devConnectionRuntime } from "../dev-connections/runtime.js";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type pg from "pg";
import { assertNativeGithubActor } from "./github-native-grants.js";
import { cloudGithubNativePreparationSchema, type CloudGithubNativePreparation, type CloudGithubNativeSource } from "./github-native-schema.js";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { readGithubGitAuthor } from "../github-git-author.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { assertCloudActorSession, type CloudActorEngineScope } from "./actor-sessions.js";
import { assertCurrentCloudEngineAuthority, assertCloudEngineIdentityForIdempotentReplay, assertCloudEngineAuthorityDeadline } from "./engine-authority.js";

export const githubWriteOperation = z.enum(["git.fetch", "git.push", "gh.prCreate", "gh.prUpdate", "gh.prMarkReady", "gh.prMerge", "gh.prComment"]);
export const githubWritePreparation = z.object({
  action: z.literal("prepareWrite"), organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  native: cloudGithubNativePreparationSchema.optional(),
  operation: githubWriteOperation, paramsSha256: z.string().regex(/^[a-f0-9]{64}$/), prNumber: z.number().int().positive().max(2147483647).optional(),
}).strict();
type Preparation = z.infer<typeof githubWritePreparation>;
type Snapshot = { generation: number; owner: string; repository: string; repositoryId: string; installationId: string; actorFingerprint: string; githubFingerprint: string };
export type GithubProxyAuthority = {
  owner: string; repository: string; repositoryId: string; operation: string; prNumber: number | null;
  userToken: string; expiresAtMs: number; expectedBody: Record<string, unknown> | null; gitReference: string | null;
};
type Receipt = {
  native_request: CloudGithubNativePreparation | null;
  grant_hash: Buffer; proxy_hash: Buffer | null; workspace_id: string; org_id: string; generation: number; actor_user_id: string;
  actor_fingerprint: string; github_fingerprint: string; operation: string; params_sha256: string; pr_number: number | null;
  repository_id: string; repository_owner: string; repository_name: string; token_sealed: Buffer;
  admission_expires_at: Date; lease_expires_at: Date; engine_instance_id: string | null; actor_session_id: string | null;
  expected_body: Record<string, unknown> | null; git_reference: string | null; api_write_started: boolean; git_write_started: boolean;
};
const hash = (value: string) => createHash("sha256").update(value).digest();
const denied = () => new HttpError(403, "github_cloud_write_denied", "GitHub write authorization is unavailable. Reconnect GitHub and try again.");
const grantSchema = z.string().regex(/^zgw_[A-Za-z0-9_-]{43}$/);
const proxySchema = z.string().regex(/^zgp_[A-Za-z0-9_-]{43}$/);
function matchesSnapshot(row: Receipt, snapshot: Snapshot): boolean {
  return row.generation === snapshot.generation && row.actor_fingerprint === snapshot.actorFingerprint &&
    row.github_fingerprint === snapshot.githubFingerprint && row.repository_id === snapshot.repositoryId &&
    row.repository_owner === snapshot.owner && row.repository_name === snapshot.repository;
}
function key(secret: string) { return Buffer.from(hkdfSync("sha256", secret, "zeros-github-user-write", "sealed-user-token-v1", 32)); }
// Store the tag before ciphertext. A separate helper keeps the capability-derived
// encryption key out of durable server configuration and database snapshots.
function sealed(token: string, secret: string, aad: Buffer): Buffer {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(aad); const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function open(row: Receipt, secret: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key(secret), row.token_sealed.subarray(0, 12));
  decipher.setAAD(row.grant_hash); decipher.setAuthTag(row.token_sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(row.token_sealed.subarray(28)), decipher.final()]).toString("utf8");
}
const ref = z.string().min(1).max(512).refine(value => !/[\s\0~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock")));
export const githubWriteRedemption = z.object({
  grant: grantSchema, operation: githubWriteOperation, paramsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  params: z.record(z.unknown()), branch: ref, baseBranch: ref,
});
function expectedBody(input: z.infer<typeof githubWriteRedemption>): Record<string, unknown> | null {
  const p = input.params, text = z.string().max(131072), title = z.string().min(1).max(1024);
  switch (input.operation) {
    case "git.fetch":
    case "git.push": return null;
    case "gh.prCreate": return { title: title.parse(p.title), body: text.parse(p.body), draft: z.boolean().default(true).parse(p.draft), head: input.branch, base: input.baseBranch };
    case "gh.prUpdate": return { ...(p.title !== undefined ? { title: title.parse(p.title) } : {}), ...(p.body !== undefined ? { body: text.parse(p.body) } : {}) };
    case "gh.prComment": return { body: text.min(1).parse(p.body) };
    case "gh.prMerge": return { merge_method: z.enum(["squash", "merge", "rebase"]).parse(p.method), ...(p.commitTitle !== undefined ? { commit_title: title.parse(p.commitTitle) } : {}), ...(p.commitMessage !== undefined ? { commit_message: text.parse(p.commitMessage) } : {}) };
    case "gh.prMarkReady": return null;
  }
}

/** On-behalf-of-user writes use GitHub's user identity, never an installation's
 * potentially broader privileges. Only a repository/action proxy capability
 * leaves the backend. It is tied to one live engine and actor session. */
export class DatabaseCloudGithubWriteGrants {
  constructor(private readonly pool: pg.Pool, private readonly workosEnabled: boolean) {}
  async nativeContext(scope: CloudActorEngineScope, source?: CloudGithubNativeSource) {
    return withSystemTx(this.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.workosEnabled });
      if (!source) return { nativeGit: 1 };
      const actor = await assertNativeGithubActor(tx, scope, source, this.workosEnabled);
      const snapshot = await this.snapshot(tx, { action: "prepareWrite", organizationId: scope.organizationId,
        workspaceId: scope.workspaceId, operation: "git.push", paramsSha256: "0".repeat(64) }, actor.actorUserId);
      return { actorUserId: actor.actorUserId, organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        generation: scope.generation, engineInstanceId: scope.engineInstanceId, owner: snapshot.owner,
        repository: snapshot.repository, repositoryId: snapshot.repositoryId };
    });
  }
  async gitAuthor(scope: CloudActorEngineScope & { actorSessionId: string }) {
    return withSystemTx(this.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.workosEnabled });
      const actor = await assertCloudActorSession(tx, scope, scope.actorSessionId, "edit");
      return { author: await readGithubGitAuthor(tx, actor.actorUserId) };
    });
  }
  async snapshot(tx: Tx, input: Preparation, actorUserId: string): Promise<Snapshot> {
    await tx.query("SELECT id FROM organizations WHERE id=$1 FOR SHARE", [input.organizationId]);
    await tx.query("SELECT id FROM cloud_workspaces WHERE id=$1 AND org_id=$2 FOR UPDATE", [input.workspaceId, input.organizationId]);
    const actor = await authorizeCloudWorkspaceActor(tx, { ...input, actorUserId, capability: "edit" });
    const row = (await tx.query<Omit<Snapshot, "actorFingerprint" | "installationId">>(`SELECT workspace.current_generation AS generation,
      workspace.repository_owner AS owner,workspace.repository_name AS repository,repo.forge_repository_id AS "repositoryId",
      cloud_github_actor_fingerprint(workspace.org_id,$3) AS "githubFingerprint"
      FROM cloud_workspaces workspace JOIN repositories repo ON repo.id=workspace.repository_id AND repo.org_id=workspace.org_id
      WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.repository_forge='github.com'
        AND workspace.status IN ('ready','busy') AND workspace.desired_state='running' AND workspace.deleted_at IS NULL`,
    [input.workspaceId, input.organizationId, actorUserId])).rows[0];
    if (!row?.githubFingerprint || !/^[1-9][0-9]*$/.test(row.repositoryId)) throw denied();
    if (input.native) {
      if (!["git.push", "git.fetch"].includes(input.operation) || input.prNumber || row.generation !== input.native.generation ||
          (input.operation === "git.push" && !ref.safeParse(input.native.branch).success) ||
          hash(JSON.stringify([input.operation, { nativeRequestId: input.native.requestId }])).toString("hex") !== input.paramsSha256) throw denied();
      const nativeActor = await assertNativeGithubActor(tx, { ...input, generation: input.native.generation,
        engineInstanceId: input.native.engineInstanceId }, input.native.source, this.workosEnabled);
      if (nativeActor.actorUserId !== actorUserId || nativeActor.fingerprint !== actor.fingerprint) throw denied();
    } else if (input.operation === "git.fetch") throw denied();
    await devConnectionRuntime(this.pool)?.assertGithub(tx,actorUserId,input.organizationId);
    // Hold the selected connection through the final grant insert/use. A
    // disconnect either wins this check or waits, then deletes the grant.
    const connections = (await tx.query<{ id: string; revision: string; installationId: string; owner: string; accountType: string }>(`
      SELECT connection.installation_id AS id,connection.authority_revision AS revision,
        installation.github_installation_id::text AS "installationId",lower(installation.account_login) AS owner,
        installation.account_type AS "accountType"
      FROM cloud_github_connections connection JOIN github_installations installation ON installation.id=connection.installation_id
      WHERE connection.org_id=$1 AND connection.owner_user_id=$2 AND installation.owner_user_id=$2
        AND installation.app_variant='github.com' AND lower(installation.account_login)=lower($3) AND installation.suspended_at IS NULL
      LIMIT 2 FOR SHARE OF connection,installation`, [input.organizationId, actorUserId, row.owner])).rows;
    const connection = connections[0];
    if (connections.length !== 1 || !connection) throw denied();
    return { ...row, installationId: connection.installationId, actorFingerprint: actor.fingerprint,
      githubFingerprint: hash(JSON.stringify([row.githubFingerprint, connection])).toString("hex") };
  }
  private receiptSnapshot(tx: Tx, row: Receipt): Promise<Snapshot> {
    return this.snapshot(tx, { action: "prepareWrite", organizationId: row.org_id, workspaceId: row.workspace_id,
      operation: githubWriteOperation.parse(row.operation), paramsSha256: row.params_sha256,
      ...(row.native_request ? { native: cloudGithubNativePreparationSchema.parse(row.native_request) } : {}),
      ...(row.pr_number !== null ? { prNumber: row.pr_number } : {}) }, row.actor_user_id);
  }
  async prepare(input: Preparation, actorUserId: string, verify: (snapshot: Snapshot) => Promise<{ repositoryId: string; installationId: number | string }>, userAccessToken: string) {
    input = githubWritePreparation.parse(input);
    if (!z.string().min(1).max(4096).regex(/^[^\s\0]+$/).safeParse(userAccessToken).success ||
        (!["git.push", "git.fetch", "gh.prCreate"].includes(input.operation) && !input.prNumber)) throw denied();
    const snapshot = await withSystemTx(this.pool, tx => this.snapshot(tx, input, actorUserId));
    const verified = await verify(snapshot);
    if (verified.repositoryId !== snapshot.repositoryId || String(verified.installationId) !== snapshot.installationId) throw denied();
    const grant = `zgw_${randomBytes(32).toString("base64url")}`, grantHash = hash(grant);
    await withSystemTx(this.pool, async tx => {
      if (JSON.stringify(await this.snapshot(tx, input, actorUserId)) !== JSON.stringify(snapshot)) throw denied();
      const count = await tx.query<{ count: string }>("SELECT count(*) FROM cloud_github_write_grants WHERE actor_user_id=$1 AND lease_expires_at>clock_timestamp()", [actorUserId]);
      if (Number(count.rows[0]?.count) >= 16) throw new HttpError(429, "github_write_limit", "Too many GitHub writes are pending. Try again shortly.");
      await tx.query(`INSERT INTO cloud_github_write_grants(grant_hash,workspace_id,org_id,generation,actor_user_id,actor_fingerprint,github_fingerprint,
        operation,params_sha256,pr_number,repository_id,repository_owner,repository_name,token_sealed,admission_expires_at,lease_expires_at,native_request)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+CASE WHEN $15::jsonb IS NULL THEN interval '2 minutes' ELSE interval '60 seconds' END,clock_timestamp()+CASE WHEN $15::jsonb IS NULL THEN interval '2 minutes' ELSE interval '60 seconds' END,$15)`,
      [grantHash, input.workspaceId, input.organizationId, snapshot.generation, actorUserId, snapshot.actorFingerprint, snapshot.githubFingerprint,
        input.operation, input.paramsSha256, input.prNumber ?? null, snapshot.repositoryId, snapshot.owner, snapshot.repository, sealed(userAccessToken, grant, grantHash), input.native ? JSON.stringify(input.native) : null]);
    });
    return { grant };
  }
  async redeem(scope: CloudActorEngineScope & { actorSessionId: string }, value: z.infer<typeof githubWriteRedemption>) {
    const dev=devConnectionRuntime(this.pool);if(dev)await dev.consumeInvalidations();
    const request = githubWriteRedemption.parse(value);
    if (hash(JSON.stringify([request.operation, request.params])).toString("hex") !== request.paramsSha256) throw denied();
    const body = expectedBody(request);
    return withSystemTx(this.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.workosEnabled });
      const actor = await assertCloudActorSession(tx, scope, scope.actorSessionId, "edit");
      await dev?.assertGithub(tx,actor.actorUserId,scope.organizationId);
      const receiptQuery = `SELECT * FROM cloud_github_write_grants WHERE grant_hash=$1 AND workspace_id=$2 AND org_id=$3
        AND generation=$4 AND actor_user_id=$5 AND engine_instance_id IS NULL AND admission_expires_at>clock_timestamp()`;
      const receiptParams = [hash(request.grant), scope.workspaceId, scope.organizationId, scope.generation, actor.actorUserId];
      const seed = (await tx.query<Receipt>(receiptQuery, receiptParams)).rows[0];
      if (!seed) throw denied();
      // Connection before grant is also the disconnect trigger's lock order.
      const snapshot = await this.receiptSnapshot(tx, seed);
      const row = (await tx.query<Receipt>(`${receiptQuery} FOR UPDATE`, receiptParams)).rows[0];
      if (!row || !matchesSnapshot(row, snapshot) || row.actor_fingerprint !== actor.fingerprint || row.operation !== request.operation ||
          row.params_sha256 !== request.paramsSha256 || row.pr_number !== (request.params.prNumber ?? null)) throw denied();
      if (row.native_request) {
        const native = cloudGithubNativePreparationSchema.parse(row.native_request);
        if (native.engineInstanceId !== scope.engineInstanceId || native.generation !== scope.generation ||
            request.branch !== (native.branch ?? "HEAD") || request.params.nativeRequestId !== native.requestId) throw denied();
      }
      const proxy = `zgp_${randomBytes(32).toString("base64url")}`;
      const result = await tx.query<{ lease_expires_at: Date }>(`UPDATE cloud_github_write_grants SET engine_instance_id=$2,actor_session_id=$3,claimed_at=clock_timestamp(),
        proxy_hash=$4,token_sealed=$5,expected_body=$6,git_reference=$7,lease_expires_at=clock_timestamp()+CASE WHEN native_request IS NULL THEN interval '3 minutes' ELSE interval '60 seconds' END
        WHERE grant_hash=$1 RETURNING lease_expires_at`,
      [row.grant_hash, scope.engineInstanceId, scope.actorSessionId, hash(proxy), sealed(open(row, request.grant), proxy, row.grant_hash),
        body === null ? null : JSON.stringify(body), `refs/heads/${request.branch}`]);
      await assertCloudActorSession(tx, scope, scope.actorSessionId, "edit");
      await assertCloudEngineAuthorityDeadline(tx, scope.engineInstanceId, this.workosEnabled);
      return { token: proxy, owner: row.repository_owner, repository: row.repository_name, expiresAtMs: result.rows[0]!.lease_expires_at.getTime() };
    });
  }
  /** Backend-only. The returned user token must never become an HTTP response. */
  async authorizeProxy(proxy: string, write: "api" | "git" | null = null): Promise<GithubProxyAuthority> {
    if (!proxySchema.safeParse(proxy).success) throw denied();
    const dev=devConnectionRuntime(this.pool);if(dev)await dev.consumeInvalidations();
    return withSystemTx(this.pool, async tx => {
      const seed = (await tx.query<Receipt>("SELECT * FROM cloud_github_write_grants WHERE proxy_hash=$1 AND lease_expires_at>clock_timestamp()", [hash(proxy)])).rows[0];
      if (!seed?.engine_instance_id || !seed.actor_session_id) throw denied();
      // Same parent/engine locks and revocation fence as a heartbeat-authorized
      // request. Here the scoped capability supplies the delegated identity.
      const authority = (await tx.query<{ live: boolean; fenced: boolean }>("SELECT live,fenced FROM cloud_workspace_engine_authority_current($1,$2,$3,$4,$5,true)",
        [seed.workspace_id, seed.org_id, seed.generation, seed.engine_instance_id, this.workosEnabled])).rows[0];
      if (!authority?.live || authority.fenced) throw denied();
      const scope = { workspaceId: seed.workspace_id, organizationId: seed.org_id, generation: seed.generation, engineInstanceId: seed.engine_instance_id };
      const actor = await assertCloudActorSession(tx, scope, seed.actor_session_id, "edit");
      await dev?.assertGithub(tx,actor.actorUserId,scope.organizationId);
      const snapshot = await this.receiptSnapshot(tx, seed);
      const row = (await tx.query<Receipt>(`SELECT * FROM cloud_github_write_grants WHERE proxy_hash=$1 AND lease_expires_at>clock_timestamp() FOR UPDATE`, [hash(proxy)])).rows[0];
      if (!row || !matchesSnapshot(row, snapshot) || actor.actorUserId !== row.actor_user_id || actor.fingerprint !== row.actor_fingerprint ||
          (write === "api" && row.api_write_started) || (write === "git" && row.git_write_started)) throw denied();
      if (row.native_request && write === "api") throw denied();
      if (write) await tx.query(`UPDATE cloud_github_write_grants SET ${write === "api" ? "api_write_started" : "git_write_started"}=true WHERE grant_hash=$1`, [row.grant_hash]);
      await assertCloudEngineAuthorityDeadline(tx, seed.engine_instance_id, this.workosEnabled);
      return { owner: row.repository_owner, repository: row.repository_name, repositoryId: row.repository_id, operation: row.operation,
        prNumber: row.pr_number, userToken: open(row, proxy), expiresAtMs: row.lease_expires_at.getTime(), expectedBody: row.expected_body, gitReference: row.git_reference };
    });
  }
  async allowDraftFallback(proxy: string): Promise<void> {
    // Only the definite 422 draft-unsupported response can retry, once, and
    // only with the identical body except draft=false. Unknown outcomes do not.
    await withSystemTx(this.pool, tx => tx.query(`UPDATE cloud_github_write_grants SET api_write_started=false,
      expected_body=jsonb_set(expected_body,'{draft}','false'::jsonb) WHERE proxy_hash=$1 AND operation='gh.prCreate'
      AND expected_body->'draft'='true'::jsonb AND api_write_started`, [hash(proxy)]));
  }
  async release(scope: CloudActorEngineScope, grant: string): Promise<void> {
    if (!grantSchema.safeParse(grant).success) throw denied();
    await withSystemTx(this.pool, async tx => {
      await assertCloudEngineIdentityForIdempotentReplay(tx, scope);
      await tx.query(`DELETE FROM cloud_github_write_grants WHERE grant_hash=$1 AND workspace_id=$2 AND org_id=$3 AND generation=$4 AND (engine_instance_id=$5 OR (engine_instance_id IS NULL AND native_request->>'engineInstanceId'=$5::text))`,
        [hash(grant), scope.workspaceId, scope.organizationId, scope.generation, scope.engineInstanceId]);
    });
  }
  async cleanup(): Promise<void> {
    await withSystemTx(this.pool, tx => tx.query("DELETE FROM cloud_github_write_grants WHERE lease_expires_at<=clock_timestamp()"));
  }
}
