// ──────────────────────────────────────────────────────────
// Active-team selection — the single source of truth for WHICH team the
// Administration panels are viewing AND which team's settings doc the
// engine sync couriers. The panel selection must drive the engine instead of a
// hardcoded first team.
//
// Persisted in native settings so the choice survives reloads; a
// subscribe channel lets team-sync re-courier the moment the selection
// changes. `null` = "use the first team, if any" — a user with ZERO teams
// (teams are optional since 2026-07-22) simply keeps null.
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

export function getActiveTeamId(): string | null {
  return getSettingMigrated<string | null>(KEY, LEGACY_KEY, null);
}

export function setActiveTeamId(teamId: string | null): void {
  if (getActiveTeamId() === teamId) return;
  setSetting(KEY, teamId);
  for (const l of [...listeners]) l();
}

export function subscribeActiveTeam(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
