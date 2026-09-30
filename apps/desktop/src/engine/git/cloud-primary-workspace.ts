import { readFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git-exec";
import { getWorkspaceById, insertWorkspaceWithMetadata } from "./state";
import { readOriginUrl, repoSlugFromOriginUrl } from "./repo";
import type { Workspace } from "./types";

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
    return prior;
  }
  const git = (args: string[]) =>
    runGit(root, args).then((result) => result.stdout.trim());
  const head = await git(["rev-parse", "HEAD"]);
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
  // A pinned commit/PR may have no named base. Keep its exact baseline until
  // the user selects a target branch through the existing metadata picker.
  const baseBranch = source?.[2] ?? head;
  if (source) {
    await git(["check-ref-format", "--branch", baseBranch]);
    const ref = `refs/remotes/origin/${baseBranch}`;
    if (!(await git(["rev-parse", "--verify", ref]).catch(() => "")))
      await git(["update-ref", ref, source[1]!]);
  }
  if (!branch) {
    branch = `zeros/cloud-${owner.workspaceId}`;
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
    repoSlug: repoSlugFromOriginUrl(await readOriginUrl(root)),
    path: root,
    repoRoot: root,
    branch,
    baseBranch,
    status: "in-progress",
    createdAt: now,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: now,
    setupState: "passed",
  };
  insertWorkspaceWithMetadata(workspace, { "cloud.primary": "true" });
  return workspace;
}
