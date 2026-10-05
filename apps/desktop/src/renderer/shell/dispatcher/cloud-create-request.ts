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
  refresh();
  return "Cloud Computer changed — refresh";
}
