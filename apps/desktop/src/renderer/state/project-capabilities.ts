import { workspaceInspectFolder } from "../platform/git";
import {
  applyProjectGitInspection,
  loadProjects,
  projectGitRevision,
  type Project,
} from "./projects-store";

const pending = new Map<string, Promise<boolean>>();

/** One inspection per exact owner in flight. The persisted project is the
 * last confirmed snapshot; a failed read never clears it. */
export function refreshProjectCapabilities(owner: Project): Promise<boolean> {
  const key = JSON.stringify([owner.id, owner.repoRoot]);
  const current = pending.get(key);
  if (current) return current;
  const project = loadProjects().find(
    (row) => row.id === owner.id && row.repoRoot === owner.repoRoot,
  );
  if (!project) return Promise.resolve(false);
  const revision = projectGitRevision(project.id);
  const request = workspaceInspectFolder(project.repoRoot)
    .then((inspection) =>
      applyProjectGitInspection(project, revision, inspection),
    )
    .catch(() => false)
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
