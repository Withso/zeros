// ──────────────────────────────────────────────────────────
// Organization store — ONE cached `/v1/me` shared by the Home switcher,
// staff-feature gate, compatibility administration components, and engine
// settings courier.
//
// Personal is device-local and available independently of this account cache.
// Server Personal rows survive only as a released-client compatibility contract.
// A zero-organization response remains a tolerated mixed-version/error state.
// The persisted `team:*` keys are compatibility contracts from the flat-Team
// era; their values now identify tenant-root organizations.
//
// Stale-while-revalidate: `me` keeps its last value during a reload so
// the sidebar never flashes between the tabs and the create entry.
// Cleared on sign-out (InviteDeepLinkHandler in app-shell.tsx) so account
// A's organizations can never render for account B.
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
  clearActiveOrganizationSelectionHint,
  getActiveOrganizationIsPersonalHint,
  getActiveTeamId,
  setActiveOrganizationSelection,
  subscribeActiveTeam,
} from "./active-team";
import { requestTeamResync } from "./team-sync";
import {
  hasOrganizationOwnershipHistory,
  hasRecordedOrganizationOwnership,
  getKnownPersonalOrganizationIds,
  recordOrganizationHierarchySeen,
  reconcileOrganizationWorkspaceOwnership,
  rememberPersonalOrganizationOwnership,
} from "./organization-membership-history";
import {
  desktopOrganizationChoices,
  PERSONAL_ORGANIZATION,
  PERSONAL_ORGANIZATION_ID,
} from "./personal-organization";

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
// organizations after the store was cleared for account B.
let generation = 0;
let personalOwnershipIds: readonly string[] | null = null;
let personalSnapshot = PERSONAL_ORGANIZATION;

function devicePersonalSnapshot(): TeamSummary {
  const ids = getKnownPersonalOrganizationIds();
  if (ids !== personalOwnershipIds) {
    personalOwnershipIds = ids;
    personalSnapshot =
      ids.length === 0
        ? PERSONAL_ORGANIZATION
        : {
            ...PERSONAL_ORGANIZATION,
            legacyPersonalOrganizationIds: ids,
          };
  }
  return personalSnapshot;
}

/** Capture when starting work that may outlive the current signed-in account.
 * `clearTeamStore` advances this token before Account B can mount. */
export function getOrganizationStoreGeneration(): number {
  return generation;
}

// Persisted compatibility hint. The key name predates the restored hierarchy;
// it now records whether `/v1/me` returned any tenant-root organizations.
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

function activeOrganization(
  me: Me | null,
  activeId: string | null,
): TeamSummary | null {
  if (
    activeId === null ||
    activeId === PERSONAL_ORGANIZATION_ID ||
    getKnownPersonalOrganizationIds().includes(activeId)
  )
    return devicePersonalSnapshot();
  const selected = desktopOrganizationChoices(me).find(
    (organization) => organization.id === activeId,
  );
  if (selected) return selected;
  // Keep a confirmed collaborative create intent during a cold/empty rollout
  // snapshot. Never turn it into Personal merely because a request is pending.
  const hasServerSnapshot = (me?.organizations ?? me?.teams ?? []).length > 0;
  return !hasServerSnapshot && hasRecordedOrganizationOwnership(activeId)
    ? null
    : devicePersonalSnapshot();
}

export function getActiveOrganizationSnapshot(): TeamSummary | null {
  return activeOrganization(state.me, getActiveTeamId());
}

/** Exact owner for a local create intent. A confirmed membership-history
 * entry keeps cold-start/outage creates under the durable selection; an
 * unproven flat-Team-era id deliberately falls back to legacy Personal. */
export function getActiveOrganizationIdSnapshot(): string | null {
  const active = getActiveOrganizationSnapshot();
  if (active) return active.isPersonal ? null : active.id;
  const persisted = getActiveTeamId();
  return hasRecordedOrganizationOwnership(persisted) ? persisted : null;
}

/** Commit an exact `/v1/me` snapshot from either the visible store refresh or
 * the bridge-aware background sync. Sharing this publication prevents the
 * switcher from retaining a deleted/left organization for 15 minutes while
 * workspace ownership has already moved back to Personal. */
export function acceptOrganizationSnapshot(
  me: Me,
  expectedGeneration: number = generation,
): boolean {
  if (expectedGeneration !== generation) return false;
  rememberPersonalOrganizationOwnership(me);
  const current = getActiveTeamId();
  const organizations = me.organizations ?? me.teams;
  const personal = organizations.find(
    (organization) => organization.isPersonal,
  );
  // One-time flat-Team → hierarchy normalization. Legacy SQLite rows are
  // intentionally Personal/null-owned, so retaining a promoted collaborative
  // selection would make the entire existing workspace collection disappear.
  const firstHierarchySnapshot =
    personal != null && !hasOrganizationOwnershipHistory(me.user.id);
  const selected = firstHierarchySnapshot
    ? devicePersonalSnapshot()
    : organizations.length === 0 &&
        current !== null &&
        current !== PERSONAL_ORGANIZATION_ID &&
        !getKnownPersonalOrganizationIds().includes(current)
      ? null
      : activeOrganization(me, current);
  // An authoritative empty response is a tolerated mixed-version/provisioning
  // state, not evidence that the durable owner was deleted. Keep the selection
  // so later creates and a recovered snapshot retain their semantic owner.
  if (selected) {
    setActiveOrganizationSelection(selected.id, selected.isPersonal);
  }
  if (
    firstHierarchySnapshot &&
    getActiveTeamId() === PERSONAL_ORGANIZATION_ID
  ) {
    recordOrganizationHierarchySeen(me.user.id);
  }
  setSetting(HAS_TEAMS_KEY, organizations.length > 0);
  emit({ me, status: "ready", error: null });
  return true;
}

/** Fetch `/v1/me` (single-flight) and reconcile the active organization.
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
      // Keep the persisted selection valid: a deleted/left organization falls
      // back to Personal/first. A mixed-version empty list retains that durable
      // selection but explicitly clears the engine layer below.
      const organizations = me.organizations ?? me.teams;
      acceptOrganizationSnapshot(me);
      // Empty snapshots deliberately do not publish a selection change. Re-kick
      // the courier so any previously applied remote settings are still cleared.
      if (organizations.length === 0) {
        requestTeamResync();
      }
      void reconcileOrganizationWorkspaceOwnership(
        me,
        () => gen === generation,
      ).catch((error) => {
        console.warn(
          "[organization] local workspace ownership repair deferred:",
          error instanceof Error ? error.message : error,
        );
      });
      return me;
    } catch (err) {
      if (gen !== generation) return null;
      const message =
        err instanceof ControlPlaneError
          ? err.message
          : "Couldn't reach the organization service";
      // Keep the last-known organizations (stale beats blank); surface error.
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

/** Drop the cache (and orphan any in-flight fetch) so the next account starts
 * clean. A renderer cold reload keeps the durable selection; a real account
 * boundary opts into clearing it so another account cannot inherit its owner. */
export function clearTeamStore(
  options: { resetSelection?: boolean } = {},
): void {
  generation += 1;
  inflight = null;
  const previousId = getActiveTeamId();
  const previousHint = getActiveOrganizationIsPersonalHint();
  if (options.resetSelection) {
    setActiveOrganizationSelection(null, null);
  } else {
    clearActiveOrganizationSelectionHint();
  }
  emit({ me: null, status: "idle", error: null });
  // Clearing can be a no-op for the active-selection publisher. Re-kick the
  // courier explicitly so it captures this generation and clears/refetches.
  const selectionPublished =
    previousId !== getActiveTeamId() ||
    previousHint !== getActiveOrganizationIsPersonalHint();
  if (!selectionPublished) requestTeamResync();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached account/organizations; auto-loads on first mounted use. */
export function useTeams(): TeamStoreState & {
  reload: () => Promise<Me | null>;
} {
  const snapshot = useSyncExternalStore(subscribe, getTeamStoreState);
  useEffect(() => {
    if (snapshot.status === "idle" && CONTROL_PLANE_URL) void refreshTeams();
  }, [snapshot.status]);
  return { ...snapshot, reload: refreshTeams };
}

/** The desktop list substitutes device Personal for the compatibility server
 * row. Keep `me` unchanged: staff authorization must still require a real
 * account response, never the presence of the local Personal entry. */
export function useOrganizations() {
  const snapshot = useTeams();
  return {
    ...snapshot,
    organizations: desktopOrganizationChoices(snapshot.me),
  };
}

/** The active organization resolved against the cached list (selection falls
 *  back to Personal/first while a stale id reconciles). Re-renders on both
 *  store and compatibility active-team-key changes. */
export function useActiveTeam(): TeamSummary | null {
  const { me } = useTeams();
  const activeId = useSyncExternalStore(subscribeActiveTeam, getActiveTeamId);
  return activeOrganization(me, activeId);
}

export const useActiveOrganization = useActiveTeam;

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
