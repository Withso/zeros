// ──────────────────────────────────────────────────────────
// Active-organization selection. The persisted `team:active-id` name is a
// serialized compatibility contract from the flat-Team era; its value now
// identifies a tenant-root organization, never a child team.
//
// Persisted in native settings so the choice survives reloads; a
// subscribe channel lets team-sync re-courier the moment the selection
// changes. `null` means "use Personal/first organization when available."
// ──────────────────────────────────────────────────────────

import { getSettingMigrated, setSetting } from "../../platform/settings";

const KEY = "team:active-id";
/** Pre-2026-07-25 name, when a Team was called an Organization. Losing this
 *  value isn't cosmetic: with no selection the store falls back to teams[0]
 *  and team-sync couriers THAT team's settings doc into the engine, so a
 *  multi-team user would silently spawn agents under the wrong team's [env]
 *  and Git baseline. */
const LEGACY_KEY = "org:active-id";
const listeners = new Set<() => void>();
// Runtime-only because the engine context is runtime-only too. The selected id
// remains the durable compatibility value; this hint lets a Personal switch
// clear organization settings immediately even if the control plane is down.
let activeOrganizationIsPersonalHint: boolean | null = null;

export function getActiveTeamId(): string | null {
  return getSettingMigrated<string | null>(KEY, LEGACY_KEY, null);
}

export function setActiveTeamId(teamId: string | null): void {
  setActiveOrganizationSelection(teamId, null);
}

export function setActiveOrganizationSelection(
  organizationId: string | null,
  isPersonal: boolean | null,
): void {
  const idChanged = getActiveTeamId() !== organizationId;
  const hintChanged = activeOrganizationIsPersonalHint !== isPersonal;
  if (!idChanged && !hintChanged) return;
  // A failed persistence write also means getActiveTeamId cannot observe the
  // new selection in this implementation. Do not publish a semantic hint for
  // an id that did not actually become active.
  if (idChanged && !setSetting(KEY, organizationId)) return;
  activeOrganizationIsPersonalHint = isPersonal;
  for (const l of [...listeners]) l();
}

export function getActiveOrganizationIsPersonalHint(): boolean | null {
  return activeOrganizationIsPersonalHint;
}

export function clearActiveOrganizationSelectionHint(): void {
  if (activeOrganizationIsPersonalHint === null) return;
  activeOrganizationIsPersonalHint = null;
  for (const l of [...listeners]) l();
}

export function subscribeActiveTeam(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
