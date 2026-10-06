import { createHash } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import { assertCloudActorSession, type CloudActorEngineScope } from "./actor-sessions.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { resolveComputerRepositoryGrant } from "./computer-workspace-source.js";
import { authorizeGithubRead, type GithubReadRequest } from "./github-read-policy.js";
import { GithubReadCredentials, type GithubReadCredentialBroker } from "./github-read-credentials.js";

type Scope = CloudActorEngineScope & { actorSessionId: string };
type Repository = { owner: string; repository: string; repositoryId: string; installationId: number };
type Result = { status: 200; contentType: string; body: string };
type CacheEntry = { result: Result; etag: string | null; at: number; bytes: number };
const MAX_BYTES = 8 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const TTL_MS = 5000;
const ETAG_TTL_MS = 5 * 60_000;
export class GithubReadError extends Error {
  constructor(readonly status: 403 | 404 | 429 | 502 = 502) { super("GitHub repository read is unavailable."); }
}

async function boundedBody(response: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (!response.body || Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubReadError();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) throw new GithubReadError();
      chunks.push(chunk.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { await reader.cancel().catch(() => undefined); throw new GithubReadError(); }
  finally { reader.releaseLock(); }
}

/** No read grant rows or human GitHub credential. Authorization is checked
 * before cache lookup and again after I/O. Cache and budgets are bounded per
 * control-plane process; a restart discards them, never workspace authority. */
export class DatabaseCloudGithubReads {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<CacheEntry>>();
  private readonly budgets = new Map<string, { at: number; count: number }>();
  private readonly identities = new Map<string, number>();
  private readonly identityReads = new Map<string, Promise<void>>();
  private readonly credentials: GithubReadCredentials;
  private readonly abort = new AbortController();
  private closed = false;
  private cacheBytes = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  constructor(private readonly pool: pg.Pool, private readonly workosEnabled: boolean, broker: GithubReadCredentialBroker,
    deps: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.credentials = new GithubReadCredentials(broker, { now: this.now });
  }

  async cleanup(): Promise<void> {
    for (const [key, at] of this.identities) if (this.now() - at >= 60_000) this.identities.delete(key);
    await this.credentials.cleanup();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.credentials.close();
    await Promise.allSettled([...this.pending.values()]);
    this.cache.clear(); this.cacheBytes = 0; this.identities.clear(); this.budgets.clear();
  }

  async authorize(scope: Scope): Promise<Repository> {
    return withSystemTx(this.pool, async tx => {
      await assertCurrentCloudEngineAuthority(tx, { ...scope, workosEnabled: this.workosEnabled, lock: "share" });
      await assertCloudActorSession(tx, scope, scope.actorSessionId, "read");
      const row = (await tx.query<Repository & { configId: string; installationRowId: string }>(`
        SELECT workspace.repository_owner AS owner,workspace.repository_name AS repository,
          repo.forge_repository_id AS "repositoryId",source.config_id AS "configId",configured.installation_id AS "installationRowId"
        FROM cloud_workspaces workspace
        JOIN cloud_workspace_computer_sources source ON source.workspace_id=workspace.id
          AND source.org_id=workspace.org_id AND source.generation=workspace.current_generation
        JOIN repositories repo ON repo.id=workspace.repository_id AND repo.org_id=workspace.org_id
        JOIN cloud_computer_v2_config_repositories configured ON configured.config_id=source.config_id AND configured.org_id=source.org_id
          AND configured.repository_id=repo.forge_repository_id
          AND configured.repository_owner=lower(workspace.repository_owner) AND configured.repository_name=lower(workspace.repository_name)
        WHERE workspace.id=$1 AND workspace.org_id=$2 AND workspace.current_generation=$3
          AND workspace.repository_forge='github.com' AND repo.identity_state='verified'
        FOR SHARE OF configured`, [scope.workspaceId, scope.organizationId, scope.generation])).rows[0];
      if (!row || !/^[1-9][0-9]*$/.test(row.repositoryId)) throw new GithubReadError(403);
      const grant = await resolveComputerRepositoryGrant(tx, { organizationId: scope.organizationId, configId: row.configId,
        owner: row.owner, name: row.repository, installationId: row.installationRowId, repositoryId: row.repositoryId });
      return { owner: row.owner, repository: row.repository, repositoryId: row.repositoryId, installationId: grant.githubInstallationId };
    });
  }

  private admit(workspaceId: string): void {
    const now = this.now();
    for (const [key, value] of this.budgets) if (now - value.at >= 60_000) this.budgets.delete(key);
    let budget = this.budgets.get(workspaceId);
    if (!budget) {
      if (this.budgets.size >= 1000) throw new GithubReadError(429);
      budget = { at: now, count: 0 };
      this.budgets.set(workspaceId, budget);
    }
    if (++budget.count > 240) throw new GithubReadError(429);
  }

  async read(scope: Scope, value: unknown): Promise<Result> {
    if (this.closed) throw new GithubReadError();
    const repository = await this.authorize(scope);
    const request = authorizeGithubRead(repository, value);
    this.admit(scope.workspaceId);
    const { fresh, ...cacheRequest } = request;
    const key = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.generation, repository, cacheRequest])).digest("hex");
    const cached = this.cache.get(key);
    let entry: CacheEntry;
    if (!fresh && cached && this.now() - cached.at < TTL_MS) entry = cached;
    else {
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.pending.size >= 64) throw new GithubReadError(429);
        pending = this.load(repository, request, cached && this.now() - cached.at < ETAG_TTL_MS ? cached : undefined);
        this.pending.set(key, pending);
      }
      try { entry = await pending; }
      finally { if (this.pending.get(key) === pending) this.pending.delete(key); }
    }
    // Revoke/stop/role changes that win during network I/O fence this response.
    if (this.closed || JSON.stringify(await this.authorize(scope)) !== JSON.stringify(repository)) throw new GithubReadError(403);
    const current = this.cache.get(key);
    if (current !== entry && (!current || current.at <= entry.at)) {
      if (current && this.cache.delete(key)) this.cacheBytes -= current.bytes;
      this.cache.set(key, entry); this.cacheBytes += entry.bytes;
      while (this.cache.size > 256 || this.cacheBytes > CACHE_BYTES) {
        const oldest = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
      }
    }
    return entry.result;
  }

  private async verifyIdentity(repository: Repository, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
    const key = JSON.stringify([repository.installationId, repository.repositoryId, repository.owner, repository.repository]);
    const verifiedAt = this.identities.get(key);
    if (verifiedAt !== undefined && this.now() - verifiedAt < 60_000) return;
    let pending = this.identityReads.get(key);
    if (!pending) {
      pending = (async () => {
        const identity = await this.fetch(`https://api.github.com/repos/${repository.owner}/${repository.repository}`, { headers, signal, redirect: "error" });
        if (!identity.ok) { await identity.body?.cancel().catch(() => undefined); throw new GithubReadError(); }
        const metadata = JSON.parse(await boundedBody(identity, 256 * 1024));
        if (String(metadata.id) !== repository.repositoryId || metadata.disabled === true) throw new GithubReadError();
        this.identities.delete(key); this.identities.set(key, this.now());
        while (this.identities.size > 256) this.identities.delete(this.identities.keys().next().value!);
      })();
      this.identityReads.set(key, pending);
    }
    try { await pending; }
    finally { if (this.identityReads.get(key) === pending) this.identityReads.delete(key); }
  }

  private async load(repository: Repository, request: GithubReadRequest, cached?: CacheEntry): Promise<CacheEntry> {
    return this.credentials.use({ installationId: repository.installationId, repositoryId: Number(repository.repositoryId) }, async token => {
    try {
      const headers: Record<string, string> = { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "user-agent": "zeros-control-plane", "x-github-api-version": "2026-03-10" };
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), this.abort.signal]);
      await this.verifyIdentity(repository, headers, signal);
      if (request.format === "diff") headers.accept = "application/vnd.github.diff";
      if (cached?.etag) headers["if-none-match"] = cached.etag;
      if (request.body) headers["content-type"] = "application/json";
      const response = await this.fetch(`https://api.github.com${request.path}`, { method: request.method, headers, signal,
        redirect: "error", ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
      if (response.status === 304 && cached) { await response.body?.cancel(); return { ...cached, at: this.now() }; }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GithubReadError(response.status === 404 ? 404 : response.status === 429 ? 429 : 502);
      }
      const body = await boundedBody(response);
      if (request.format === "json") {
        const data = JSON.parse(body);
        if (data && typeof data === "object" && "errors" in data) throw new GithubReadError();
      }
      return { result: { status: 200, contentType: request.format === "diff" ? "text/plain" : "application/json", body },
        etag: response.headers.get("etag")?.slice(0, 256) ?? null, at: this.now(), bytes: Buffer.byteLength(body) };
    } catch (error) { throw error instanceof GithubReadError ? error : new GithubReadError(); }
    });
  }
}
