// ──────────────────────────────────────────────────────────
// Team store — ONE cached `/v1/me` shared by the settings sidebar and the
// Administration panels (Team / Members), so "does this user have any
// teams?" is answered once per session, not per panel mount.
//
// Teams are OPTIONAL (2026-07-22): nothing is auto-created at sign-in, so
// zero teams is a first-class state — the sidebar swaps the Administration
// tabs for a "+ Create team" entry, and the engine team layer simply stays
// clear. The store reconciles the persisted active-team selection on every
// load: a vanished team (deleted / left) falls back to the first remaining
// team, or null.
//
// Stale-while-revalidate: `me` keeps its last value during a reload so
// the sidebar never flashes between the tabs and the create entry.
// Cleared on sign-out (InviteDeepLinkHandler in app-shell.tsx) so account
// A's teams can never render for account B.
// ──────────────────────────────────────────────────────────

import { useEffect, useSyncExternalStore } from "react";
import { getSettingMigrated, setSetting } from "../../platform/settings";
import {
  CONTROL_PLANE_URL,
  ControlPlaneError,
  controlPlane,
  type Me,
  type TeamSummary,
} from "./control-plane";
import {
  getActiveTeamId,
  setActiveTeamId,
  subscribeActiveTeam,
} from "./active-team";
import { requestTeamResync } from "./team-sync";

export type TeamStoreStatus = "idle" | "loading" | "ready" | "error";

export type TeamStoreState = {
  me: Me | null;
  status: TeamStoreStatus;
  error: string | null;
};

let state: TeamStoreState = { me: null, status: "idle", error: null };
const listeners = new Set<() => void>();
let inflight: Promise<Me | null> | null = null;
// Bumped by clearTeamStore (sign-out): an in-flight fetch started under the
// PREVIOUS account discards its result instead of re-emitting account A's
// teams after the store was cleared for account B.
let generation = 0;

// Sidebar-gating hint persisted across launches: whether the last confirmed
// load had ≥1 team. Lets a zero-team user's Settings open straight to the
// "+ Create team" entry instead of flashing the Administration tabs
// until the first fetch confirms. Advisory only — the live store state wins
// the moment it's ready.
const HAS_TEAMS_KEY = "team:has-teams";
/** Pre-2026-07-25 name. Without the carry-forward this returns null after an
 *  upgrade, `zeroTeams` computes false while the first fetch is in flight, and
 *  the Administration tabs flash in and vanish. */
const LEGACY_HAS_TEAMS_KEY = "org:has-orgs";

export function lastKnownHasTeams(): boolean | null {
  return getSettingMigrated<boolean | null>(
    HAS_TEAMS_KEY,
    LEGACY_HAS_TEAMS_KEY,
    null,
  );
}

function emit(next: TeamStoreState): void {
  state = next;
  for (const l of [...listeners]) l();
}

export function getTeamStoreState(): TeamStoreState {
  return state;
}

/** Fetch `/v1/me` (single-flight) and reconcile the active-team selection.
 *  Errors land in `state.error` AND reject-free: callers just re-render. */
export function refreshTeams(): Promise<Me | null> {
  if (!CONTROL_PLANE_URL) return Promise.resolve(null);
  if (inflight) return inflight;
  const gen = generation;
  emit({ ...state, status: "loading" });
  const run = (async () => {
    try {
      const me = await controlPlane.me();
      // Signed out (store cleared) while this was in flight — the result
      // belongs to the previous account. Drop it: no emit, no active-team
      // write.
      if (gen !== generation) return null;
      // Keep the persisted selection valid: a deleted/left team falls back to
      // the first remaining team; zero teams → null (clears the engine layer
      // via the active-team subscribe → team-sync chain).
      const current = getActiveTeamId();
      if (!current || !me.teams.some((t) => t.id === current)) {
        setActiveTeamId(me.teams[0]?.id ?? null);
        // setActiveTeamId no-ops (no subscriber event) when the id is
        // ALREADY null — e.g. the last team vanished server-side while
        // nothing was selected. Kick the engine sync explicitly so a stale
        // team settings doc can't linger until the 15-minute interval.
        if (!current && me.teams.length === 0) requestTeamResync();
      }
      setSetting(HAS_TEAMS_KEY, me.teams.length > 0);
      emit({ me, status: "ready", error: null });
      return me;
    } catch (err) {
      if (gen !== generation) return null;
      const message =
        err instanceof ControlPlaneError
          ? err.message
          : "Couldn't reach the team service";
      // Keep the last-known teams (stale beats blank); surface the error.
      emit({ ...state, status: "error", error: message });
      return null;
    }
  })().finally(() => {
    // Only release the slot we own — clearTeamStore may have nulled it and a
    // newer fetch may already be registered.
    if (inflight === run) inflight = null;
  });
  inflight = run;
  return run;
}

/** Sign-out: drop the cache (and orphan any in-flight fetch) so the next
 *  account starts clean. */
export function clearTeamStore(): void {
  generation += 1;
  inflight = null;
  emit({ me: null, status: "idle", error: null });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached me/teams; auto-loads on first mounted use. */
export function useTeams(): TeamStoreState & {
  reload: () => Promise<Me | null>;
} {
  const snapshot = useSyncExternalStore(subscribe, getTeamStoreState);
  useEffect(() => {
    if (snapshot.status === "idle" && CONTROL_PLANE_URL) void refreshTeams();
  }, [snapshot.status]);
  return { ...snapshot, reload: refreshTeams };
}

/** The active team resolved against the cached list (selection falls back to
 *  the first team while a stale id reconciles), or null when the user has no
 *  teams. Re-renders on BOTH store and active-team changes. */
export function useActiveTeam(): TeamSummary | null {
  const { me } = useTeams();
  const activeId = useSyncExternalStore(subscribeActiveTeam, getActiveTeamId);
  if (!me || me.teams.length === 0) return null;
  return me.teams.find((t) => t.id === activeId) ?? me.teams[0] ?? null;
}

// ── Create-team dialog bus ───────────────────────────────
//
// The dialog is rendered once by SettingsPage; openers live in different
// trees (the sidebar's "+ Create team" entry, the Team panel's team-switcher
// "New team" item). A tiny event bus beats threading a callback through the
// generic Panel props.

const createDialogListeners = new Set<() => void>();

export function requestCreateTeamDialog(): void {
  for (const l of [...createDialogListeners]) l();
}

export function subscribeCreateTeamDialog(listener: () => void): () => void {
  createDialogListeners.add(listener);
  return () => createDialogListeners.delete(listener);
}
