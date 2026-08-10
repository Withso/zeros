import type { OrganizationSummary, TeamRole } from "./control-plane";

export type OrganizationSummaryWire = {
  id: string;
  slug: string;
  name: string;
  logo?: string | null;
  role: TeamRole;
  isPersonal?: boolean;
  defaultTeamId?: string | null;
  workspaceCapabilities?: { local?: boolean; cloud?: boolean };
  teamCapabilities?: { multiple?: boolean; canCreate?: boolean };
};

/**
 * The control plane and desktop ship independently. Fill additive hierarchy
 * fields when talking to a pre-0009 server so an older flat Team is treated as
 * the collaborative organization it will become, never as Personal.
 */
export function normalizeOrganizationSummary(
  value: OrganizationSummaryWire,
): OrganizationSummary {
  const isPersonal = value.isPersonal === true;
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    logo: value.logo ?? null,
    role: value.role,
    isPersonal,
    defaultTeamId: value.defaultTeamId ?? null,
    workspaceCapabilities: {
      local: true,
      cloud: !isPersonal && (value.workspaceCapabilities?.cloud ?? true),
    },
    teamCapabilities: { multiple: false, canCreate: false },
  };
}
