import { createHash, randomBytes, randomUUID } from "node:crypto";
import { auth, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { openMcpMaterial, sealMcpMaterial, type McpEnvelope } from "./envelope.js";
import { McpOAuthProvider, MCP_CALLBACK_PATH, MCP_CLIENT_PATH, type OAuthMaterial } from "./oauth-provider.js";
import { mcpPublicUrl, safeMcpFetch, withMcpSignal } from "./safe-fetch.js";
import { McpStore, mcpConflict, mcpNotFound, uuid, type McpRow } from "./store.js";
import type { McpConfig, McpSecrets } from "./model.js";

interface Attempt {
  id: string; org_id: string; owner_user_id: string; extension_id: string | null; expected_revision: number | null;
  binding: string; status: "preparing" | "pending" | "exchanging" | "connected" | "failed" | "cancelled" | "used";
  envelope: McpEnvelope; expires_at: Date;
}
interface AttemptMaterial { config: McpConfig; secrets: McpSecrets; material: OAuthMaterial; state: string }
interface Grant { extension_id: string; org_id: string; owner_user_id: string; binding: string; revision: number; envelope: McpEnvelope; refresh_claim: string | null; refresh_started_at: Date | null }
export interface McpAuthorization { headers: Record<string, string>; expiresAt?: number }
const stateHash = (state: string) => createHash("sha256").update(state).digest();
const authRequired = () => new HttpError(409, "mcp_auth_required", "Sign in to this MCP server");
const authBusy = () => new HttpError(503, "mcp_auth_busy", "MCP sign-in is already updating. Try again shortly.");
const failed = () => new HttpError(422, "mcp_oauth_failed", "MCP sign-in could not complete. Check the client configuration and try again.");

/** Durable OAuth attempts survive API replica changes. No timer or refresh
 * loop runs while idle; refresh happens only on an admitted runtime request. */
export class McpOAuth {
  private readonly refreshes = new Map<string, { force: boolean; promise: Promise<McpAuthorization> }>();
  constructor(private readonly store: McpStore, readonly origin: string, private readonly fetchImpl: FetchLike = safeMcpFetch,
    private readonly authenticate: typeof auth = auth) {
    store.attachOAuth = (tx, org, user, attempt, row) => this.attach(tx, org, user, attempt, row);
  }
  private attemptBinding(row: Attempt) {
    return { organizationId: row.org_id, ownerUserId: row.owner_user_id, id: row.id, revision: 1, purpose: "attempt" as const };
  }
  private grantBinding(row: Grant) {
    return { organizationId: row.org_id, ownerUserId: row.owner_user_id, id: row.extension_id, revision: row.revision, purpose: "oauth" as const };
  }
  private provider(material: AttemptMaterial): McpOAuthProvider {
    return new McpOAuthProvider({ config: material.config, material: material.material, state: material.state,
      callback: new URL(MCP_CALLBACK_PATH, this.origin).href, identity: new URL(MCP_CLIENT_PATH, this.origin).href,
      ...(material.secrets.oauthClientSecret ? { clientSecret: material.secrets.oauthClientSecret } : {}) });
  }
  private async challenge(config: Exclude<McpConfig, { transport: "stdio" }>, fetchFn: FetchLike, signal: AbortSignal) {
    let challenge: ReturnType<typeof extractWWWAuthenticateParams> = {};
    const origin = new URL(config.url).origin, client = new McpClient({ name: "zeros-sign-in", version: "1.0.0" });
    const resourceFetch: FetchLike = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw failed();
      const response = await withMcpSignal(Promise.resolve(fetchFn(input, init)), signal);
      if (response.status === 401 || response.status === 403) {
        challenge = extractWWWAuthenticateParams(response);
        await withMcpSignal(response.body?.cancel() ?? Promise.resolve(), signal);
      }
      return response;
    };
    const transport = config.transport === "sse" ? new SSEClientTransport(new URL(config.url), { fetch: resourceFetch })
      : new StreamableHTTPClientTransport(new URL(config.url), { fetch: resourceFetch });
    try {
      // The real transport covers HTTP initialize and legacy SSE's advertised
      // POST endpoint. A GET-only check misses servers that challenge POST.
      await withMcpSignal(client.connect(transport as Transport, { signal, timeout: 30_000 }), signal);
    } catch {
      // Unsupported/unauthenticated transport responses can still use normal
      // well-known discovery. Cancellation cannot start another request.
      signal.throwIfAborted();
    } finally {
      if (!signal.aborted && transport instanceof StreamableHTTPClientTransport)
        await withMcpSignal(transport.terminateSession(), signal).catch(() => {});
      await client.close().catch(() => {});
    }
    return challenge;
  }
  private async run(provider: McpOAuthProvider, config: McpConfig, code?: string, signal?: AbortSignal): Promise<void> {
    if (config.transport === "stdio" || config.auth !== "oauth") throw failed();
    mcpPublicUrl(config.url);
    const timeout = AbortSignal.timeout(30_000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const fetchFn: FetchLike = (input, init) => {
      combined.throwIfAborted();
      const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      requestSignal?.throwIfAborted();
      return this.fetchImpl(input, { ...init, signal: requestSignal ? AbortSignal.any([combined, requestSignal]) : combined });
    };
    const challenge = !code && !provider.discoveryState()?.authorizationServerUrl ? await this.challenge(config, fetchFn, combined) : {};
    const resourceMetadataUrl = challenge.resourceMetadataUrl ? mcpPublicUrl(challenge.resourceMetadataUrl) : undefined;
    const scope = challenge.scope ?? config.oauth_scopes?.join(" ");
    combined.throwIfAborted();
    await this.authenticate(provider, { serverUrl: config.url, fetchFn,
      ...(code ? { authorizationCode: code } : {}), ...(scope ? { scope } : {}), ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}) });
    combined.throwIfAborted();
  }
  async start(organizationId: string, userId: string, raw: unknown, signal?: AbortSignal) {
    const draft = await this.store.draft(organizationId, userId, raw);
    if (draft.config.transport === "stdio" || draft.config.auth !== "oauth") throw failed();
    mcpPublicUrl(draft.config.url);
    const id = randomUUID(), state = randomBytes(32).toString("base64url");
    const material: AttemptMaterial = { config: draft.config, secrets: draft.secrets, material: {}, state };
    const attempt = await withSystemTx(this.store.pool, async tx => {
      await this.store.mutation(tx, organizationId, userId);
      await tx.query("/* lock_purpose='mcp-authorization-start' */ SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`mcp-auth:${organizationId}:${userId}`]);
      await tx.query("DELETE FROM organization_mcp_oauth_attempts WHERE org_id=$1 AND owner_user_id=$2 AND expires_at<=clock_timestamp()", [organizationId, userId]);
      const count = await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM organization_mcp_oauth_attempts WHERE org_id=$1 AND owner_user_id=$2", [organizationId, userId]);
      if (count.rows[0]!.count >= 10) throw new HttpError(429, "mcp_auth_limit", "Too many sign-in attempts. Finish or cancel an existing attempt.");
      if (draft.input.extensionId && (await this.store.read(tx, organizationId, userId, draft.input.extensionId)).revision !== draft.input.expectedRevision) throw mcpConflict();
      const envelope = sealMcpMaterial(material, { organizationId, ownerUserId: userId, id, revision: 1, purpose: "attempt" }, this.store.keys);
      return (await tx.query<Attempt>(`INSERT INTO organization_mcp_oauth_attempts(id,org_id,owner_user_id,extension_id,expected_revision,binding,state_hash,status,envelope,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'preparing',$8,clock_timestamp()+interval '10 minutes') RETURNING *`,
      [id, organizationId, userId, draft.input.extensionId ?? null, draft.input.expectedRevision ?? null, draft.binding, stateHash(state), envelope])).rows[0]!;
    });
    const provider = this.provider(material);
    try {
      await this.run(provider, draft.config, undefined, signal);
      if (!provider.authorizationUrl) throw failed();
      const envelope = sealMcpMaterial({ ...material, material: provider.material }, this.attemptBinding(attempt), this.store.keys);
      await withSystemTx(this.store.pool, async tx => {
        await this.store.mutation(tx, organizationId, userId);
        const result = await tx.query("UPDATE organization_mcp_oauth_attempts SET status='pending',envelope=$2 WHERE id=$1 AND status='preparing' AND expires_at>clock_timestamp()", [id, envelope]);
        if (!result.rowCount) throw failed();
      });
      return { attemptId: id, authorizationUrl: provider.authorizationUrl, redirectUrl: provider.redirectUrl, expiresAt: attempt.expires_at.getTime() };
    } catch {
      await this.failAttempt(id);
      throw failed();
    }
  }
  async status(organizationId: string, userId: string, id: string) {
    return withSystemTx(this.store.pool, async tx => {
      await this.store.member(tx, organizationId, userId);
      const attempt = (await tx.query<Attempt>("SELECT * FROM organization_mcp_oauth_attempts WHERE id=$1 AND org_id=$2 AND owner_user_id=$3", [uuid(id), organizationId, userId])).rows[0];
      if (!attempt) throw mcpNotFound();
      return { status: attempt.status === "connected" && attempt.expires_at.getTime() > Date.now() ? "connected" as const
        : ["preparing", "pending", "exchanging"].includes(attempt.status) && attempt.expires_at.getTime() > Date.now() ? "pending" as const : "failed" as const };
    });
  }
  async cancel(organizationId: string, userId: string, id: string): Promise<void> {
    await withSystemTx(this.store.pool, async tx => {
      await this.store.mutation(tx, organizationId, userId);
      // Delete both drops material and fences a callback/refresh already in flight.
      await tx.query("DELETE FROM organization_mcp_oauth_attempts WHERE id=$1 AND org_id=$2 AND owner_user_id=$3", [uuid(id), organizationId, userId]);
    });
  }
  async callback(state: string, code: string, issuer?: string, error?: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || code.length > 4096) throw failed();
    const attempt = await withSystemTx(this.store.pool, async tx => {
      const observed = (await tx.query<Attempt>("SELECT * FROM organization_mcp_oauth_attempts WHERE state_hash=$1", [stateHash(state)])).rows[0];
      if (!observed) throw failed();
      await this.store.mutation(tx, observed.org_id, observed.owner_user_id);
      const row = (await tx.query<Attempt>("SELECT * FROM organization_mcp_oauth_attempts WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE", [observed.id])).rows[0];
      if (!row) throw failed();
      if (row.extension_id && (await this.store.read(tx, row.org_id, row.owner_user_id, row.extension_id)).revision !== row.expected_revision) throw mcpConflict();
      await tx.query("UPDATE organization_mcp_oauth_attempts SET status='exchanging' WHERE id=$1", [row.id]);
      return row;
    });
    try {
      // Claim only a live pending attempt before consuming denial. Late or
      // replayed callbacks cannot fail an exchange that already owns it.
      if (!code || error !== undefined) throw failed();
      const material = openMcpMaterial(attempt.envelope, this.attemptBinding(attempt), this.store.keys) as AttemptMaterial;
      if (issuer && new URL(issuer).href !== new URL(material.material.discovery?.authorizationServerUrl ?? "").href) throw failed();
      const provider = this.provider(material);
      await this.run(provider, material.config, code);
      if (!provider.material.tokens?.access_token) throw failed();
      delete provider.material.verifier;
      await withSystemTx(this.store.pool, async tx => {
        await this.store.mutation(tx, attempt.org_id, attempt.owner_user_id);
        const current = (await tx.query<Attempt>("SELECT * FROM organization_mcp_oauth_attempts WHERE id=$1 AND status='exchanging' AND expires_at>clock_timestamp() FOR UPDATE", [attempt.id])).rows[0];
        if (!current) throw failed();
        if (current.extension_id) {
          const server = await this.store.read(tx, current.org_id, current.owner_user_id, current.extension_id, true);
          if (server.revision !== current.expected_revision || server.oauth_binding !== current.binding) throw mcpConflict();
          await this.saveGrant(tx, server, current.owner_user_id, provider.material);
        }
        const envelope = sealMcpMaterial({ ...material, material: provider.material }, this.attemptBinding(attempt), this.store.keys);
        await tx.query("UPDATE organization_mcp_oauth_attempts SET status='connected',envelope=$2 WHERE id=$1", [attempt.id, envelope]);
      });
    } catch {
      await this.failAttempt(attempt.id);
      throw failed();
    }
  }
  private async failAttempt(id: string): Promise<void> {
    await withSystemTx(this.store.pool, tx => tx.query("UPDATE organization_mcp_oauth_attempts SET status='failed',envelope='{}' WHERE id=$1 AND status IN ('preparing','pending','exchanging')", [id])).catch(() => {});
  }
  private async saveGrant(tx: Tx, row: McpRow, userId: string, material: OAuthMaterial): Promise<void> {
    if (!material.tokens?.access_token || /[\r\n\0]/.test(material.tokens.access_token) ||
      material.tokens.access_token.length > 16384 || material.tokens.token_type.toLowerCase() !== "bearer") throw failed();
    const old = (await tx.query<Grant>("SELECT * FROM organization_mcp_oauth WHERE extension_id=$1 AND owner_user_id=$2 FOR UPDATE", [row.id, userId])).rows[0];
    const revision = (old?.revision ?? 0) + 1;
    const envelope = sealMcpMaterial(material, { organizationId: row.org_id, ownerUserId: userId, id: row.id, revision, purpose: "oauth" }, this.store.keys);
    await tx.query(`INSERT INTO organization_mcp_oauth(extension_id,owner_user_id,org_id,binding,revision,envelope,access_expires_at,refreshable)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(extension_id,owner_user_id) DO UPDATE SET binding=excluded.binding,revision=excluded.revision,
      envelope=excluded.envelope,access_expires_at=excluded.access_expires_at,refreshable=excluded.refreshable,
      sign_in_revision=organization_mcp_oauth.sign_in_revision+1,refresh_claim=NULL,refresh_started_at=NULL`,
    [row.id, userId, row.org_id, row.oauth_binding, revision, envelope, material.expiresAt === undefined ? null : new Date(material.expiresAt), !!material.tokens.refresh_token]);
  }
  private async attach(tx: Tx, org: string, user: string, id: string, row: McpRow): Promise<void> {
    const attempt = (await tx.query<Attempt>(`SELECT * FROM organization_mcp_oauth_attempts
      WHERE id=$1 AND org_id=$2 AND owner_user_id=$3 AND status='connected' AND expires_at>clock_timestamp() FOR UPDATE`, [uuid(id), org, user])).rows[0];
    if (!attempt || attempt.binding !== row.oauth_binding || (attempt.extension_id && attempt.extension_id !== row.id)) throw failed();
    const material = openMcpMaterial(attempt.envelope, this.attemptBinding(attempt), this.store.keys) as AttemptMaterial;
    await this.saveGrant(tx, row, user, material.material);
    await tx.query("UPDATE organization_mcp_oauth_attempts SET status='used',envelope='{}' WHERE id=$1", [id]);
  }

  /** An explicit unsaved probe can consume the connected draft's access token
   * without saving an extension, exposing refresh material, or mutating it. */
  async draftAuthorization(org: string, user: string, id: string, binding: string): Promise<McpAuthorization> {
    return withSystemTx(this.store.pool, async tx => {
      await this.store.member(tx, org, user);
      const attempt = (await tx.query<Attempt>(`SELECT * FROM organization_mcp_oauth_attempts
        WHERE id=$1 AND org_id=$2 AND owner_user_id=$3 AND status='connected' AND expires_at>clock_timestamp()`, [uuid(id), org, user])).rows[0];
      if (!attempt || attempt.binding !== binding) throw authRequired();
      const { material } = openMcpMaterial(attempt.envelope, this.attemptBinding(attempt), this.store.keys) as AttemptMaterial;
      if (material.expiresAt !== undefined && material.expiresAt <= Date.now() + 5000) throw authRequired();
      const tokens = material.tokens;
      if (!tokens?.access_token || /[\r\n\0]/.test(tokens.access_token) || tokens.access_token.length > 16384 || tokens.token_type.toLowerCase() !== "bearer") throw authRequired();
      return { headers: { Authorization: `Bearer ${tokens.access_token}` }, ...(material.expiresAt === undefined ? {} : { expiresAt: material.expiresAt }) };
    });
  }

  async authorization(org: string, user: string, id: string, force = false): Promise<McpAuthorization> {
    const key = `${uuid(org)}:${uuid(user)}:${uuid(id)}`;
    const active = this.refreshes.get(key);
    if (active) {
      // A 401 must not join a simultaneous cached read and return the token
      // that was just rejected. Join an actual refresh, or refresh after read.
      if (force && !active.force) { await active.promise; return this.authorization(org, user, id, true); }
      return active.promise;
    }
    if (this.refreshes.size >= 128) throw authBusy();
    const flight = this.authorize(org, user, id, force).finally(() => { if (this.refreshes.get(key)?.promise === flight) this.refreshes.delete(key); });
    this.refreshes.set(key, { force, promise: flight });
    return flight;
  }
  async authorizationForRepository(org: string, user: string, repository: string, id: string, force = false,
    admittedWorkspace?: Parameters<McpStore["resolve"]>[3]): Promise<McpAuthorization> {
    id = uuid(id);
    const selected = async () => {
      if (!(await this.store.resolve(org, user, repository, admittedWorkspace)).some(server => server.id === id)) throw mcpNotFound();
    };
    await selected();
    const result = await this.authorization(org, user, id, force);
    await selected();
    return result;
  }
  private async authorize(org: string, user: string, id: string, force: boolean): Promise<McpAuthorization> {
    const row = await this.store.get(org, user, id), runtime = this.store.runtime(row);
    if (runtime.transport === "stdio") throw mcpNotFound();
    if (runtime.auth !== "oauth") return { headers: runtime.headers ?? {} };
    const claim = randomUUID();
    const state = await withSystemTx(this.store.pool, async tx => {
      await this.store.member(tx, org, user);
      const grant = (await tx.query<Grant>("SELECT * FROM organization_mcp_oauth WHERE extension_id=$1 AND owner_user_id=$2 AND org_id=$3 AND binding=$4", [id, user, org, row.oauth_binding])).rows[0];
      if (!grant) throw authRequired();
      const material = openMcpMaterial(grant.envelope, this.grantBinding(grant), this.store.keys) as OAuthMaterial;
      const usable = !force && material.tokens?.access_token && (material.expiresAt === undefined || material.expiresAt > Date.now() + 60_000);
      if (usable && !grant.refresh_claim) return { grant, material, refresh: false };
      if (grant.refresh_claim) {
        // An expired claim is ambiguous provider spend, never permission to
        // replay a rotating refresh token. Require a fresh sign-in.
        if (grant.refresh_started_at && grant.refresh_started_at.getTime() < Date.now() - 60_000) throw authRequired();
        throw authBusy();
      }
      if (!material.tokens?.refresh_token) throw authRequired();
      await this.store.mutation(tx, org, user);
      const current = await this.store.read(tx, org, user, id);
      if (current.revision !== row.revision || current.oauth_binding !== row.oauth_binding) throw mcpConflict();
      const claimed = await tx.query(`UPDATE organization_mcp_oauth SET refresh_claim=$3,refresh_started_at=clock_timestamp()
        WHERE extension_id=$1 AND owner_user_id=$2 AND revision=$4 AND binding=$5 AND refresh_claim IS NULL`, [id, user, claim, grant.revision, row.oauth_binding]);
      if (!claimed.rowCount) throw authBusy();
      return { grant, material, refresh: true };
    });
    let material = state.material;
    if (state.refresh) {
      try {
        const provider = this.provider({ config: row.config, secrets: this.store.secrets(row), material, state: "" });
        await this.run(provider, row.config);
        if (provider.authorizationUrl || !provider.material.tokens?.access_token) throw authRequired();
        material = provider.material;
        await withSystemTx(this.store.pool, async tx => {
          await this.store.mutation(tx, org, user);
          const current = await this.store.read(tx, org, user, id);
          if (current.revision !== row.revision || current.oauth_binding !== row.oauth_binding) throw mcpConflict();
          const revision = state.grant.revision + 1;
          const envelope = sealMcpMaterial(material, { organizationId: org, ownerUserId: user, id, revision, purpose: "oauth" }, this.store.keys);
          const updated = await tx.query(`UPDATE organization_mcp_oauth SET revision=$5,envelope=$6,refresh_claim=NULL,refresh_started_at=NULL,
            access_expires_at=$8,refreshable=$9
            WHERE extension_id=$1 AND owner_user_id=$2 AND revision=$3 AND refresh_claim=$4 AND binding=$7`,
          [id, user, state.grant.revision, claim, revision, envelope, row.oauth_binding,
            material.expiresAt === undefined ? null : new Date(material.expiresAt), !!material.tokens?.refresh_token]);
          if (!updated.rowCount) throw mcpConflict();
        });
      } catch {
        await withSystemTx(this.store.pool, async tx => {
          await this.store.mutation(tx, org, user);
          await tx.query("DELETE FROM organization_mcp_oauth WHERE extension_id=$1 AND owner_user_id=$2 AND refresh_claim=$3", [id, user, claim]);
        }).catch(() => {});
        throw authRequired();
      }
    }
    // Revalidate after provider I/O and before releasing any token to a caller.
    await withSystemTx(this.store.pool, async tx => {
      await this.store.member(tx, org, user);
      const current = await this.store.read(tx, org, user, id);
      if (current.revision !== row.revision || current.oauth_binding !== row.oauth_binding) throw mcpConflict();
      const live = await tx.query(`SELECT 1 FROM organization_mcp_oauth WHERE extension_id=$1 AND owner_user_id=$2
        AND revision=$3 AND binding=$4 AND refresh_claim IS NULL`, [id, user, state.grant.revision + (state.refresh ? 1 : 0), row.oauth_binding]);
      if (!live.rowCount) throw authRequired();
    });
    const token = material.tokens;
    if (!token?.access_token || /[\r\n]/.test(token.access_token) || token.token_type.toLowerCase() !== "bearer") throw authRequired();
    return { headers: { ...runtime.headers, Authorization: `Bearer ${token.access_token}` }, expiresAt: material.expiresAt ?? Date.now() + 5 * 60_000 };
  }
}
