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
  // A pre-hierarchy server returns none of the additive ownership fields. Its
  // one flat Team historically owned the same local collection now represented
  // by null organization ids, so the renderer must keep those rows visible
  // until a hierarchy-aware snapshot can normalize to Personal.
  const legacyFlat =
    value.isPersonal == null &&
    value.defaultTeamId == null &&
    value.workspaceCapabilities == null &&
    value.teamCapabilities == null;
  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    logo: value.logo ?? null,
    role: value.role,
    isPersonal,
    ...(legacyFlat ? { legacyFlat: true } : {}),
    defaultTeamId: value.defaultTeamId ?? null,
    workspaceCapabilities: {
      local: true,
      cloud: !isPersonal && (value.workspaceCapabilities?.cloud ?? true),
    },
    teamCapabilities: { multiple: false, canCreate: false },
  };
}
