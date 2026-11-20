// Only the local bridge can supply this in-memory layer; team environment values still pass the spawn hazard filter.

import type { RawSettingsDoc } from "./schema";

type TeamContext = {
  teamId: string | null;
  doc: RawSettingsDoc | null;
};

let context: TeamContext = { teamId: null, doc: null };

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
