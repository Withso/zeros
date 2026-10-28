import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import { GithubTemporaryError, isGithubAccessRevoked, isGithubTemporary } from "../github-availability.js";
import type { GithubVerification, GithubVerificationStore } from "./github-verification-store.js";
import type { GithubRepositoryAuthority, RepositoryRequest } from "../github-repository-authority.js";
import type { CloudV2Workspace } from "./store.js";

const repositorySchema = z.string().max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => value.split("/").every(part => part !== "." && part !== ".."));
const repositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
export const CloudSourceTargetSchema = z.object({ repository: repositorySchema, repositoryId: repositoryIdSchema }).strict();
export type CloudSourceTarget = z.infer<typeof CloudSourceTargetSchema>;
const ADMISSION_LEASE_MS = 30_000;
export const CLOUD_SOURCE_REFRESH_MS = 10 * 60_000;
export const CLOUD_SOURCE_GRACE_MS = 60 * 60_000;
const MAX_LEASES = 1024;
type SourceRevision = { id: number; invalidated?: HttpError };
type SourceObservation = { scope: RepositoryRequest; fingerprint: string; revision: SourceRevision; until: number; recheckAt: number; refresh?: Promise<void> };
export type CloudSourceProof = { accessEpoch: string; loginRevision: string };
export type CloudSourceContinuation = { recheckAt: number; refresh?: Promise<void> };
type SourceVerifier = Pick<GithubRepositoryAuthority, "check" | "fingerprintFor"> & {
  verify?(input: RepositoryRequest): Promise<{ fingerprint: string; repositories: readonly CloudSourceTarget[] }>;
};
type WorkspaceLease = { proof: string; revision: SourceRevision; organizationId: string; userId: string; value: CloudSourceContinuation };

/** Fresh admission and continuation are deliberately separate. Only a running
 * workspace with known original IDs can retain a positive observation during
 * a provider outage; failures never renew that observation's one-hour limit. */
export class CloudV2SourceAuthority {
  private readonly observations = new Map<string, GithubVerification>();
  private readonly flights = new Map<string, Promise<GithubVerification>>();
  private readonly workspaceLeases = new Map<string, WorkspaceLease>();
  private readonly workspaceFlights = new Map<string, Promise<CloudSourceContinuation>>();
  private readonly fingerprints = new Map<string, Promise<string>>();
  private readonly actorFlights = new Map<string, Promise<GithubVerification>>();
  private readonly backoffs = new Map<string, { until: number; error: HttpError }>();
  private readonly revisions = new Map<string, SourceRevision>();
  private nextRevision = 0;
  constructor(private readonly pool: pg.Pool, private readonly github: SourceVerifier,
    private readonly now = () => Date.now(),
    private readonly sourceTargets?: (workspace: CloudV2Workspace, sources: readonly string[]) => Promise<readonly CloudSourceTarget[]>,
    private readonly verificationStore?: GithubVerificationStore,
    private readonly random = Math.random) {}

  private revision(scope: { organizationId?: string; userId: string }): SourceRevision {
    const key = JSON.stringify([scope.organizationId, scope.userId]);
    const current = this.revisions.get(key);
    if (current !== undefined) return current;
    if (this.revisions.size >= MAX_LEASES) this.revisions.delete(this.revisions.keys().next().value!);
    const value = { id: ++this.nextRevision };
    this.revisions.set(key, value);
    return value;
  }

  private assertRevision(scope: { organizationId?: string; userId: string }, revision: SourceRevision): void {
    if (this.revisions.get(JSON.stringify([scope.organizationId, scope.userId])) !== revision)
      throw revision.invalidated ?? new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
  }

  async repository(organizationId: string, userId: string, repository: string): Promise<void> {
    await this.observeRepository(organizationId, userId, repository);
  }
  async repositories(organizationId: string, userId: string, repositories: readonly string[]): Promise<void> {
    await this.observeSources(organizationId, userId, repositories);
  }
  async targets(organizationId: string, userId: string, targets: readonly CloudSourceTarget[]): Promise<void> {
    const parsed = z.array(CloudSourceTargetSchema).min(1).max(100).safeParse(targets);
    if (!parsed.success) throw new HttpError(409, "cloud_source_review_required", "The original source identities could not be verified. Existing data has been retained.");
    await this.observeSources(organizationId, userId, parsed.data.map(target => target.repository), parsed.data.map(target => target.repositoryId));
  }

  private fingerprint(scope: RepositoryRequest): Promise<string> {
    const key = JSON.stringify([scope.organizationId, scope.userId, scope.owner]);
    const current = this.fingerprints.get(key);
    if (current) return current;
    const pending = this.github.fingerprintFor(scope).finally(() => {
      if (this.fingerprints.get(key) === pending) this.fingerprints.delete(key);
    });
    this.fingerprints.set(key, pending);
    return pending;
  }

  private async observeSources(organizationId: string, userId: string, repositories: readonly string[], ids?: readonly string[], continuation = false): Promise<SourceObservation[]> {
    const sources = z.array(repositorySchema).min(1).max(100).safeParse(repositories);
    if (!sources.success || ids && (ids.length !== repositories.length || !z.array(repositoryIdSchema).safeParse(ids).success))
      throw new HttpError(403, "github_repository_invalid", "Repository access could not be verified.");
    const observations: SourceObservation[] = [];
    for (const [index, repository] of sources.data.entries()) observations.push(await this.observeRepository(organizationId, userId, repository, ids?.[index], continuation));
    const requireFresh = () => {
      if (observations.some(observation => observation.until <= this.now()))
        throw new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
    };
    requireFresh();
    for (const observation of observations) {
      if (await this.fingerprint(observation.scope) !== observation.fingerprint)
        throw new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
    }
    for (const observation of observations) this.assertRevision(observation.scope, observation.revision);
    requireFresh();
    return observations;
  }

  private remember(key: string, value: GithubVerification): GithubVerification {
    if (!this.observations.has(key) && this.observations.size >= MAX_LEASES) this.observations.delete(this.observations.keys().next().value!);
    this.observations.set(key, value);
    return value;
  }

  private rememberBackoff(actor: string, value: { until: number; error: HttpError }): void {
    if (!this.backoffs.has(actor) && this.backoffs.size >= MAX_LEASES) this.backoffs.delete(this.backoffs.keys().next().value!);
    this.backoffs.set(actor, value);
  }

  private refresh(key: string, scope: RepositoryRequest, fingerprint: string, previous: GithubVerification | undefined, revision: SourceRevision): Promise<GithubVerification> {
    const flightKey = JSON.stringify([key, revision.id]);
    const pending = this.flights.get(flightKey);
    if (pending) return pending;
    if (this.flights.size >= MAX_LEASES) return Promise.reject(new GithubTemporaryError("github_verification_busy"));
    const persistent = this.verificationStore && scope.repositoryIds?.[0] ? {
      organizationId: scope.organizationId!, userId: scope.userId, repositoryId: scope.repositoryIds[0], fingerprint,
    } : undefined;
    const actor = JSON.stringify([scope.organizationId, scope.userId, fingerprint]);
    const predecessor = this.actorFlights.get(actor);
    const flight = (async () => {
      // One provider verification per actor at a time. A first outage response
      // backs off queued repositories too, instead of producing a request storm.
      await predecessor?.catch(() => {});
      this.assertRevision(scope, revision);
      let blocked = this.backoffs.get(actor);
      if ((!blocked || blocked.until <= this.now()) && persistent) {
        const shared = await this.verificationStore!.backoff(persistent);
        if (shared?.failure && shared.retryAt > this.now()) blocked = { until: shared.retryAt, error: shared.failure };
      }
      if (blocked && blocked.until > this.now()) {
        this.assertRevision(scope, revision);
        this.rememberBackoff(actor, blocked);
        this.remember(key, { verifiedAt: previous?.verifiedAt ?? null, failure: blocked.error,
          retryAt: blocked.until, failures: previous?.failures ?? 0, claimId: null, claimUntil: 0, claimStartedAt: 0 });
        throw blocked.error;
      }
      const claim = persistent ? await this.verificationStore!.claim(persistent) : null;
      if (persistent && !claim?.claimId) {
        const other = await this.verificationStore!.read(persistent);
        this.assertRevision(scope, revision);
        if (other) this.remember(key, other);
        if (other?.verifiedAt != null && !other.failure && other.verifiedAt + ADMISSION_LEASE_MS > this.now()) return other;
        if (other?.failure && other.retryAt > this.now()) throw other.failure;
        throw new GithubTemporaryError("github_verification_busy");
      }
      const started = claim?.claimStartedAt ?? this.now();
      let verified: string;
      let canonicalRepository: string | undefined;
      try {
        if (this.github.verify) {
          const result = await this.github.verify(scope);
          verified = result.fingerprint;
          const identity = result.repositories.find(value => value.repositoryId === scope.repositoryIds?.[0]);
          if (identity) canonicalRepository = identity.repository;
        } else verified = await this.github.check(scope);
        if (verified !== fingerprint || await this.fingerprint(scope) !== fingerprint)
          throw new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
        this.assertRevision(scope, revision);
      } catch (error) {
        // A rejection from a superseded connection cannot revoke its successor.
        if (await this.fingerprint(scope) !== fingerprint)
          error = new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
        const failure = error instanceof HttpError ? error : new HttpError(503, "github_verification_failed", "Repository verification could not complete. Try again.");
        const temporary = isGithubTemporary(failure);
        const prior = claim ?? previous;
        const backoff = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(prior?.failures ?? 0, 4));
        const retryAfterMs = Math.max(backoff, error instanceof GithubTemporaryError ? error.retryAfterMs : 0) + Math.floor(backoff * 0.2 * this.random());
        const value = persistent ? await this.verificationStore!.finish(persistent, claim!.claimId!, { allowed: false, temporary, error: failure, retryAfterMs }) : {
          verifiedAt: temporary ? prior?.verifiedAt ?? null : null,
          failure, failures: Math.min((prior?.failures ?? 0) + 1, 16), retryAt: this.now() + retryAfterMs,
          claimId: null, claimUntil: 0, claimStartedAt: started,
        };
        this.assertRevision(scope, revision);
        if (value && isGithubAccessRevoked(failure)) this.invalidate({ ...(scope.organizationId ? { organizationId: scope.organizationId } : {}), userId: scope.userId }, failure);
        if (value) this.remember(key, value);
        if (value && ["github_unavailable", "github_rate_limited"].includes(failure.code)) {
          this.rememberBackoff(actor, { until: value.retryAt, error: failure });
        }
        throw failure;
      }
      const value = persistent ? await this.verificationStore!.finish(persistent, claim!.claimId!, { allowed: true, ...(canonicalRepository ? { canonicalRepository } : {}) }) : {
        verifiedAt: started, failure: null, failures: 0, retryAt: 0, claimId: null, claimUntil: 0, claimStartedAt: started,
      };
      this.assertRevision(scope, revision);
      if (!value) throw new GithubTemporaryError("github_verification_busy");
      return this.remember(key, value);
    })().finally(() => {
      if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey);
      if (this.actorFlights.get(actor) === flight) this.actorFlights.delete(actor);
    });
    // A continuation returns immediately while the observation refreshes. The
    // caller also receives this promise so confirmed revocation can retire it.
    void flight.catch(() => {});
    this.flights.set(flightKey, flight);
    this.actorFlights.set(actor, flight);
    return flight;
  }

  private async observeRepository(organizationId: string, userId: string, repository: string, repositoryId?: string, continuation = false): Promise<SourceObservation> {
    const parsed = repositorySchema.safeParse(repository);
    if (!parsed.success) throw new HttpError(403, "github_repository_invalid", "Repository access could not be verified.");
    const [owner, name] = parsed.data.toLowerCase().split("/") as [string, string];
    const scope = { organizationId, userId, owner, repositories: [name], access: "read" as const, ...(repositoryId ? { repositoryIds: [repositoryId] } : {}) };
    const revision = this.revision(scope);
    const fingerprint = await this.fingerprint(scope);
    this.assertRevision(scope, revision);
    const key = JSON.stringify([organizationId, userId, owner, name, repositoryId ?? null, fingerprint]);
    const freshness = continuation ? CLOUD_SOURCE_REFRESH_MS : ADMISSION_LEASE_MS;
    let value = this.observations.get(key);
    const fresh = () => value?.verifiedAt !== null && value?.verifiedAt !== undefined && !value.failure && value.verifiedAt + freshness > this.now();
    // The workspace proof fast path above this layer avoids these reads.
    // Without that proof, also observe a denial recorded by another replica
    // whose notification may have been lost; a local positive is not enough.
    if (this.verificationStore && repositoryId) {
      const stored = await this.verificationStore.read({ organizationId, userId, repositoryId, fingerprint });
      this.assertRevision(scope, revision);
      if (stored) value = this.remember(key, stored);
      else { this.observations.delete(key); value = undefined; }
    }
    const observation = (record: GithubVerification, recheckAt: number, refresh?: Promise<GithubVerification>): SourceObservation => ({
      scope, fingerprint, revision, until: record.verifiedAt! + (continuation ? CLOUD_SOURCE_GRACE_MS : ADMISSION_LEASE_MS),
      recheckAt: Math.min(recheckAt, record.verifiedAt! + CLOUD_SOURCE_GRACE_MS),
      ...(refresh ? { refresh: refresh.then(() => {}) } : {}),
    });
    if (fresh()) return observation(value!, value!.verifiedAt! + freshness);
    const grace = continuation && value?.verifiedAt !== null && value?.verifiedAt !== undefined &&
      value.verifiedAt + CLOUD_SOURCE_GRACE_MS > this.now() && (!value.failure || isGithubTemporary(value.failure));
    if (value?.failure && value.retryAt > this.now()) {
      if (grace) return observation(value, value.retryAt);
      throw value.failure;
    }
    const blocked = this.backoffs.get(JSON.stringify([organizationId, userId, fingerprint]));
    if (blocked && blocked.until > this.now()) {
      if (grace) return observation(value!, blocked.until);
      throw blocked.error;
    }
    if (value?.claimId && value.claimUntil > this.now()) {
      if (grace) return observation(value, value.claimUntil);
      throw new GithubTemporaryError("github_verification_busy", Math.max(1000, value.claimUntil - this.now()));
    }
    const refresh = this.refresh(key, scope, fingerprint, value, revision);
    if (grace) {
      const result = observation(value!, this.now() + 60_000, refresh);
      void result.refresh!.catch(() => {});
      return result;
    }
    value = await refresh;
    if (value.verifiedAt === null || value.verifiedAt + freshness <= this.now())
      throw new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
    return observation(value, value.verifiedAt + freshness);
  }

  private async sources(workspace: CloudV2Workspace): Promise<{ names: string[]; ids?: string[] }> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ source_repositories: unknown }>(
      `SELECT source_repositories FROM cloud_v2_workspaces
       WHERE id=$1 AND org_id=$2 AND creator_user_id=$3 AND state NOT IN ('deleted','deleting')`,
      [workspace.id, workspace.organizationId, workspace.creatorUserId]));
    const sources = z.array(repositorySchema).min(1).max(100).safeParse(rows[0]?.source_repositories);
    if (!sources.success || !sources.data.some(repo => repo.toLowerCase() === workspace.repository.toLowerCase()))
      throw new HttpError(409, "cloud_source_review_required", "This older workspace needs its source access verified. Its files have been retained.");
    if (!this.sourceTargets) return { names: sources.data };
    const targets = await this.sourceTargets(workspace, sources.data);
    if (targets.length !== sources.data.length || targets.some((target, index) => target.repository.toLowerCase() !== sources.data[index]!.toLowerCase() || !CloudSourceTargetSchema.safeParse(target).success))
      throw new HttpError(409, "cloud_source_review_required", "This workspace needs its original source identities verified. Its files have been retained.");
    return { names: sources.data, ids: targets.map(target => target.repositoryId) };
  }

  async workspace(workspace: CloudV2Workspace): Promise<void> {
    const sources = await this.sources(workspace);
    await this.observeSources(workspace.organizationId, workspace.creatorUserId, sources.names, sources.ids);
  }

  /** proof comes only from the current worker token or room/session database
   * read. Never accept these revisions from request bodies or a cached client. */
  async continueWorkspace(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation> {
    if (workspace.state !== "running") {
      await this.workspace(workspace);
      return { recheckAt: this.now() + ADMISSION_LEASE_MS };
    }
    const key = JSON.stringify([workspace.id, workspace.organizationId, workspace.creatorUserId, workspace.repository]);
    const scope = { organizationId: workspace.organizationId, userId: workspace.creatorUserId };
    const revision = proof ? JSON.stringify([proof.accessEpoch, proof.loginRevision]) : "";
    const cached = this.workspaceLeases.get(key);
    if (proof && cached?.proof && cached.proof !== revision) {
      const [epoch, login] = JSON.parse(cached.proof) as [string, string];
      if (BigInt(proof.accessEpoch) < BigInt(epoch) || (proof.accessEpoch === epoch && BigInt(proof.loginRevision) < BigInt(login)))
        throw new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
      this.invalidate(scope);
    }
    const sourceRevision = this.revision(scope);
    if (revision && cached?.proof === revision && cached.revision === sourceRevision && cached.value.recheckAt > this.now()) return cached.value;
    const flightKey = JSON.stringify([key, revision, sourceRevision.id]);
    const pending = this.workspaceFlights.get(flightKey);
    if (pending) return pending;
    if (this.workspaceFlights.size >= MAX_LEASES) throw new GithubTemporaryError("github_verification_busy");
    const flight = (async () => {
      const sources = await this.sources(workspace);
      this.assertRevision(scope, sourceRevision);
      if (!sources.ids) throw new HttpError(409, "cloud_source_review_required", "This workspace needs its original source identities verified. Its files have been retained.");
      const observations = await this.observeSources(workspace.organizationId, workspace.creatorUserId, sources.names, sources.ids, true);
      this.assertRevision(scope, sourceRevision);
      const refreshes = observations.flatMap(value => value.refresh ? [value.refresh] : []);
      const value: CloudSourceContinuation = { recheckAt: Math.min(...observations.map(value => value.recheckAt)) };
      const lease = { proof: revision, revision: sourceRevision, organizationId: workspace.organizationId, userId: workspace.creatorUserId, value };
      if (this.workspaceLeases.size >= MAX_LEASES) this.workspaceLeases.delete(this.workspaceLeases.keys().next().value!);
      this.workspaceLeases.set(key, lease);
      if (refreshes.length) {
        value.refresh = Promise.all(refreshes).then(() => {}).finally(() => {
          if (this.workspaceLeases.get(key) === lease) this.workspaceLeases.delete(key);
        });
        void value.refresh.catch(() => {});
      }
      return value;
    })().finally(() => { if (this.workspaceFlights.get(flightKey) === flight) this.workspaceFlights.delete(flightKey); });
    this.workspaceFlights.set(flightKey, flight);
    return flight;
  }

  /** Notifications are hints: dropping local observations makes the next use
   * re-read the durable exact-generation result, never trust a payload grant. */
  invalidate(scope?: { organizationId?: string; userId?: string }, reason?: HttpError): void {
    if (reason) for (const [key, revision] of this.revisions) {
      const [organizationId, userId] = JSON.parse(key) as string[];
      if ((!scope?.organizationId || organizationId === scope.organizationId) && (!scope?.userId || userId === scope.userId)) revision.invalidated = reason;
    }
    for (const collection of [this.revisions, this.fingerprints]) for (const key of collection.keys()) {
      const [organizationId, userId] = JSON.parse(key) as string[];
      if ((!scope?.organizationId || organizationId === scope.organizationId) && (!scope?.userId || userId === scope.userId)) collection.delete(key);
    }
    for (const key of this.observations.keys()) {
      const [organizationId, userId] = JSON.parse(key) as string[];
      if ((!scope?.organizationId || organizationId === scope.organizationId) && (!scope?.userId || userId === scope.userId)) this.observations.delete(key);
    }
    for (const [key, lease] of this.workspaceLeases) {
      if ((!scope?.organizationId || lease.organizationId === scope.organizationId) && (!scope?.userId || lease.userId === scope.userId)) this.workspaceLeases.delete(key);
    }
  }
}

/** New clean images contain no checkout. Retries never reset an existing
 * worktree. Credentials are a one-command header, never a remote URL. */
export function hydrateCloudRepository(workspace: CloudV2Workspace, canonicalRepository = workspace.repository): string {
  if (!repositorySchema.safeParse(workspace.repository).success || !repositorySchema.safeParse(canonicalRepository).success) throw new Error("Invalid repository");
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const directory = `/home/user/${workspace.repository}`, url = `https://github.com/${canonicalRepository}.git`;
  return `bash -lc ${q([
    "set -eu",
    "IFS= read -r ZEROS_GITHUB_AUTH_HEADER",
    "export ZEROS_GITHUB_AUTH_HEADER",
    `if [ ! -e ${q(directory)} ]; then`,
    `  mkdir -p -- ${q(directory.slice(0, directory.lastIndexOf("/")))}`,
    `  clone_tmp=$(mktemp -d ${q(`${directory.slice(0, directory.lastIndexOf("/"))}/.zeros-clone.XXXXXXXX`)})`,
    `  trap 'rm -rf -- "$clone_tmp"' EXIT`,
    `  git --config-env=http.extraHeader=ZEROS_GITHUB_AUTH_HEADER clone -- ${q(url)} "$clone_tmp"`,
    // Same filesystem, atomic publication. A retry or another creator must
    // never replace an existing checkout, including a partially edited one.
    `  mv -T -n -- "$clone_tmp" ${q(directory)}`,
    "fi",
    // A previous interrupted clone is not permission to delete someone's work.
    `test -d ${q(`${directory}/.git`)}`,
    // Existing remotes belong to the user. The worker reconciles an eligible
    // old name under Git's lock, preserving forks, refspecs, and URL rewrites.
  ].join("\n"))}`;
}
