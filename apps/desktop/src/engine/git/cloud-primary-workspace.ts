import { readFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-exec";
import { getWorkspaceById, insertWorkspaceWithMetadata, updateWorkspace } from "./state";
import { readOriginUrl, repoSlugFromOriginUrl } from "./repo";
import type { Workspace } from "./types";
import { CloudWorkspaceCheckoutSourceSchema } from "@zeros/protocol/cloud-computer-v2";
import { allocateWorkspaceBranch } from "./worktree";

/** A cloud allocation owns its primary checkout. Retain the public local-main
 * engine alias, but give normal Git/review code a real, durable workspace row.
 * Only the attested engine startup calls this; desktop roots remain synthetic. */
export async function ensureCloudPrimaryWorkspace(
  root: string,
  owner: { workspaceId: string; organizationId: string },
): Promise<Workspace> {
  const prior = getWorkspaceById("local-main");
  if (prior) {
    if (
      prior.canonicalId !== owner.workspaceId ||
      prior.organizationId !== owner.organizationId ||
      prior.path !== root ||
      prior.placement !== "cloud"
    )
      throw new Error(
        "Cloud checkout identity does not match its workspace record",
      );
    if (prior.baseBranch && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(prior.baseBranch)) return prior;
  }
  const git = (args: string[]) =>
    runGit(root, args).then((result) => result.stdout.trim());
  await git(["rev-parse", "HEAD"]);
  const acceptedJson = await git(["config", "--local", "--no-includes", "--get", "zeros.cloud-source"]).catch(() => "");
  const accepted = acceptedJson ? CloudWorkspaceCheckoutSourceSchema.parse(JSON.parse(acceptedJson)) : null;
  // Setup validated the accepted commit before hooks. Hooks and admitted
  // recovery may advance HEAD; registering metadata must preserve that work.
  let branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
    () => "",
  );
  const fetched = await readFile(
    path.join(root, ".git", "FETCH_HEAD"),
    "utf8",
  ).catch(() => "");
  const source = /^([0-9a-f]{40,64})\t[^\t]*\tbranch '([^'\r\n]+)' of /m.exec(
    fetched,
  );
  // New Computer generations carry admission metadata. Older checkouts can
  // recover a named base from Git, but must never display a SHA as the target.
  const baseBranch = accepted?.targetBranch ?? source?.[2] ?? (
    (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).replace(/^origin\//, "") ||
    (await git(["rev-parse", "--verify", "refs/heads/main"]).catch(() => "") ? "main" : ""));
  if (!baseBranch || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseBranch))
    throw new Error("Cloud checkout target branch is unavailable");
  await git(["check-ref-format", "--branch", baseBranch]);
  if (prior) {
    // Repair only the legacy SHA/empty target. Never recreate the row or move
    // HEAD, the index, its saved PR, or a user's valid named target on restart.
    updateWorkspace(prior.id, { baseBranch });
    return getWorkspaceById(prior.id)!;
  }
  if (source && !accepted) {
    const ref = `refs/remotes/origin/${baseBranch}`;
    if (!(await git(["rev-parse", "--verify", ref]).catch(() => "")))
      await git(["update-ref", ref, source[1]!]);
  }
  const repoSlug = repoSlugFromOriginUrl(await readOriginUrl(root));
  if (!branch || (accepted?.kind === "default" && branch === accepted.headBranch)) {
    branch = accepted ? await allocateWorkspaceBranch(root, repoSlug) : `zeros/cloud-${owner.workspaceId}`;
    // No reset, forced checkout, clean, or worktree creation: an interrupted
    // bootstrap and its index/untracked files remain recoverable.
    await git(["checkout", "-b", branch]);
  }
  const now = Date.now();
  const workspace: Workspace = {
    id: "local-main",
    canonicalId: owner.workspaceId,
    organizationId: owner.organizationId,
    placement: "cloud",
    kind: "code",
    viewMode: "code",
    repoSlug,
    path: root,
    repoRoot: root,
    branch,
    baseBranch,
    status: accepted?.pullRequest ? "in-review" : "in-progress",
    createdAt: now,
    archivedAt: null,
    stashRef: null,
    prNumber: accepted?.pullRequest?.number ?? null,
    prState: accepted?.pullRequest?.state ?? null,
    prUrl: accepted?.pullRequest?.url ?? null,
    agentId: null,
    lastActiveAt: now,
    setupState: "passed",
  };
  insertWorkspaceWithMetadata(workspace, { "cloud.primary": "true" });
  return workspace;
}
