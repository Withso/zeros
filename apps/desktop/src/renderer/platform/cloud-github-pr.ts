import {
  CLOUD_GITHUB_PR_OPERATIONS,
  CLOUD_GITHUB_PR_WRITES,
  CloudGithubPrRequestSchema,
  CloudGithubPrResponseSchema,
  type CloudGithubPrAuthority,
} from "@zeros/protocol/cloud-github-pr";
import {
  cloudGithubPrCatalogContext,
  cloudGithubPrCatalogKeys,
  hasCloudGithubPrCapability,
  onCloudGithubPrContextChange,
} from "./cloud-github-pr-capability";
import { getOrganizationStoreGeneration } from "../features/team/team-store";
import {
  cloudWorkspaceKey,
  type CloudWorkspaceTarget,
} from "./bridge/cloud-workspace-key";
import { forgetPrCachesForWorkspace } from "../shell/pr/pr-cache-forget";
import { forgetReviewCachesForFolders } from "../features/code-review/review-cache-forget";
import { invalidateCloudGithubPrScope } from "./cloud-github-pr-scope";

type Revision = { headSha: string; baseSha: string };
type Snapshot = {
  authority: CloudGithubPrAuthority;
  revisions: Map<number, Revision>;
};
const snapshots = new Map<string, Snapshot>(),
  flights = new Map<string, Promise<unknown>>(),
  scopeEpochs = new Map<string, number>();
let epoch = 0;
const changed = () =>
  new Error(
    "Your GitHub connection or workspace changed. Refresh before continuing.",
  );
const same = (a: CloudGithubPrAuthority, b: CloudGithubPrAuthority) =>
  JSON.stringify(a) === JSON.stringify(b);
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
export function cloudGithubPrAuthority(
  target: CloudWorkspaceTarget,
): CloudGithubPrAuthority | undefined {
  const authority = snapshots.get(cloudWorkspaceKey(target))?.authority;
  return authority ? { ...authority } : undefined;
}
function forgetPresentation(key: string): void {
  forgetPrCachesForWorkspace(key);
  forgetReviewCachesForFolders(
    (folder) => folder === key || folder.startsWith(`${key}/`),
  );
  invalidateCloudGithubPrScope(key);
}
onCloudGithubPrContextChange((key) => {
  snapshots.delete(key);
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
  // A cleared flight is still fenced when it settles; callers may start a new read.
  for (const key of flights.keys())
    if (!organizationId || key.includes(organizationId)) flights.delete(key);
  if (scopeEpochs.size > 128) {
    epoch++;
    scopeEpochs.clear();
    invalidateCloudGithubPrScope();
  } else invalidateCloudGithubPrScope(organizationId);
}

/** Published PR operations bypass the VM transport. Reads keep a stopped VM
 * stopped; native Git operations still use its explicit worker admission. */
export function requestCloudGithubPr(
  target: CloudWorkspaceTarget,
  op: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!CLOUD_GITHUB_PR_OPERATIONS.has(op) || !cloudGithubPrAvailable(target))
    return Promise.reject(
      new Error(
        "Pull requests are not available for this cloud workspace. Update its cloud runtime and try again.",
      ),
    );
  const key = cloudWorkspaceKey(target),
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
  const { workspaceId: _workspaceId, ...params } = input;
  // Shared suggestion callers carry their displayed remote as a Local hint.
  // Cloud always resolves the server's pinned repository for this workspace.
  if (op === "gh.prList") {
    delete params.owner;
    delete params.repo;
    delete params.originUrl;
  }
  if (write) {
    if (!captured)
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
  const pending = import("./cloud-workspaces")
    .then(({ cloudAccountRequest }) => {
      if (!current()) throw changed();
      return cloudAccountRequest(
        `/v1/cloud-v2/workspaces/${target.workspaceId}/github`,
        CloudGithubPrResponseSchema,
        { body: parsed.data, idempotencyKey: crypto.randomUUID() },
        {
          githubPullRequest: true,
          ...(write ? { mutationReceipt: true } : {}),
        },
      );
    })
    .then(async (response) => {
      if (write && (!current() || response.authorityCurrent === false)) {
        // The original action succeeded. Do not publish its protected snapshot
        // into a different connection's mounted surfaces or encourage a retry.
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
      const matching = live && same(live.authority, response.authority);
      const snapshot: Snapshot = matching
        ? live
        : { authority: response.authority, revisions: new Map() };
      if (live && !matching) forgetPresentation(key);
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
      // The request boundary reads the catalog's pure projection. Loading the
      // refresh owner only after I/O avoids a Git → catalog → Git import cycle.
      if (write || op === "gh.prSync")
        await import("../state/cloud-workspace-catalog")
          .then(({ refreshCloudWorkspace }) => refreshCloudWorkspace(target))
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
