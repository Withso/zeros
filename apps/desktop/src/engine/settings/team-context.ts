// Only the local bridge can supply this in-memory layer; team environment values still pass the spawn hazard filter.

import type { RawSettingsDoc } from "./schema";

type TeamContext = {
  teamId: string | null;
  doc: RawSettingsDoc | null;
};

/** The owner a resolve is for: an organization id, or null for Personal. */
export type SettingsOwner = { organizationId?: string | null };

type SettingsOwnerLookup = (workspacePath: string) => SettingsOwner | null;

let context: TeamContext = { teamId: null, doc: null };
let ownerLookup: SettingsOwnerLookup | null = null;

export function setTeamContext(next: {
  teamId?: string | null;
  doc?: RawSettingsDoc | null;
}): void {
  context = {
    teamId: next.teamId ?? null,
    doc: next.doc ?? null,
  };
}

export function clearTeamContext(): void {
  context = { teamId: null, doc: null };
}

export function getTeamDoc(): RawSettingsDoc | null {
  return context.doc;
}

export function getTeamContextMeta(): { teamId: string | null } {
  return { teamId: context.teamId };
}

/** The engine registers its workspace registry here; without it every workspace path resolves as Personal. */
export function configureSettingsOwnerLookup(
  lookup: SettingsOwnerLookup | null,
): void {
  ownerLookup = lookup;
}

/** A workspace receives the organization layer only when that organization owns it. A resolve with no workspace keeps the loaded document. */
export function teamDocFor(
  workspacePath: string | undefined,
  owner?: SettingsOwner,
): RawSettingsDoc | null {
  const { teamId, doc } = context;
  if (!doc) return null;
  if (!owner && !workspacePath) return doc;
  let resolvedOwner = owner ?? null;
  if (!owner && workspacePath) {
    try {
      resolvedOwner = ownerLookup?.(workspacePath) ?? null;
    } catch {
      return null;
    }
  }
  const organizationId = resolvedOwner?.organizationId?.trim() || null;
  return teamId !== null && organizationId === teamId ? doc : null;
}
