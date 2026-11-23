// A workspace's submodules at create (C4): the plan for its own base commit, composed with its creator's
// access, and what the project's copy holds. Persisted per workspace repository in
// cloud_v2_workspace_submodules (0264):
//   fetch     the plan, readable by the creator: the worker brings its checkouts there, and these are the
//             only submodule repositories a (read-only) token is minted for;
//   readable  in the copy, readable by the creator, not in this commit's plan;
//   skipped   named to the person, with why.
// A copy holding a submodule the creator can't read is never forked for the workspace: the copy also holds
// what its setup derived from that submodule. The create takes the direct path instead.
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { createSelectedCloudGithubTokens } from "./github-selected-tokens.js";
import type { CloudV2Workspace } from "./store.js";
import { requireWorkspaceCreator } from "./workspace-access.js";
import { workspaceTokenSource, type WorkerSubmodule } from "./workspace-repositories.js";
import type { ReadyCopySubmodule } from "./ready-copies.js";
import { composeSubmodulePlan, type SubmoduleLevel, type SubmodulePlan } from "./submodules.js";

export type WorkspaceSubmoduleRow = {
  position: number; path: string; status: "fetch" | "readable" | "skipped";
  repository?: string; repositoryId?: string; commit?: string; gitDir?: string; reason?: string;
  /** GitHub reported it public at this create: fetched with no credential, never a token target. */
  public?: true;
};
/** Create-time resolution is a safety net, never the plan: past this, submodules stay at the copy's commits. */
export const WORKSPACE_SUBMODULE_RESOLVE_MS = 8_000;

export type WorkspaceSubmoduleRepository = {
  position: number; repository: string; repositoryId: string; baseCommit: string | null; fetchSubmodules: boolean;
  /** The project's ready copy: the commit it cloned and what it fetched for this repository. */
  copy: { commit: string | null; submodules: readonly ReadyCopySubmodule[] } | null;
};

/** What a create passes for each project repository, in position order. */
export type WorkspaceSubmoduleRepositoryInput = Omit<WorkspaceSubmoduleRepository, "copy">;

const TIMED_OUT: unique symbol = Symbol("timed out");
const FAILED: unique symbol = Symbol("failed");
const bounded = <T>(work: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
  work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/**
 * One repository's rows. The copy's fetched submodules are checked as the creator by id; a base that moved
 * since the build is also resolved now, with the creator's access, alongside. Both run within one bound.
 * Past it, or on a GitHub failure, the copy's commits are kept for what the creator was shown to read, and
 * the reason is named. A submodule whose access is unknown is treated as unreadable: it is skipped, and
 * the copy is not forked.
 */
export async function resolveWorkspaceSubmodules(entry: WorkspaceSubmoduleRepository, deps: {
  level(repository: { repository: string; repositoryId: string }, commit: string): Promise<SubmoduleLevel>;
  /** The creator's GitHub resolving a repository by name: its id and whether GitHub says it is public, or null
   * when they can't read it. */
  resolve(repository: string): Promise<{ repositoryId: string; public: boolean } | null>;
  /** The creator's access to a known private repository (the source authority's cached check); throws when denied. */
  readable(target: { repository: string; repositoryId: string }): Promise<void>;
  /** GitHub's answer now, by id with the creator's own GitHub, for a repository the build saw public. Asked on
   * every create and never remembered, so one that turned private meets the access check again. */
  visibility(target: { repository: string; repositoryId: string }): Promise<"public" | "private">;
  boundMs?: number;
}): Promise<WorkspaceSubmoduleRow[]> {
  if (!entry.fetchSubmodules) return [];
  const deadline = Date.now() + (deps.boundMs ?? WORKSPACE_SUBMODULE_RESOLVE_MS);
  const copy = entry.copy?.submodules ?? [];
  const fetched = copy.filter(row => row.fetched && row.repository && row.repositoryId && row.commit);
  const moved = entry.baseCommit !== null && entry.baseCommit !== (entry.copy?.commit ?? null);
  // One check per repository, shared by the copy's rows and the plan's names it already knows. One the build
  // saw public is public only if GitHub still says so now; otherwise (private now, or no answer) it takes the
  // private check, so unknown visibility is never read as public.
  const checks = new Map<string, Promise<"public" | "readable" | false>>();
  const wasPublic = new Set(fetched.filter(row => row.public).map(row => row.repositoryId!));
  const check = (repository: string, repositoryId: string) => {
    let pending = checks.get(repositoryId);
    if (!pending) {
      const target = { repository, repositoryId };
      pending = (async (): Promise<"public" | "readable" | false> => {
        if (wasPublic.has(repositoryId) && await deps.visibility(target).catch(() => "private") === "public") return "public";
        return deps.readable(target).then(() => "readable" as const, () => false as const);
      })();
      checks.set(repositoryId, pending);
    }
    return pending;
  };
  const known = new Map(fetched.map(row => [row.repository!, row.repositoryId!]));
  const plan = moved ? bounded(composeSubmodulePlan({ root: { repository: entry.repository, repositoryId: entry.repositoryId, commit: entry.baseCommit! },
    level: deps.level,
    access: async repository => {
      const id = known.get(repository);
      if (id) {
        const seen = await check(repository, id);
        return seen === "public" ? { repositoryId: id, public: true } : seen ? id : null;
      }
      return deps.resolve(repository).catch(() => null);
    } }), deadline).catch((): typeof FAILED => FAILED) : Promise.resolve(null);
  const copyChecks = Promise.all(fetched.map(async row => ({ row, readable: await bounded(check(row.repository!, row.repositoryId!), deadline) })));
  const [resolved, checked] = await Promise.all([plan, copyChecks]);
  const composed: SubmodulePlan | null = resolved === TIMED_OUT || resolved === FAILED ? null : resolved;
  const rows: WorkspaceSubmoduleRow[] = [], seen = new Set<string>(), position = entry.position;
  const add = (row: Omit<WorkspaceSubmoduleRow, "position">) => { if (!seen.has(row.path)) { seen.add(row.path); rows.push({ position, ...row }); } };
  if (composed) {
    for (const submodule of composed.submodules) add({ path: submodule.path, status: "fetch", repository: submodule.repository,
      repositoryId: submodule.repositoryId, commit: submodule.commit, gitDir: submodule.gitDir, ...(submodule.public ? { public: true as const } : {}) });
    for (const skipped of composed.skipped) add({ path: skipped.path, status: "skipped", ...(skipped.repository ? { repository: skipped.repository } : {}), reason: skipped.reason });
    for (const notice of composed.notices) add({ path: ".gitmodules", status: "skipped", reason: notice });
  } else if (moved) add({ path: ".gitmodules", status: "skipped",
    reason: `kept at the project's build: GitHub could not be read${resolved === TIMED_OUT ? " in time" : ""}` });
  for (const { row, readable } of checked) {
    const seen = readable === "public" ? { public: true as const } : {};
    const target = { repository: row.repository!, repositoryId: row.repositoryId! };
    if (readable === TIMED_OUT) add({ path: row.path, status: "skipped", ...target, reason: "access could not be checked in time" });
    else if (!readable) add({ path: row.path, status: "skipped", ...target, reason: "no access" });
    // Unmoved, or unresolved in time: the copy's own commits are the plan.
    else if (!composed && row.gitDir) add({ path: row.path, status: "fetch", ...target, commit: row.commit!, gitDir: row.gitDir, ...seen });
    else add({ path: row.path, status: "readable", ...target, ...seen });
  }
  if (!composed) for (const row of copy) if (!row.fetched)
    add({ path: row.path, status: "skipped", ...(row.repository ? { repository: row.repository } : {}), reason: row.reason ?? "not fetched" });
  return rows;
}

export async function insertWorkspaceSubmodules(tx: Tx, workspaceId: string, rows: readonly WorkspaceSubmoduleRow[]): Promise<void> {
  for (const row of rows)
    await tx.query(`INSERT INTO cloud_v2_workspace_submodules (workspace_id, position, path, status, repository, repository_id, commit, git_dir, reason, public)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (workspace_id, position, path) DO NOTHING`,
      [workspaceId, row.position, row.path, row.status, row.repository ?? null, row.repositoryId ?? null, row.commit ?? null, row.gitDir ?? null,
        row.reason?.slice(0, 200) ?? null, row.public === true]);
}

/** The repository a submodule token is minted for: only a private 'fetch' row of this workspace, by name. A public
 * one needs none and never gets one. */
export async function workspaceSubmoduleSource(tx: Tx, workspaceId: string, repository: string): Promise<{ repository: string; repositoryId: string } | null> {
  const { rows } = await tx.query<{ repository: string; repositoryId: string }>(`SELECT repository, repository_id AS "repositoryId"
    FROM cloud_v2_workspace_submodules WHERE workspace_id=$1 AND status='fetch' AND NOT public AND repository=lower($2) LIMIT 1`, [workspaceId, repository]);
  return rows[0] ?? null;
}

/** The workspace broker's cache keeps a token no longer than this (as for a user token). */
const TOKEN_CACHE_MS = 120_000;

/**
 * A token for a repository a creator's workspace names that is not its first: another of its own repositories
 * (the creator's user token, bounded only by their GitHub access and the App), or a submodule it fetches. A
 * submodule's is an installation token of the creator's installation for that one repository, contents and
 * metadata read only (mintContentsRead), and for Git alone. A PAT gets none. Anything else is refused.
 */
export async function workspaceRepositoryToken(pool: pg.Pool, token: ReturnType<typeof createSelectedCloudGithubTokens>, workspace: CloudV2Workspace,
  repository: string, purpose: "git" | "gh", beforeRelease: () => Promise<void>, failedTokenSha256?: string): Promise<{ token: string; expiresAt: number }> {
  requireWorkspaceCreator(workspace);
  const scope = { organizationId: workspace.organizationId, userId: workspace.creatorUserId };
  const target = await withSystemTx(pool, tx => workspaceTokenSource(tx, workspace.id, repository));
  if (target) return token(scope, target, "user", purpose, beforeRelease, failedTokenSha256);
  const submodule = purpose === "git" ? await withSystemTx(pool, tx => workspaceSubmoduleSource(tx, workspace.id, repository)) : null;
  if (!submodule) throw new HttpError(403, "github_repository_access_required", "This repository is not part of this workspace.");
  return readOnlyToken(await token(scope, submodule, "read", "sync", beforeRelease, failedTokenSha256));
}
/** A submodule's read-only token as the worker caches it. */
export const readOnlyToken = (granted: { token: string; expiresAt: number }) =>
  ({ token: granted.token, expiresAt: Math.min(granted.expiresAt, Date.now() + TOKEN_CACHE_MS) });

/** Whether a copy may be forked for this workspace: every submodule the copy fetched is one its creator can read
 * (or that GitHub said was public at this create). A fetched row with no repository id names nothing a create
 * could have checked, so it counts as unreadable and the copy is not forked. */
export async function copySubmodulesReadable(tx: Tx, workspaceId: string, copy: readonly { submodules?: readonly ReadyCopySubmodule[] }[]): Promise<boolean> {
  const fetched = copy.flatMap(entry => (entry.submodules ?? []).filter(row => row.fetched).map(row => row.repositoryId ?? ""));
  if (!fetched.length) return true;
  const { rows } = await tx.query<{ id: string }>(`SELECT DISTINCT repository_id AS id FROM cloud_v2_workspace_submodules
    WHERE workspace_id=$1 AND status IN ('fetch','readable') AND repository_id IS NOT NULL`, [workspaceId]);
  const readable = new Set(rows.map(row => row.id));
  return fetched.every(id => readable.has(id));
}

/** The plan delivered to the worker (workspace-submodules-v1), parents first: read by workerRepositories in the
 * statement the configuration already makes, never a statement of its own. */
export function workerSubmodules(layout: { submodules?: WorkerSubmodule[] }): { submodules?: WorkerSubmodule[] } {
  return layout.submodules?.length ? { submodules: layout.submodules.slice(0, 320) } : {};
}

/** The reason a creator signed in with a personal access token fetches no submodule. */
export const SUBMODULES_NEED_APP_SIGN_IN = "submodules need a GitHub sign-in through the Zeros App; a personal access token can't fetch them read-only";

/**
 * A read-only submodule token is an installation token, which a personal access token is never turned into.
 * Such a creator's would-be fetches stay readable (they can read them, so the copy may still be forked for
 * them, at its commits) and the reason is named once.
 */
export function withoutReadOnlyToken(rows: readonly WorkspaceSubmoduleRow[], pat: boolean): WorkspaceSubmoduleRow[] {
  // A public submodule needs no token, so a PAT fetches it as anyone would.
  const needsToken = (row: WorkspaceSubmoduleRow) => row.status === "fetch" && !row.public;
  if (!pat || !rows.some(needsToken)) return [...rows];
  const positions = [...new Set(rows.filter(needsToken).map(row => row.position))];
  const readable = ({ commit: _commit, gitDir: _gitDir, ...row }: WorkspaceSubmoduleRow): WorkspaceSubmoduleRow => ({ ...row, status: "readable" });
  return [...rows.map(row => needsToken(row) ? readable(row) : row),
    ...positions.filter(position => !rows.some(row => row.position === position && row.path === ".gitmodules"))
      .map(position => ({ position, path: ".gitmodules", status: "skipped" as const, reason: SUBMODULES_NEED_APP_SIGN_IN }))];
}

/** One sentence naming every submodule a create skipped and why, for the person; null when none. */
export function workspaceSubmoduleNotice(rows: readonly WorkspaceSubmoduleRow[]): string | null {
  const skipped = rows.filter(row => row.status === "skipped");
  if (!skipped.length) return null;
  const named = skipped.slice(0, 8).map(row => `${row.path} (${row.reason ?? "not fetched"})`).join(", ");
  return `Some submodules weren't fetched: ${named}${skipped.length > 8 ? `, and ${skipped.length - 8} more` : ""}.`;
}

/**
 * C4: the lifecycle's read-only token for one submodule a workspace fetches (its restore clones and fetches with it):
 * only for a planned, non-public submodule ('fetch' row), minted as the worker's own route mints it, never for any
 * other repository, the workspace's own included. `mint` makes the installation token (as the actor in shared
 * execution, else the creator).
 */
export function lifecycleSubmoduleToken<W extends { id: string }>(pool: pg.Pool,
  mint: (workspace: W, target: { repository: string; repositoryId: string }) => Promise<{ token: string; expiresAt: number }>) {
  return async (workspace: W, repository: string): Promise<{ token: string; expiresAt: number }> => {
    const target = await withSystemTx(pool, tx => workspaceSubmoduleSource(tx, workspace.id, repository));
    if (!target) throw new HttpError(403, "github_repository_access_required", "This repository is not a submodule this workspace fetches.");
    return readOnlyToken(await mint(workspace, target));
  };
}
