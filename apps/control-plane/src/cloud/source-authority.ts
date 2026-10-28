import type pg from "pg";
import { z } from "zod";
import { withSystemTx } from "../db.js";
import { HttpError } from "../authz.js";
import type { GithubRepositoryAuthority, RepositoryRequest } from "../github-repository-authority.js";
import type { CloudV2Workspace } from "./store.js";

const repositorySchema = z.string().max(201).regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine(value => value.split("/").every(part => part !== "." && part !== ".."));
const repositoryIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
export const CloudSourceTargetSchema = z.object({ repository: repositorySchema, repositoryId: repositoryIdSchema }).strict();
export type CloudSourceTarget = z.infer<typeof CloudSourceTargetSchema>;
const LEASE_MS = 30_000;
const MAX_LEASES = 1024;
type SourceObservation = { scope: RepositoryRequest; fingerprint: string; until: number };

/** A brief, coalesced GitHub observation; durable identity is still re-read on
 * every use. Failed checks never retain stale access. Old disks/checkpoints
 * keep their original conservative source scope through every restore. */
export class CloudV2SourceAuthority {
  private readonly leases = new Map<string, { fingerprint: string; until: number }>();
  private readonly flights = new Map<string, Promise<void>>();
  constructor(private readonly pool: pg.Pool, private readonly github: Pick<GithubRepositoryAuthority, "check" | "fingerprintFor">,
    private readonly now = () => Date.now(),
    private readonly sourceTargets?: (workspace: CloudV2Workspace, sources: readonly string[]) => Promise<readonly CloudSourceTarget[]>) {}

  async repository(organizationId: string, userId: string, repository: string): Promise<void> {
    await this.observeRepository(organizationId, userId, repository);
  }

  /** Source-bearing responses can combine several repositories, just like
   * legacy disks. Every original observation must still authorize the set
   * when the complete decision finishes. */
  async repositories(organizationId: string, userId: string, repositories: readonly string[]): Promise<void> {
    await this.observeSources(organizationId, userId, repositories);
  }

  /** Server-recorded source identities, including source-bearing build logs. */
  async targets(organizationId: string, userId: string, targets: readonly CloudSourceTarget[]): Promise<void> {
    const parsed = z.array(CloudSourceTargetSchema).min(1).max(100).safeParse(targets);
    if (!parsed.success) throw new HttpError(409, "cloud_source_review_required", "The original source identities could not be verified. Existing data has been retained.");
    await this.observeSources(organizationId, userId, parsed.data.map(target => target.repository), parsed.data.map(target => target.repositoryId));
  }

  private async observeSources(organizationId: string, userId: string, repositories: readonly string[], ids?: readonly string[]): Promise<void> {
    const sources = z.array(repositorySchema).min(1).max(100).safeParse(repositories);
    if (!sources.success || ids && (ids.length !== repositories.length || !z.array(repositoryIdSchema).safeParse(ids).success))
      throw new HttpError(403, "github_repository_invalid", "Repository access could not be verified.");
    const observations: SourceObservation[] = [];
    for (const [index, repository] of sources.data.entries()) observations.push(await this.observeRepository(organizationId, userId, repository, ids?.[index]));
    const requireFresh = () => {
      if (observations.some(observation => observation.until <= this.now()))
        throw new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
    };
    requireFresh();
    for (const observation of observations) {
      if (await this.github.fingerprintFor(observation.scope) !== observation.fingerprint)
        throw new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
    }
    requireFresh();
  }

  private async observeRepository(organizationId: string, userId: string, repository: string, repositoryId?: string): Promise<SourceObservation> {
    const parsed = repositorySchema.safeParse(repository);
    if (!parsed.success) throw new HttpError(403, "github_repository_invalid", "Repository access could not be verified.");
    const [owner, name] = parsed.data.toLowerCase().split("/") as [string, string];
    const scope = { organizationId, userId, owner, repositories: [name], access: "read" as const, ...(repositoryId ? { repositoryIds: [repositoryId] } : {}) };
    const key = JSON.stringify([organizationId, userId, owner, name, repositoryId ?? null]);
    const fingerprint = await this.github.fingerprintFor(scope);
    const lease = this.leases.get(key);
    if (lease?.fingerprint === fingerprint && lease.until > this.now()) return { scope, ...lease };
    this.leases.delete(key);
    const pending = this.flights.get(key);
    if (pending) { await pending; return this.observeRepository(organizationId, userId, repository, repositoryId); }
    if (this.flights.size >= MAX_LEASES) throw new HttpError(503, "github_verification_busy", "Repository verification is busy. Try again.");
    // Lease begins before I/O; a slow provider must not create fresh authority
    // from an observation already older than its allowed lifetime.
    const until = this.now() + LEASE_MS;
    const flight = this.github.check(scope).then(verified => {
      if (verified !== fingerprint) throw new HttpError(409, "github_authorization_changed", "GitHub authorization changed. Try again.");
      if (this.leases.size >= MAX_LEASES) this.leases.delete(this.leases.keys().next().value!);
      this.leases.set(key, { fingerprint, until });
    });
    this.flights.set(key, flight);
    try { await flight; } finally { if (this.flights.get(key) === flight) this.flights.delete(key); }
    if (until <= this.now()) {
      this.leases.delete(key);
      throw new HttpError(503, "github_verification_expired", "Repository verification took too long. Try again.");
    }
    return { scope, fingerprint, until };
  }

  async workspace(workspace: CloudV2Workspace): Promise<void> {
    const { rows } = await withSystemTx(this.pool, tx => tx.query<{ source_repositories: unknown }>(
      `SELECT source_repositories FROM cloud_v2_workspaces
       WHERE id=$1 AND org_id=$2 AND creator_user_id=$3 AND state NOT IN ('deleted','deleting')`,
      [workspace.id, workspace.organizationId, workspace.creatorUserId]));
    const sources = z.array(repositorySchema).min(1).max(100).safeParse(rows[0]?.source_repositories);
    if (!sources.success || !sources.data.some(repo => repo.toLowerCase() === workspace.repository.toLowerCase()))
      throw new HttpError(409, "cloud_source_review_required", "This older workspace needs its source access verified. Its files have been retained.");
    // A legacy image can contain several owners' repositories. Later remote
    // checks must not extend an earlier observation or hide its reconnect.
    if (!this.sourceTargets) return this.repositories(workspace.organizationId, workspace.creatorUserId, sources.data);
    const targets = await this.sourceTargets(workspace, sources.data);
    if (targets.length !== sources.data.length || targets.some((target, index) => target.repository.toLowerCase() !== sources.data[index]!.toLowerCase() || !CloudSourceTargetSchema.safeParse(target).success))
      throw new HttpError(409, "cloud_source_review_required", "This workspace needs its original source identities verified. Its files have been retained.");
    await this.targets(workspace.organizationId, workspace.creatorUserId, targets);
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
