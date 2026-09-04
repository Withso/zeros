// ──────────────────────────────────────────────────────────
// Organization → engine settings sync. The renderer owns the control-plane
// session, so it fetches the active organization's settings doc and couriers
// it into the compatibility in-memory slot (`team.setContext`). (The shared-secrets vault
// was removed 2026-07-22 — the courier now carries the settings doc
// only, no decrypted values.)
//
// Sync triggers: bridge (re)connect, sign-in/out, active-team change, window
// focus, a 15-minute refresh, and an explicit requestTeamResync() after
// settings mutations or organization membership changes.
//
// Correctness properties (audit 2026-07-04):
//   • Local bridge only — the engine operation rejects remote callers.
//   • Signed out → courier an EMPTY context so a prior account's organization
//     settings do not linger in engine memory across accounts.
//   • The active organization, not organizations[0], drives what's synced.
//     Personal and a mixed-version empty list both clear the remote context.
//   • Monotonic sequencing — a slow fetch can't overwrite a newer one
//     by serializing syncs and couriering only the latest result.
//   • On-demand resyncs while disconnected set a pending flag drained on
//     reconnect, so a change during a blip is not silently dropped.
// ──────────────────────────────────────────────────────────

import { useEffect } from "react";
import { isNativeRuntime } from "../../platform/runtime";
import { useAuth } from "../auth";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import { bridgeTeamSetContext } from "../../platform/bridge/workspace-bridge";
import { CONTROL_PLANE_URL, controlPlane } from "./control-plane";
import { getActiveTeamId, subscribeActiveTeam } from "./active-team";
import {
  organizationContextNeedsClear,
  organizationContextShouldRefreshOnFocus,
  organizationContextStillSelected,
} from "./organization-context-isolation";
import {
  reconcileOrganizationWorkspaceOwnership,
  reconcilePersonalWorkspaceOwnership,
} from "./organization-membership-history";
import { desktopOrganizationChoices } from "./personal-organization";
import {
  acceptOrganizationSnapshot,
  getOrganizationStoreGeneration,
} from "./team-store";

const RESYNC_INTERVAL_MS = 15 * 60_000;

const resyncListeners = new Set<() => void>();

/** Ask the mounted sync hook to re-fetch + re-courier now (called after
 *  settings writes, team create/delete/join, and on active-team change). */
export function requestTeamResync(): void {
  for (const l of [...resyncListeners]) l();
}

/** Mounted once in ShellRouter. */
export function useTeamEngineSync(): void {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus();
  const { status: authStatus, userId } = useAuth();

  useEffect(() => {
    // LOCAL bridge only: the engine op is local-only.
    if (!isNativeRuntime()) return;
    if (!bridge || bridgeStatus !== "connected") return;

    // Old account-owned Personal rows can be detached using local migration
    // evidence alone, including after the old account was deleted or offline.
    void reconcilePersonalWorkspaceOwnership().catch((error) => {
      console.warn(
        "[organization] local Personal migration deferred:",
        error instanceof Error ? error.message : error,
      );
    });
    if (!CONTROL_PLANE_URL) return;

    let disposed = false;
    let running = false; // exactly one sync in flight at a time
    let pending = false; // a request arrived while one was running → run once more
    let publishingOrganizationSnapshot = false;
    let lastSyncStartedAt = 0;
    // `undefined` is deliberate: a renderer reload can reconnect to an engine
    // that still holds another account/organization's in-memory settings.
    let appliedOrganizationId: string | null | undefined;

    const clearEngine = async (semanticOrganizationId: string | null) => {
      try {
        await bridgeTeamSetContext(bridge, { teamId: null, doc: null });
        appliedOrganizationId = semanticOrganizationId;
      } catch {
        /* engine gone / blip — next connect re-syncs */
      }
    };

    // Serialized: overlapping callers coalesce into a single trailing run, so
    // a slow fetch can never overwrite a newer one — no result ordering
    // to reason about because only one runs at a time.
    const sync = async (): Promise<void> => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      lastSyncStartedAt = Date.now();
      try {
        // Signed out → clear the engine's team context (don't leave a prior
        // account's organization settings resident).
        if (authStatus !== "authenticated") {
          await clearEngine(null);
          return;
        }
        // Clear before the network read whenever the semantic owner changed.
        // This protects Organization B as well as Personal from inheriting
        // Organization A's environment/settings during an outage.
        const selectedBeforeFetch = getActiveTeamId();
        if (
          organizationContextNeedsClear(
            appliedOrganizationId,
            selectedBeforeFetch,
          )
        ) {
          await clearEngine(selectedBeforeFetch);
        }
        // Capture per request, not per effect. A same-status account switch can
        // clear the store without waiting for this hook's cleanup/remount.
        const storeGeneration = getOrganizationStoreGeneration();
        const me = await controlPlane.me();
        if (disposed) return;
        let accepted = false;
        publishingOrganizationSnapshot = true;
        try {
          accepted = acceptOrganizationSnapshot(me, storeGeneration);
        } finally {
          publishingOrganizationSnapshot = false;
        }
        if (!accepted) return;
        // Local ownership repair is independent from the settings courier. A
        // bridge restart should defer that idempotent repair, not prevent this
        // pass from refreshing the active organization's engine context.
        try {
          await reconcileOrganizationWorkspaceOwnership(
            me,
            () =>
              !disposed && storeGeneration === getOrganizationStoreGeneration(),
          );
        } catch (error) {
          console.warn(
            "[organization] local workspace ownership repair deferred:",
            error instanceof Error ? error.message : error,
          );
        }
        // Honor the Home switcher's selection; fall back to Personal/first.
        const wantId = getActiveTeamId();
        const organizations = desktopOrganizationChoices(me);
        const team =
          organizations.find((organization) => organization.id === wantId) ??
          organizations[0];
        if (disposed || storeGeneration !== getOrganizationStoreGeneration())
          return;
        if (!team) {
          await clearEngine(null);
          return;
        }
        if (organizationContextNeedsClear(appliedOrganizationId, team.id)) {
          await clearEngine(team.id);
        }
        // Personal is deliberately device-local. Clear the compatibility
        // engine team slot rather than fetching/persisting a cloud document.
        if (team.isPersonal) {
          return;
        }
        const settings = await controlPlane.getOrganizationSettings(team.id);
        if (
          disposed ||
          storeGeneration !== getOrganizationStoreGeneration() ||
          !organizationContextStillSelected(team.id, getActiveTeamId())
        ) {
          return;
        }
        await bridgeTeamSetContext(bridge, {
          teamId: team.id,
          doc: settings.doc ?? null,
        });
        appliedOrganizationId = team.id;
      } catch (err) {
        // A same-owner transient failure retains the last context. Owner
        // changes and sign-out clear before the request, so stale settings can
        // never leak across organizations or accounts.
        // But never swallow SILENTLY: a permanent rejection (e.g. every call
        // 401ing after the Auth0 migration, 2026-07-07) hid for days because
        // this catch was empty. The Team panel shows its own error UI
        // when opened; this log is the only trace for the background path.
        console.warn(
          "[team-sync] control-plane sync failed — team settings not refreshed:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        running = false;
        if (pending && !disposed) {
          pending = false;
          void sync();
        }
      }
    };

    const kick = () => {
      // Publishing the fetched snapshot can synchronously update the semantic
      // hint. This pass already continues with that exact snapshot, so its own
      // listener notification must not enqueue a duplicate network round trip.
      if (publishingOrganizationSnapshot) return;
      // A switch while a settings fetch is running must clear immediately;
      // `sync` then coalesces a trailing exact-owner refresh.
      const selected = getActiveTeamId();
      void (async () => {
        if (organizationContextNeedsClear(appliedOrganizationId, selected)) {
          await clearEngine(selected);
        }
        await sync();
      })();
    };

    void sync();
    const timer = setInterval(() => void sync(), RESYNC_INTERVAL_MS);
    resyncListeners.add(kick);
    const unsubTeam = subscribeActiveTeam(kick);
    // Organization changes made in app.zeros.build become visible as soon as
    // the user returns from the browser, rather than after the 15-minute poll.
    const onFocus = () => {
      if (
        !organizationContextShouldRefreshOnFocus(lastSyncStartedAt, Date.now())
      ) {
        return;
      }
      kick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      clearInterval(timer);
      resyncListeners.delete(kick);
      unsubTeam();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, bridgeStatus, authStatus, userId]);
}
