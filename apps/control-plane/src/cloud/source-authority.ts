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
export const CLOUD_SOURCE_ADMISSION_MS = 30_000;
/** A booting workspace's worker says hello seconds after the lifecycle's
 * checks, which renew a positive this close to expiry in the background. */
export const CLOUD_SOURCE_RENEWAL_MS = 15_000;
// Worker HTTP requests allow ten seconds, including configuration after admission.
const VERIFICATION_WAIT_MS = 5_000;
export const CLOUD_SOURCE_REFRESH_MS = 10 * 60_000;
export const CLOUD_SOURCE_GRACE_MS = 60 * 60_000;
const MAX_LEASES = 1024;
type SourceRevision = { id: number; invalidated?: HttpError };
type SourceObservation = { scope: RepositoryRequest; fingerprint: string; revision: SourceRevision; until: number; recheckAt: number; refresh?: Promise<void> };
export type CloudSourceProof = { accessEpoch: string; loginRevision: string };
/** graceUntil is the earliest original verification time plus the grace across
 * every source; cached and grace continuations repeat it, never extend it. */
export type CloudSourceContinuation = { recheckAt: number; refresh?: Promise<void>; graceUntil?: number };
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
  private readonly renewalPauses = new Map<string, number>();
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

  private fingerprintOnce(read: Map<string, Promise<string>>, scope: RepositoryRequest): Promise<string> {
    const key = JSON.stringify([scope.organizationId, scope.userId, scope.owner]);
    let pending = read.get(key);
    if (!pending) { pending = this.fingerprint(scope); pending.catch(() => {}); read.set(key, pending); }
    return pending;
  }

  private async observeSources(organizationId: string, userId: string, repositories: readonly string[], ids?: readonly string[], continuation = false, renew = false): Promise<SourceObservation[]> {
    const sources = z.array(repositorySchema).min(1).max(100).safeParse(repositories);
    if (!sources.success || ids && (ids.length !== repositories.length || !z.array(repositoryIdSchema).safeParse(ids).success))
      throw new HttpError(403, "github_repository_invalid", "Repository access could not be verified.");
    const observations: SourceObservation[] = [];
    const deadline = this.now() + VERIFICATION_WAIT_MS;
    // Repositories of one owner share a connection: read its fingerprint once
    // before the observations and once after, not once per repository.
    const before = new Map<string, Promise<string>>(), after = new Map<string, Promise<string>>();
    for (const [index, repository] of sources.data.entries()) observations.push(await this.observeRepository(organizationId, userId, repository, ids?.[index], continuation, deadline, before, renew));
    const requireFresh = () => {
      if (observations.some(observation => observation.until <= this.now()))
        throw new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
    };
    requireFresh();
    for (const observation of observations) {
      if (await this.waitFor(this.fingerprintOnce(after, observation.scope), deadline) !== observation.fingerprint)
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

  private pauseRenewal(key: string, until: number): void {
    if (!this.renewalPauses.has(key) && this.renewalPauses.size >= MAX_LEASES) this.renewalPauses.delete(this.renewalPauses.keys().next().value!);
    this.renewalPauses.set(key, until);
  }

  /** Verifies a durable positive again in the background once it is within
   * CLOUD_SOURCE_RENEWAL_MS of expiry. One flight per process, one claim
   * across replicas; a confirmed refusal still withdraws it at once. */
  private renew(key: string, scope: RepositoryRequest, fingerprint: string, value: GithubVerification, revision: SourceRevision): void {
    const now = this.now(), expires = value.verifiedAt! + CLOUD_SOURCE_ADMISSION_MS;
    if (expires - now > CLOUD_SOURCE_RENEWAL_MS) return;
    const paused = this.renewalPauses.get(key);
    if (paused !== undefined && paused > now) return;
    this.renewalPauses.delete(key);
    // After any failure the positive simply expires and admission verifies as before.
    void this.refresh(key, scope, fingerprint, value, revision, now + VERIFICATION_WAIT_MS, true)
      .catch(() => this.pauseRenewal(key, expires));
  }

  private waitFor<T>(pending: Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      void pending.catch(() => {});
      return Promise.reject(new GithubTemporaryError("github_verification_busy"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new GithubTemporaryError("github_verification_busy")), remaining);
      pending.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private refresh(key: string, scope: RepositoryRequest, fingerprint: string, previous: GithubVerification | undefined, revision: SourceRevision, deadline: number, renewal = false): Promise<GithubVerification> {
    const flightKey = JSON.stringify([key, revision.id]);
    const pending = this.flights.get(flightKey);
    if (pending) return pending;
    if (this.flights.size >= MAX_LEASES) return Promise.reject(new GithubTemporaryError("github_verification_busy"));
    const persistent = this.verificationStore && scope.repositoryIds?.[0] ? {
      organizationId: scope.organizationId!, userId: scope.userId, repositoryId: scope.repositoryIds[0], fingerprint,
    } : undefined;
    const actor = JSON.stringify([scope.organizationId, scope.userId, fingerprint]);
    const predecessor = this.actorFlights.get(actor);
    const renewAfter = renewal ? CLOUD_SOURCE_ADMISSION_MS - CLOUD_SOURCE_RENEWAL_MS : CLOUD_SOURCE_ADMISSION_MS;
    const flight = (async () => {
      // One provider verification per actor at a time. A first outage response
      // backs off queued repositories too, instead of producing a request storm.
      if (predecessor) await this.waitFor(predecessor.catch(() => {}), deadline);
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
      let claim: GithubVerification | null = null;
      if (persistent) {
        let other = previous;
        for (let attempt = 0; ; attempt++) {
          this.assertRevision(scope, revision);
          if (this.now() >= deadline) throw new GithubTemporaryError("github_verification_busy");
          if (other?.verifiedAt != null && !other.failure && other.verifiedAt + renewAfter > this.now()) return other;
          if (other?.failure && other.retryAt > this.now()) throw other.failure;
          if (!other?.claimId || other.claimUntil <= this.now()) {
            claim = await (renewal ? this.verificationStore!.claim(persistent, renewAfter) : this.verificationStore!.claim(persistent));
            this.assertRevision(scope, revision);
            if (claim?.claimId) break;
          }
          // Poll the durable exact-generation claim, without holding a DB
          // connection or treating another replica's in-flight work as denial.
          if (attempt || other?.claimId) await new Promise<void>(resolve => setTimeout(resolve,
            Math.max(0, Math.min(1000, 250 * 2 ** Math.min(attempt, 2), deadline - this.now()))));
          other = await this.verificationStore!.read(persistent) ?? undefined;
          this.assertRevision(scope, revision);
          if (other) this.remember(key, other);
        }
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
        // A renewal never shortens the positive it renews: an outage records
        // nothing. A confirmed refusal below withdraws it as usual.
        if (renewal && temporary && persistent && claim?.claimId) {
          await this.verificationStore!.release(persistent, claim.claimId);
          throw failure;
        }
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
    // A background renewal never queues the actor's other verifications.
    if (!renewal) this.actorFlights.set(actor, flight);
    return flight;
  }

  private async observeRepository(organizationId: string, userId: string, repository: string, repositoryId?: string, continuation = false, deadline = this.now() + VERIFICATION_WAIT_MS,
    fingerprints?: Map<string, Promise<string>>, renew = false): Promise<SourceObservation> {
    const parsed = repositorySchema.safeParse(repository);
    if (!parsed.success) throw new HttpError(403, "github_repository_invalid", "Repository access could not be verified.");
    const [owner, name] = parsed.data.toLowerCase().split("/") as [string, string];
    const scope = { organizationId, userId, owner, repositories: [name], access: "read" as const, ...(repositoryId ? { repositoryIds: [repositoryId] } : {}) };
    const revision = this.revision(scope);
    const fingerprint = await this.waitFor(fingerprints ? this.fingerprintOnce(fingerprints, scope) : this.fingerprint(scope), deadline);
    this.assertRevision(scope, revision);
    const key = JSON.stringify([organizationId, userId, owner, name, repositoryId ?? null, fingerprint]);
    const freshness = continuation ? CLOUD_SOURCE_REFRESH_MS : CLOUD_SOURCE_ADMISSION_MS;
    let value = this.observations.get(key);
    const fresh = () => value?.verifiedAt !== null && value?.verifiedAt !== undefined && !value.failure && value.verifiedAt + freshness > this.now();
    // The workspace proof fast path above this layer avoids these reads.
    // Without that proof, also observe a denial recorded by another replica
    // whose notification may have been lost; a local positive is not enough.
    if (this.verificationStore && repositoryId) {
      const stored = await this.waitFor(this.verificationStore.read({ organizationId, userId, repositoryId, fingerprint }), deadline);
      this.assertRevision(scope, revision);
      if (stored) value = this.remember(key, stored);
      else { this.observations.delete(key); value = undefined; }
    }
    const observation = (record: GithubVerification, recheckAt: number, refresh?: Promise<GithubVerification>): SourceObservation => ({
      scope, fingerprint, revision, until: record.verifiedAt! + (continuation ? CLOUD_SOURCE_GRACE_MS : CLOUD_SOURCE_ADMISSION_MS),
      recheckAt: Math.min(recheckAt, record.verifiedAt! + CLOUD_SOURCE_GRACE_MS),
      ...(refresh ? { refresh: refresh.then(() => {}) } : {}),
    });
    if (fresh()) {
      if (renew && !continuation && this.verificationStore && repositoryId) this.renew(key, scope, fingerprint, value!, revision);
      return observation(value!, value!.verifiedAt! + freshness);
    }
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
    }
    const refresh = this.refresh(key, scope, fingerprint, value, revision, deadline);
    if (grace) {
      const result = observation(value!, this.now() + 60_000, refresh);
      void result.refresh!.catch(() => {});
      return result;
    }
    value = await this.waitFor(refresh, deadline);
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

  /** renew is for the lifecycle's checks of a booting workspace, whose hello
   * follows within seconds. Other checks would renew every 15 s while polled. */
  async workspace(workspace: CloudV2Workspace, renew = false): Promise<void> {
    const sources = await this.sources(workspace);
    await this.observeSources(workspace.organizationId, workspace.creatorUserId, sources.names, sources.ids, false,
      renew && (workspace.state === "creating" || workspace.state === "starting"));
  }

  /** proof comes only from a live creator, worker token or room/session database
   * read. Never accept these revisions from request bodies or a cached client. */
  async continueWorkspace(workspace: CloudV2Workspace, proof?: CloudSourceProof): Promise<CloudSourceContinuation> {
    if (workspace.state !== "running") {
      await this.workspace(workspace);
      return { recheckAt: this.now() + CLOUD_SOURCE_ADMISSION_MS };
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
      const value: CloudSourceContinuation = { recheckAt: Math.min(...observations.map(value => value.recheckAt)),
        graceUntil: Math.min(...observations.map(value => value.until)) };
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

/** Removes the other recipe checkouts a v3 image starts with, before the
 * worker or any agent can reach them. Idempotent across create retries; a
 * parent owner directory goes only when nothing else is left in it.
 *
 * Each checkout's Git data goes first, so nothing left behind can be used
 * for Git, and then the tree leaves its path in one rename. Deleting the
 * files took 16.6 s for Withso/zeros on a restored disk, so that finishes in
 * the background, off the create. The creator can read every repository of
 * such an image, so the files gain no reader while they are deleted. */
export function pruneCloudRepositories(repositories: readonly string[]): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const steps = repositories.map(repository => {
    if (!repositorySchema.safeParse(repository).success || repository.split("/").some(part => part === "." || part === ".."))
      throw new Error("Invalid repository");
    const directory = `/home/user/${repository}`;
    return `if [ -L ${q(directory)} ]; then rm -f -- ${q(directory)}; elif [ -e ${q(directory)} ]; then `
      + `rm -rf -- ${q(`${directory}/.git`)} && mv -T -- ${q(directory)} "$trash/$((n += 1))"; fi`
      + ` && { rmdir -- ${q(directory.slice(0, directory.lastIndexOf("/")))} 2>/dev/null || true; }`;
  });
  return `bash -lc ${q(["set -eu", "trash=$(mktemp -d /home/user/.zeros-pruned.XXXXXXXX)", "n=0", ...steps,
    // Detached with its own output, so the command returns at once.
    'setsid nohup nice -n 19 rm -rf -- "$trash" >/dev/null 2>&1 </dev/null &'].join("\n"))}`;
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
