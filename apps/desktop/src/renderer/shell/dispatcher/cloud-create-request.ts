import {
  ControlPlaneError,
  type OrganizationSummary,
} from "../../features/team/control-plane";
import type { createCloudWorkspaceDocument } from "../../platform/cloud-workspaces";

/** Submit the visible repository. The server forks its live Cloud Computer. */
export function cloudCreateRequest(source: {
  organization: Pick<OrganizationSummary, "id"> | null;
  repository: { owner: string; repo: string } | null;
  baseBranch: string | null;
}): Omit<
  Parameters<typeof createCloudWorkspaceDocument>[0],
  "idempotencyKey"
> | null {
  if (!source.organization || !source.repository) return null;
  return {
    organizationId: source.organization.id,
    repository: { owner: source.repository.owner, name: source.repository.repo },
    ...(source.baseBranch ? { baseBranch: source.baseBranch } : {}),
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
