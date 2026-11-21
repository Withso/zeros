import {
  CLOUD_GITHUB_PR_OPERATIONS,
  CLOUD_GITHUB_PR_WRITES,
  CloudGithubPrRequestSchema,
  CloudGithubPrResponseSchema,
  type CloudGithubPrAuthority,
} from "@zeros/protocol/cloud-github-pr";
import { sharingFor } from "./team-sharing-registry";
import {
  cloudGithubPrCatalogContext,
  cloudGithubPrCatalogKeys,
  hasCloudGithubPrCapability,
  onCloudGithubPrContextChange,
} from "./cloud-github-pr-capability";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import {
  cloudTargetForValue,
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "./bridge/cloud-workspace-key";
import { cloudRepositoryLayout } from "./bridge/cloud-repository-routing";
import { forgetPrCachesForWorkspace } from "../shell/pr/pr-cache-forget";
import { forgetReviewCachesForFolders } from "../features/code-review/review-cache-forget";
import { invalidateCloudGithubPrScope } from "./cloud-github-pr-scope";

type Revision = { headSha: string; baseSha: string };
type Snapshot = {
  authority: CloudGithubPrAuthority;
  revisions: Map<number, Revision>;
  catalog: ReturnType<typeof cloudGithubPrCatalogContext>;
};
const snapshots = new Map<string, Snapshot>(),
  flights = new Map<string, Promise<unknown>>(),
  scopeEpochs = new Map<string, number>();
let epoch = 0;
// Loaded lazily to avoid an import cycle, once, so a fan-out's requests share it.
let transportModule: Promise<typeof import("./cloud-workspaces")> | undefined;
const transport = () => (transportModule ??= import("./cloud-workspaces"));
const changed = () =>
  new Error(
    "Your GitHub connection or workspace changed. Refresh before continuing.",
  );
const same = (a: CloudGithubPrAuthority, b: CloudGithubPrAuthority) =>
  JSON.stringify(a) === JSON.stringify(b);
const samePresentation = (a: CloudGithubPrAuthority, b: CloudGithubPrAuthority) =>
  a.connectionGeneration === b.connectionGeneration && a.repositoryId === b.repositoryId &&
  a.repository === b.repository && a.branch === b.branch && a.baseBranch === b.baseBranch;
const errorCodes: Record<string, string> = {
  github_connection_required: "NOT_AUTHENTICATED",
  github_authorization_required: "NOT_AUTHENTICATED",
  github_authorization_expired: "NOT_AUTHENTICATED",
  github_cloud_access_denied: "GITHUB_FORBIDDEN_SCOPE",
  github_cloud_write_denied: "GITHUB_FORBIDDEN_SCOPE",
  github_repository_unavailable: "GITHUB_FORBIDDEN_SCOPE",
  github_installation_required: "GITHUB_REPO_NOT_INSTALLED",
  github_installation_suspended: "GITHUB_INSTALLATION_SUSPENDED",
  github_sso_required: "GITHUB_SSO_REQUIRED",
  github_rate_limited: "GITHUB_RATE_LIMITED",
  github_unavailable: "GITHUB_API_ERROR",
};

export function cloudGithubPrAvailable(target: CloudWorkspaceTarget): boolean {
  return hasCloudGithubPrCapability(target);
}
/** `repository`: one repository of a workspace of several, by its key and name; its
 * authority and revisions are its own. The first repository of a workspace of one
 * keeps the workspace's key. */
export type CloudGithubPrRepository = { key: string; repository: string };
export function cloudGithubPrAuthority(
  target: CloudWorkspaceTarget,
  repository?: CloudGithubPrRepository,
): CloudGithubPrAuthority | undefined {
  const snapshot = snapshots.get(repository?.key ?? cloudWorkspaceKey(target));
  const authority = snapshot?.catalog === cloudGithubPrCatalogContext(target) ? snapshot?.authority : undefined;
  return authority ? { ...authority } : undefined;
}

export type CloudGithubPrRoute = { target: CloudWorkspaceTarget; repository?: CloudGithubPrRepository };
/** Only `gh.authStatus` is about the connection; every other operation is one repository's. */
const CONNECTION_OPERATIONS = new Set(["gh.authStatus"]);

/**
 * The repository a pull request request for this workspace id is for, or null
 * for an id that is not a cloud workspace. Every cloud pull request request and
 * authority read goes through here. In a workspace of several repositories:
 * - a repository's key (`<key>/<folder>`) is that repository;
 * - the workspace key with `repository` set is the repository of that name;
 * - the bare workspace key is the first repository for connection reads, and
 *   `gh.prSync` syncs every repository (see `requestCloudGithubPrFor`);
 * - anything else is refused, never served as the first repository: a pull
 *   request number on the bare key may be another repository's (the combined
 *   mark), and a folder that is not a repository names none.
 * Each repository's state is kept under its own key. A workspace of one
 * repository keeps its workspace key, as before.
 */
export function cloudGithubPrRoute(workspaceId: unknown, op: string, input: Record<string, unknown> = {}): CloudGithubPrRoute | null {
  const target = cloudTargetForValue(workspaceId);
  if (!target) return null;
  const folder = parseCloudWorkspaceKey(workspaceId)?.relativePath;
  const layout = cloudRepositoryLayout(target);
  const named = typeof input.repository === "string" ? input.repository.toLowerCase() : null;
  const root = cloudWorkspaceKey(target);
  const scope = (entry: { repository: string; folder: string }): CloudGithubPrRoute =>
    ({ target, repository: { key: `${root}/${entry.folder}`, repository: entry.repository } });
  if (folder) {
    const entry = layout?.repositories.find(row => row.folder === folder);
    if (!entry || (named !== null && named !== entry.repository.toLowerCase()))
      throw new Error("This folder is not one of the workspace's repositories.");
    return scope(entry);
  }
  if (!layout) return { target };
  if (named !== null) {
    const entry = layout.repositories.find(row => row.repository.toLowerCase() === named);
    if (!entry) throw new Error("This repository is not part of this workspace.");
    return scope(entry);
  }
  if (CONNECTION_OPERATIONS.has(op) || op === "gh.prSync") return scope(layout.repositories[0]!);
  throw new Error("Choose which of this workspace's repositories this pull request is in.");
}

/** A workspace id's pull request request, or null for a Local id. A refusal is a rejected promise. */
export function requestCloudGithubPrFor(workspaceId: unknown, op: string, input: Record<string, unknown> = {}): Promise<unknown> | null {
  let scope: CloudGithubPrRoute | null;
  try { scope = cloudGithubPrRoute(workspaceId, op, input); }
  catch (error) { return Promise.reject(error); }
  if (!scope) return null;
  const layout = cloudRepositoryLayout(scope.target);
  if (op === "gh.prSync" && layout && !parseCloudWorkspaceKey(workspaceId)?.relativePath && typeof input.repository !== "string") {
    // Syncing the workspace syncs each repository, so a pull request opened in any of them is found.
    const root = cloudWorkspaceKey(scope.target);
    return Promise.all(layout.repositories.map(entry =>
      requestCloudGithubPr(scope.target, op, input, { key: `${root}/${entry.folder}`, repository: entry.repository })))
      .then(results => results.find(result => result != null) ?? null);
  }
  return requestCloudGithubPr(scope.target, op, input, ...(scope.repository ? [scope.repository] : []));
}

/** The last confirmed authority for a workspace id, resolved the same way as its requests. */
export function cloudGithubPrAuthorityFor(workspaceId: unknown, op = "gh.repoAccess"): CloudGithubPrAuthority | undefined {
  let scope: CloudGithubPrRoute | null;
  try { scope = cloudGithubPrRoute(workspaceId, op); } catch { return undefined; }
  return scope ? cloudGithubPrAuthority(scope.target, scope.repository) : undefined;
}
function forgetPresentation(key: string): void {
  forgetPrCachesForWorkspace(key);
  forgetReviewCachesForFolders(
    (folder) => folder === key || folder.startsWith(`${key}/`),
  );
  invalidateCloudGithubPrScope(key);
}
onCloudGithubPrContextChange((key, retainPresentation) => {
  // A new HEAD invalidates request authority, not the same branch's last confirmed presentation.
  if (retainPresentation) return;
  for (const each of [...snapshots.keys()])
    if (each === key || each.startsWith(`${key}/`)) { snapshots.delete(each); if (each !== key) forgetPresentation(each); }
  forgetPresentation(key);
});
export function clearCloudGithubPr(organizationId?: string): void {
  if (organizationId)
    scopeEpochs.set(organizationId, (scopeEpochs.get(organizationId) ?? 0) + 1);
  else {
    epoch++;
    scopeEpochs.clear();
  }
  for (const key of new Set([...snapshots.keys(), ...cloudGithubPrCatalogKeys()])) {
    if (!organizationId || key.startsWith(`cloud://${organizationId}/`)) {
      snapshots.delete(key);
      forgetPresentation(key);
    }
  }
  // Clearing deduplication permits new reads; epochs still fence old replies.
  for (const key of flights.keys())
    if (!organizationId || key.includes(organizationId)) flights.delete(key);
  if (scopeEpochs.size > 128) {
    epoch++;
    scopeEpochs.clear();
    invalidateCloudGithubPrScope();
  } else invalidateCloudGithubPrScope(organizationId);
}

/** Published PR operations bypass the VM transport, so a read cannot wake a stopped worker. */
export function requestCloudGithubPr(
  target: CloudWorkspaceTarget,
  op: string,
  input: Record<string, unknown>,
  repository?: CloudGithubPrRepository,
): Promise<unknown> {
  if (!CLOUD_GITHUB_PR_OPERATIONS.has(op) || !cloudGithubPrAvailable(target))
    return Promise.reject(
      new Error(
        "Pull requests are not available for this cloud workspace. Update its cloud runtime and try again.",
      ),
    );
  const key = repository?.key ?? cloudWorkspaceKey(target),
    account = getOrganizationStoreGeneration(),
    startEpoch = epoch,
    scopeEpoch = scopeEpochs.get(target.organizationId) ?? 0;
  const context = cloudGithubPrCatalogContext(target);
  const current = () =>
    account === getOrganizationStoreGeneration() &&
    epoch === startEpoch &&
    scopeEpoch === (scopeEpochs.get(target.organizationId) ?? 0) &&
    context === cloudGithubPrCatalogContext(target);
  const captured = snapshots.get(key),
    write = CLOUD_GITHUB_PR_WRITES.has(op);
  const { workspaceId: _workspaceId, repository: _repository, ...params } = input;
  // A caller's remote is only a Local hint; cloud uses the server-pinned repository.
  if (op === "gh.prList") {
    delete params.owner;
    delete params.repo;
    delete params.originUrl;
  }
  if (write) {
    if (!captured || captured.catalog !== context)
      return Promise.reject(
        new Error("Refresh GitHub status before applying this action."),
      );
    if (typeof params.prNumber === "number") {
      const revision = captured.revisions.get(params.prNumber);
      if (!revision)
        return Promise.reject(
          new Error("Refresh this pull request before applying this action."),
        );
      params.headSha ??= params.commitSha ?? revision.headSha;
      params.baseSha ??= revision.baseSha;
      delete params.commitSha;
    }
    if (op === "gh.prComment") params.kind ??= "conversation";
  }
  const parsed = CloudGithubPrRequestSchema.safeParse({
    op,
    params,
    ...(write ? { expected: captured!.authority } : {}),
  });
  if (!parsed.success)
    return Promise.reject(
      new Error(
        "This cloud pull request action is not supported. Refresh and try again.",
      ),
    );
  const flightKey = JSON.stringify([
    account,
    startEpoch,
    scopeEpoch,
    key,
    context,
    parsed.data,
  ]);
  const existing = !write && flights.get(flightKey);
  if (existing) return existing;
  if (flights.size >= 256)
    return Promise.reject(new Error("GitHub is busy. Try again shortly."));
  const pending = transport()
    .then(({ cloudAccountRequest }) => {
      if (!current()) throw changed();
      return cloudAccountRequest(
        `/v1/cloud-v2/workspaces/${target.workspaceId}/github`,
        CloudGithubPrResponseSchema,
        { body: repository ? { ...parsed.data, repository: repository.repository } : parsed.data, idempotencyKey: crypto.randomUUID() },
        {
          ...sharingFor(target.workspaceId),
          githubPullRequest: true,
          ...(write ? { mutationReceipt: true } : {}),
        },
      );
    })
    .then(async (response) => {
      if (write && (!current() || response.authorityCurrent === false)) {
        // Preserve the successful receipt without publishing its snapshot into a different GitHub authority.
        if (current()) {
          snapshots.delete(key);
          forgetPresentation(key);
        }
        return response.result;
      }
      if (!current() || response.authorityCurrent === false) throw changed();
      const live = snapshots.get(key);
      if (
        live &&
        live !== captured &&
        !same(live.authority, response.authority)
      )
        throw changed();
      if (write && !same(captured!.authority, response.authority))
        throw changed();
      const matching = live && live.catalog === context && same(live.authority, response.authority);
      const snapshot: Snapshot = matching
        ? live
        : { authority: response.authority, revisions: new Map(), catalog: context };
      if (live && !samePresentation(live.authority, response.authority)) forgetPresentation(key);
      const result = response.result;
      if (
        result &&
        typeof result === "object" &&
        "headSha" in result &&
        "baseSha" in result &&
        typeof result.headSha === "string" &&
        typeof result.baseSha === "string" &&
        /^[a-f0-9]{40}$/.test(result.headSha) &&
        /^[a-f0-9]{40}$/.test(result.baseSha)
      ) {
        const number = "number" in result ? result.number : params.prNumber;
        if (typeof number === "number") {
          snapshot.revisions.set(number, {
            headSha: result.headSha,
            baseSha: result.baseSha,
          });
          if (snapshot.revisions.size > 16)
            snapshot.revisions.delete(snapshot.revisions.keys().next().value!);
        }
      }
      snapshots.delete(key);
      snapshots.set(key, snapshot);
      while (snapshots.size > 128)
        snapshots.delete(snapshots.keys().next().value!);
      // Load catalog refresh lazily to avoid an import cycle; unchanged PR reads need no catalog I/O.
      if (write || op === "gh.prSync")
        await import("../state/cloud-workspace-catalog")
          .then(({ refreshCloudWorkspace, cloudWorkspaceDocument }) =>
            write || prSyncChangesDocument(documentPullRequest(cloudWorkspaceDocument(target), repository), result) ? refreshCloudWorkspace(target) : undefined)
          .catch(() => {});
      if (!current() && !write) throw changed();
      return result;
    })
    .catch((error) => {
      if (
        current() &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        [
          "github_authorization_changed",
          "github_authorization_expired",
          "github_connection_required",
          "github_repository_unavailable",
          "github_cloud_access_denied",
          "not_found",
        ].includes(String(error.code))
      ) {
        snapshots.delete(key);
        forgetPresentation(key);
      }
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        Object.hasOwn(errorCodes, error.code)
      ) {
        const code = errorCodes[error.code]!;
        if (
          op === "gh.repoAccess" &&
          !["GITHUB_API_ERROR", "GITHUB_RATE_LIMITED"].includes(code)
        )
          return {
            state: "blocked",
            connected: code !== "NOT_AUTHENTICATED",
            code,
            message: error.message,
            remediation:
              "Check your cloud GitHub connection in Settings → Integrations.",
          };
        throw Object.assign(new Error(error.message), { code });
      }
      throw error;
    })
    .finally(() => {
      if (flights.get(flightKey) === pending) flights.delete(flightKey);
    });
  if (!write) flights.set(flightKey, pending);
  return pending;
}

/** Treat an unknown catalog or result as needing revalidation. */
function prSyncChangesDocument(github: { prNumber: number | null; prState: string | null; prUrl: string | null } | undefined, result: unknown): boolean {
  if (!github) return true;
  if (result === null || result === undefined) return github.prNumber !== null;
  if (typeof result !== "object") return true;
  const pr = result as { number?: unknown; url?: unknown; state?: unknown };
  return pr.number !== github.prNumber || pr.url !== github.prUrl || pr.state !== github.prState;
}

/** The pull request the document shows for this request's repository: its own entry for one of several. */
function documentPullRequest(document: { github?: Parameters<typeof prSyncChangesDocument>[0]; repositories?: { repository: string; github?: Parameters<typeof prSyncChangesDocument>[0] }[] } | undefined,
  repository: CloudGithubPrRepository | undefined): Parameters<typeof prSyncChangesDocument>[0] {
  if (!repository) return document?.github;
  return document?.repositories?.find(entry => entry.repository.toLowerCase() === repository.repository.toLowerCase())?.github;
}

