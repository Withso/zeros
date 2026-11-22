import { isFeatureEnabled } from "../../config/release-channel";
import type { Me, OrganizationSummary } from "./control-plane";

const cloudBySnapshot = new WeakMap<Me, OrganizationSummary>();

/** The signed-in account's server Personal organization as a cloud owner, or
 * null. Only with `unified-workspaces`, a signed-in account and a control plane
 * whose Personal row offers cloud; otherwise Personal stays local-only, exactly
 * as before. Its `seat` is the owner's live Pro: `free` opens nothing.
 * Derived from this one account snapshot, so another account's rows never
 * resolve here. The same snapshot gives the same object. */
export function personalCloudOrganization(me: Me | null | undefined): OrganizationSummary | null {
  if (!me?.user.id || !me.personalCloud || !isFeatureEnabled("unified-workspaces") || !isFeatureEnabled("cloud-workspaces")) return null;
  const cached = cloudBySnapshot.get(me);
  if (cached) return cached;
  const offer = me.personalCloud;
  const organization: OrganizationSummary = Object.freeze({
    id: offer.organizationId,
    slug: offer.slug,
    name: "Personal",
    logo: null,
    role: "owner",
    isPersonal: true,
    defaultTeamId: null,
    workspaceCapabilities: Object.freeze({ local: true, cloud: true }),
    teamCapabilities: Object.freeze({ multiple: false, canCreate: false }),
    seat: offer.seat,
  });
  cloudBySnapshot.set(me, organization);
  return organization;
}

/** The organization that owns cloud work for a selection: an organization owns
 * its own; the Personal entry resolves to the server Personal organization when
 * `personalCloudOrganization` allows it, else null (no cloud). */
export function cloudOrganizationFor(selected: OrganizationSummary | null | undefined, me: Me | null | undefined): OrganizationSummary | null {
  if (!selected) return null;
  return selected.isPersonal ? personalCloudOrganization(me) : selected;
}

/** Whether a cloud owner ID is the signed-in account's own Personal cloud. */
export function isPersonalCloudOrganization(organizationId: string | null | undefined, me: Me | null | undefined): boolean {
  const personal = personalCloudOrganization(me);
  return !!personal && !!organizationId && personal.id.toLowerCase() === organizationId.toLowerCase();
}
