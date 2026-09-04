import type { Me, OrganizationSummary } from "./control-plane";

/** Device-local selection key, never a server tenant or workspace owner ID.
 * Persisted in the existing active-selection key; do not rename without a
 * migration. Personal workspace rows use organizationId: null. */
export const PERSONAL_ORGANIZATION_ID = "local-personal";

export const PERSONAL_ORGANIZATION: OrganizationSummary = Object.freeze({
  id: PERSONAL_ORGANIZATION_ID,
  slug: "personal",
  name: "Personal",
  logo: null,
  role: "owner",
  isPersonal: true,
  defaultTeamId: null,
  workspaceCapabilities: Object.freeze({ local: true, cloud: false }),
  teamCapabilities: Object.freeze({ multiple: false, canCreate: false }),
});

const personalOnly: readonly OrganizationSummary[] = Object.freeze([
  PERSONAL_ORGANIZATION,
]);
const choicesBySnapshot = new WeakMap<Me, readonly OrganizationSummary[]>();

/** One Personal entry, even without authentication or a control-plane reply.
 * Server Personal rows remain a released-client compatibility contract, not
 * the owner of this device's work. Preserve the raw Me snapshot separately for
 * account authorization and migration of old local ownership metadata. */
export function desktopOrganizationChoices(
  me: Me | null,
): readonly OrganizationSummary[] {
  if (!me) return personalOnly;
  const cached = choicesBySnapshot.get(me);
  if (cached) return cached;
  const collaborative = (me.organizations ?? me.teams).filter(
    (organization) =>
      !organization.isPersonal && organization.id !== PERSONAL_ORGANIZATION_ID,
  );
  const choices = collaborative.length
    ? [PERSONAL_ORGANIZATION, ...collaborative]
    : personalOnly;
  choicesBySnapshot.set(me, choices);
  return choices;
}
