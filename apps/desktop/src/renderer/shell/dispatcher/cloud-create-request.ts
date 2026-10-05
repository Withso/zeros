import {
  ControlPlaneError,
  type OrganizationSummary,
} from "../../features/team/control-plane";
import type { createCloudWorkspaceDocument } from "../../platform/cloud-workspaces";

/** Submit the visible repository. The server selects its current template. */
export function cloudCreateRequest(source: {
  organization: Pick<OrganizationSummary, "id" | "defaultTeamId"> | null;
  repository: { owner: string; repo: string } | null;
  revision: string | null;
  installationId: string | null;
}): Omit<
  Parameters<typeof createCloudWorkspaceDocument>[0],
  "idempotencyKey"
> | null {
  if (
    !source.organization ||
    !source.repository ||
    !source.revision ||
    !source.installationId
  )
    return null;
  return {
    organizationId: source.organization.id,
    ...(source.organization.defaultTeamId
      ? { teamId: source.organization.defaultTeamId }
      : {}),
    repository: {
      forge: "github.com",
      owner: source.repository.owner,
      name: source.repository.repo,
      revision: source.revision,
      githubInstallationId: source.installationId,
    },
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
    ![
      "cloud_computer_changed",
      "cloud_computer_repository_not_configured",
      "cloud_computer_build_required",
      "cloud_computer_template_unavailable",
    ].includes(error.code)
  )
    return null;
  return "Cloud Computer changed — refresh";
}

type RecoverySurface = { active: boolean; owner: string | null; refresh: () => void };
/** One pending exact-owner recovery; automatic metadata retries are bounded. */
export function createCloudComputerRecovery() {
  let pendingOwner: string | null = null;
  let attemptedOwner: string | null = null;
  const resume = (current: RecoverySurface) => {
    if (pendingOwner !== current.owner) pendingOwner = null;
    if (!current.active || !pendingOwner) return false;
    pendingOwner = null;
    current.refresh();
    return true;
  };
  return {
    resume,
    confirm(owner: string) {
      if (attemptedOwner === owner) attemptedOwner = null;
    },
    recover(error: unknown, observedOwner: string | null, current: RecoverySurface, metadata = false) {
      const message = cloudComputerChangedMessage(error);
      if (!message || !observedOwner || observedOwner !== current.owner) return message;
      if (metadata && attemptedOwner === observedOwner) return message;
      attemptedOwner = observedOwner;
      pendingOwner = observedOwner;
      resume(current);
      return message;
    },
  };
}
