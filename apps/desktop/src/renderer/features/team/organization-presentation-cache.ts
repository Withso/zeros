import { z } from "zod";
import { ORGANIZATION_PRESENTATION_KEY, readAccountPresentation, writeAccountPresentation } from "../../platform/account-presentation-cache";
import type { OrganizationSummary } from "./control-plane";

const MAX_BYTES = 1024 * 1024;
const Organization = z.object({
  id: z.string().min(1).max(256),
  slug: z.string().max(256),
  name: z.string().max(256),
  logo: z.string().max(64 * 1024).nullable(),
  role: z.enum(["owner", "admin", "member"]),
  isPersonal: z.boolean(),
  legacyFlat: z.boolean().optional(),
  defaultTeamId: z.string().max(256).nullable(),
  workspaceCapabilities: z.object({ local: z.boolean(), cloud: z.boolean() }),
  teamCapabilities: z.object({ multiple: z.literal(false), canCreate: z.literal(false) }),
});
const Snapshot = z.object({
  organizations: z.array(Organization).max(1024),
  activeId: z.string().min(1).max(256).nullable(),
});

export function loadOrganizationPresentation(owner: string) {
  const parsed = Snapshot.safeParse(readAccountPresentation(ORGANIZATION_PRESENTATION_KEY, owner, MAX_BYTES));
  if (!parsed.success || new Set(parsed.data.organizations.map(org => org.id)).size !== parsed.data.organizations.length) return null;
  return parsed.data;
}

export function persistOrganizationPresentation(owner: string, organizations: readonly OrganizationSummary[], activeId: string | null): void {
  // The switcher uses semantic icons. Large inline logos must not evict an
  // otherwise complete membership list from the presentation budget.
  const parsed = Snapshot.safeParse({ organizations: organizations.map(org => ({ ...org, logo: null })), activeId });
  if (parsed.success) writeAccountPresentation(ORGANIZATION_PRESENTATION_KEY, owner, parsed.data, MAX_BYTES);
}
