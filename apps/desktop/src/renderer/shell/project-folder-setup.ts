import {
  gitInitInPlace,
  workspaceInspectFolder,
  type InspectFolderResult,
} from "../platform/git";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { bridgeProjectUpsert } from "../platform/bridge/workspace-bridge";
import { normalizeProjectRoot, upsertProject } from "../state/projects-store";
import { notifyProjectsChanged } from "../state/use-projects";

const pending = new Map<string, Promise<InspectFolderResult>>();

/** User-initiated open/create only. Register, initialize if needed, and confirm
 * a usable worktree base. Reads on startup/resume must never call this helper. */
export function prepareProjectFolder(
  root: string,
  inspect?: InspectFolderResult,
): Promise<InspectFolderResult> {
  const key = normalizeProjectRoot(root);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = prepare(key, inspect).finally(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  pending.set(key, request);
  return request;
}

async function prepare(
  root: string,
  known?: InspectFolderResult,
): Promise<InspectFolderResult> {
  // A failed inspection is an error, never proof that Git is absent.
  const inspect = known ?? (await workspaceInspectFolder(root));
  const bridge = getActiveBridge();
  if (!bridge) throw new Error("Reconnect to Zeros and try again.");
  const project = upsertProject({
    repoRoot: root,
    originUrl: inspect.originUrl ?? undefined,
    isGitRepository: inspect.isRepo,
  });
  // Git initialization accepts only registered roots. The store's usual
  // fire-and-forget write-through is insufficient for this dependent mutation.
  await bridgeProjectUpsert(bridge, {
    repoRoot: project.repoRoot,
    repoSlug: project.repoSlug,
    name: project.name,
    originUrl: project.originUrl,
  });
  if (inspect.isRepo && inspect.hasCommits) {
    notifyProjectsChanged();
    return inspect;
  }
  await gitInitInPlace(root);
  const initialized = await workspaceInspectFolder(root);
  if (!initialized.isRepo || !initialized.hasCommits) {
    throw new Error("Git setup is incomplete. Try initializing again.");
  }
  upsertProject({
    repoRoot: root,
    originUrl: initialized.originUrl ?? undefined,
    isGitRepository: true,
  });
  notifyProjectsChanged();
  return initialized;
}
