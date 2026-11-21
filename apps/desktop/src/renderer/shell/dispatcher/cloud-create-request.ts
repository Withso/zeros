import {
  ControlPlaneError,
  type OrganizationSummary,
} from "../../features/team/control-plane";
import type { createCloudWorkspaceDocument } from "../../platform/cloud-workspaces";

/** Submit the visible repository, or the visible project whose first repository
 * it is, with a base branch for any other repository chosen on Create. */
export function cloudCreateRequest(source: {
  organization: Pick<OrganizationSummary, "id"> | null;
  repository: { owner: string; repo: string } | null;
  baseBranch: string | null;
  project?: { id: string; repositories: readonly { repository: string }[] } | null;
  /** Lowercased `owner/name` → branch, for repositories after the first. */
  projectBases?: Readonly<Record<string, string>>;
}): Omit<
  Parameters<typeof createCloudWorkspaceDocument>[0],
  "idempotencyKey"
> | null {
  if (!source.organization || !source.repository) return null;
  const others = source.project?.repositories.slice(1).flatMap(entry => {
    const branch = source.projectBases?.[entry.repository.toLowerCase()];
    return branch ? [{ repository: entry.repository, baseBranch: branch }] : [];
  }) ?? [];
  return {
    organizationId: source.organization.id,
    repository: { owner: source.repository.owner, name: source.repository.repo },
    ...(source.baseBranch ? { baseBranch: source.baseBranch } : {}),
    ...(source.project ? { projectId: source.project.id } : {}),
    ...(others.length ? { repositories: others } : {}),
    ...(source.project && source.project.repositories.length > 1 ? { severalRepositories: true } : {}),
  };
}
export function refreshChangedCloudComputer(
  error: unknown,
  refresh: () => void,
): string | null {
  const message = cloudComputerChangedMessage(error);
  if (message) refresh();
  return message;
}
export function cloudComputerChangedMessage(error: unknown): string | null {
  if (
    !(error instanceof ControlPlaneError) ||
    error.status !== 409 ||
    !["cloud_computer_build_required", "repository_not_installed"].includes(error.code)
  )
    return null;
  return "Cloud Computer changed — refresh";
}

type RecoverySurface = { active: boolean; owner: string | null; refresh: () => void };
/** One pending exact-owner recovery, resumed once its owner is visible. */
export function createCloudComputerRecovery() {
  let pendingOwner: string | null = null;
  const resume = (current: RecoverySurface) => {
    if (pendingOwner !== current.owner) pendingOwner = null;
    if (!current.active || !pendingOwner) return false;
    pendingOwner = null;
    current.refresh();
    return true;
  };
  return {
    resume,
    recover(error: unknown, observedOwner: string | null, current: RecoverySurface) {
      const message = cloudComputerChangedMessage(error);
      if (!message || !observedOwner || observedOwner !== current.owner) return message;
      pendingOwner = observedOwner;
      resume(current);
      return message;
    },
  };
}
