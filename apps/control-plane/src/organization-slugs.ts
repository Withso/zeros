// An organization's ID (its slug) is the owner segment of its workspace pages
// and links (`app.zeros.build/<id>/w/<n>`). It is chosen once, at creation,
// and never changes; the display name can. These would be another product
// route, Local's own owner or a link action, so a new organization never gets
// one. Dependency-free: @zeros/protocol mirrors the list as
// RESERVED_WORKSPACE_LINK_OWNERS and scripts/__tests__/workspace-link-owners
// keeps the two equal.
export const RESERVED_ORGANIZATION_SLUGS: ReadonlySet<string> = new Set([
  "agents", "api", "assets", "auth", "chat", "cloud-workspace", "github",
  "invite", "local", "open", "personal", "schemas", "w", "workspace",
]);

/** Personal organizations' `personal-<32 hex>` IDs are longer, so no new
 * organization can take one. */
export const ORGANIZATION_ID_MAX_LENGTH = 40;
const ORGANIZATION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A display name whose own ID is reserved or taken tries this next. */
export const ORGANIZATION_ID_FALLBACK_SUFFIX = "-org";

export type OrganizationIdProblem = "invalid" | "reserved";

/** At most `max` characters, ending on a whole word when the cut would
 * split one and an earlier word ends. */
function clip(id: string, max: number): string {
  if (id.length <= max) return id;
  const cut = id.slice(0, max);
  const word = id[max] === "-" || !cut.includes("-") ? cut : cut.slice(0, cut.lastIndexOf("-"));
  return word.replace(/-+$/, "");
}

/** A display name's own ID: ASCII letters and digits, lowercased, in runs
 * joined by single hyphens. A name with none of them is `organization`. */
export function organizationIdFromName(name: string): string {
  const id = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clip(id, ORGANIZATION_ID_MAX_LENGTH) || "organization";
}

/** What keeps a new organization from using this ID, apart from another
 * organization already having it. */
export function organizationIdProblem(id: string): OrganizationIdProblem | null {
  if (id.length > ORGANIZATION_ID_MAX_LENGTH || !ORGANIZATION_ID.test(id)) return "invalid";
  return RESERVED_ORGANIZATION_SLUGS.has(id) ? "reserved" : null;
}

/** The IDs a display name tries, in order: its own, then its own with `-org`.
 * A reserved one is skipped. When every candidate is taken, the creator
 * chooses the ID. */
export function organizationIdCandidates(name: string): string[] {
  const own = organizationIdFromName(name);
  const fallback = `${clip(own, ORGANIZATION_ID_MAX_LENGTH - ORGANIZATION_ID_FALLBACK_SUFFIX.length)}${ORGANIZATION_ID_FALLBACK_SUFFIX}`;
  return [...new Set([own, fallback])].filter((id) => organizationIdProblem(id) === null);
}
