import { workspaceInspectFolder } from "../platform/git";
import { isCloudWorkspace } from "../platform/bridge/cloud-workspace-key";
import { getActiveBridge } from "../platform/bridge/active-bridge";
import { bridgeReconcileGithubRemote } from "../platform/bridge/workspace-bridge";
import {
  applyProjectGitInspection,
  applyNativeProjectOrigin,
  loadProjects,
  projectGitRevision,
  type Project,
} from "./projects-store";

const pending = new Map<string, Promise<boolean>>();

/** One inspection per exact owner in flight. The persisted project is the
 * last confirmed snapshot; a failed read never clears it. */
export function refreshProjectCapabilities(owner: Project, active: () => boolean = () => true): Promise<boolean> {
  if (isCloudWorkspace(owner.repoRoot)) return Promise.resolve(false);
  const key = JSON.stringify([owner.id, owner.repoRoot]);
  const current = pending.get(key);
  if (current) return current;
  const project = loadProjects().find(
    (row) => row.id === owner.id && row.repoRoot === owner.repoRoot,
  );
  if (!project) return Promise.resolve(false);
  const revision = projectGitRevision(project.id);
  const bridge = getActiveBridge();
  const request = workspaceInspectFolder(project.repoRoot)
    .then(async inspection => {
      if (!active() || getActiveBridge() !== bridge) return false;
      let changed = applyProjectGitInspection(project, revision, inspection);
      if (!inspection.isRepo || !bridge || bridge.status !== "connected") return changed;
      const current = loadProjects().find(row => row.id === project.id && row.repoRoot === project.repoRoot);
      if (!current) return changed;
      const currentRevision = projectGitRevision(current.id);
      try {
        const result = await bridgeReconcileGithubRemote(bridge, current.repoRoot);
        if (active() && getActiveBridge() === bridge && result.project)
          changed = applyNativeProjectOrigin(current, currentRevision, result.project) || changed;
      } catch { /* Offline, missing permission or an older engine: retain the confirmed local inspection. */ }
      return changed;
    })
    .catch(() => false)
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
