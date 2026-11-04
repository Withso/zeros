// ──────────────────────────────────────────────────────────
// Organization → engine settings sync. The renderer owns the control-plane
// session, so it fetches the active organization's settings doc and couriers
// it into the compatibility in-memory slot (`team.setContext`). (The shared-secrets vault
// was removed 2026-07-22 — the courier now carries the settings doc
// only, no decrypted values.)
//
// Sync triggers: bridge (re)connect, sign-in/out, active-team change, window
// focus, a visible-only 15-minute refresh, and an explicit requestTeamResync()
// after settings mutations or organization membership changes. Hidden windows
// defer reads, but still clear context immediately at owner/account boundaries.
//
// Correctness properties (audit 2026-07-04):
//   • Local bridge only — the engine operation rejects remote callers.
//   • Signed out → courier an EMPTY context so a prior account's organization
//     settings do not linger in engine memory across accounts.
//   • The active organization, not organizations[0], drives what's synced.
//     Personal and a mixed-version empty list both clear the remote context.
//   • One observation at a time, with a latched epoch so a hide or A → B → A
//     switch cannot revive an old response after the selection returns.
//   • On-demand resyncs while disconnected set a pending flag drained on
//     reconnect, so a change during a blip is not silently dropped.
// ──────────────────────────────────────────────────────────

import { useEffect } from "react";
import { isLocalDevelopment, isNativeRuntime } from "../../platform/runtime";
import { documentIsVisible } from "../../state/use-document-active";
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
    if (isLocalDevelopment()) {
      void bridgeTeamSetContext(bridge, { teamId: null, doc: null }).catch(
        () => {},
      );
      return;
    }
    if (!CONTROL_PLANE_URL) return;

    let disposed = false;
    let running = false; // exactly one sync in flight at a time
    let pending = true; // invalidations coalesce until the next eligible read
    let publishingOrganizationSnapshot = false;
    let observationEpoch = 0;
    let lastSyncStartedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // `undefined` is deliberate: a renderer reload can reconnect to an engine
    // that still holds another account/organization's in-memory settings.
    let appliedOrganizationId: string | null | undefined;
    let appliedStoreGeneration: number | undefined;
    let contextWrite = 0;
    let clearing:
      | {
          organizationId: string | null;
          storeGeneration: number;
          write: number;
          promise: Promise<void>;
        }
      | undefined;

    const clearTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    const clearEngine = (
      semanticOrganizationId: string | null,
      storeGeneration: number,
    ): Promise<void> => {
      if (
        appliedStoreGeneration === storeGeneration &&
        !organizationContextNeedsClear(
          appliedOrganizationId,
          semanticOrganizationId,
        )
      )
        return Promise.resolve();
      if (
        clearing?.organizationId === semanticOrganizationId &&
        clearing.storeGeneration === storeGeneration
      )
        return clearing.promise;

      const write = ++contextWrite;
      appliedOrganizationId = undefined;
      appliedStoreGeneration = undefined;
      const promise = (async () => {
        try {
          await bridgeTeamSetContext(bridge, { teamId: null, doc: null });
          // An old clear ACK must not reset bookkeeping for a later courier.
          if (
            !disposed &&
            write === contextWrite &&
            storeGeneration === getOrganizationStoreGeneration()
          ) {
            appliedOrganizationId = semanticOrganizationId;
            appliedStoreGeneration = storeGeneration;
          }
        } catch {
          /* engine gone / blip — next connect re-syncs */
        } finally {
          if (clearing?.write === write) clearing = undefined;
        }
      })();
      clearing = {
        organizationId: semanticOrganizationId,
        storeGeneration,
        write,
        promise,
      };
      return promise;
    };

    const schedule = () => {
      clearTimer();
      if (
        disposed ||
        running ||
        !documentIsVisible() ||
        authStatus !== "authenticated"
      )
        return;
      timer = setTimeout(
        () => {
          timer = undefined;
          pending = true;
          void sync();
        },
        Math.max(0, lastSyncStartedAt + RESYNC_INTERVAL_MS - performance.now()),
      );
    };

    const sync = async (): Promise<void> => {
      if (
        disposed ||
        running ||
        !documentIsVisible() ||
        authStatus !== "authenticated"
      ) {
        return;
      }
      clearTimer();
      running = true;
      pending = false;
      lastSyncStartedAt = performance.now();
      const epoch = observationEpoch;
      // Capture per request, not per effect. A same-status account switch can
      // clear the store before this hook's cleanup/remount.
      const storeGeneration = getOrganizationStoreGeneration();
      const current = () =>
        !disposed &&
        documentIsVisible() &&
        epoch === observationEpoch &&
        storeGeneration === getOrganizationStoreGeneration();
      try {
        await clearEngine(getActiveTeamId(), storeGeneration);
        if (!current()) return;
        const me = await controlPlane.me();
        if (!current()) return;
        let accepted = false;
        publishingOrganizationSnapshot = true;
        try {
          accepted = acceptOrganizationSnapshot(me, storeGeneration);
        } finally {
          publishingOrganizationSnapshot = false;
        }
        if (!accepted || !current()) return;
        // The accepted snapshot can normalize a deleted/legacy owner to
        // Personal. Clear that boundary before any asynchronous local repair.
        const wantId = getActiveTeamId();
        const organizations = desktopOrganizationChoices(me);
        const team =
          organizations.find((organization) => organization.id === wantId) ??
          organizations[0];
        await clearEngine(team?.id ?? null, storeGeneration);
        if (!current()) return;
        // Local ownership repair is independent from the settings courier. A
        // bridge restart should defer that idempotent repair, not prevent this
        // pass from refreshing the active organization's engine context.
        try {
          await reconcileOrganizationWorkspaceOwnership(me, current);
        } catch (error) {
          console.warn(
            "[organization] local workspace ownership repair deferred:",
            error instanceof Error ? error.message : error,
          );
        }
        if (!current()) return;
        // Personal is deliberately device-local. Clear the compatibility
        // engine team slot rather than fetching/persisting a cloud document.
        if (!team || team.isPersonal) {
          return;
        }
        const settings = await controlPlane.getOrganizationSettings(team.id);
        if (
          !current() ||
          !organizationContextStillSelected(team.id, getActiveTeamId())
        ) {
          return;
        }
        const write = ++contextWrite;
        await bridgeTeamSetContext(bridge, {
          teamId: team.id,
          doc: settings.doc ?? null,
        });
        if (current() && write === contextWrite) {
          appliedOrganizationId = team.id;
          appliedStoreGeneration = storeGeneration;
        }
      } catch (err) {
        // A same-owner transient failure retains the last context. Owner
        // changes and sign-out clear before the request, so stale settings can
        // never leak across organizations or accounts.
        // But never swallow SILENTLY: a permanent rejection (e.g. every call
        // 401ing after a sign-in provider migration, 2026-07-07) hid for days because
        // this catch was empty. The Team panel shows its own error UI
        // when opened; this log is the only trace for the background path.
        console.warn(
          "[team-sync] control-plane sync failed — team settings not refreshed:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        running = false;
        // Visibility/account state may advance before its event is delivered.
        // Preserve catch-up even if this observation retires ahead of that event.
        if (!current()) pending = true;
        if (pending && !disposed) {
          void sync();
        } else {
          schedule();
        }
      }
    };

    const kick = () => {
      // Publishing the fetched snapshot can synchronously update the semantic
      // hint. This pass already continues with that exact snapshot, so its own
      // listener notification must not enqueue a duplicate network round trip.
      if (disposed || publishingOrganizationSnapshot) return;
      observationEpoch += 1;
      pending = true;
      clearTimer();
      // Clearing is an account/owner boundary, not passive observation. Keep
      // it active while hidden, including same-id account-generation resets.
      void clearEngine(
        authStatus === "authenticated" ? getActiveTeamId() : null,
        getOrganizationStoreGeneration(),
      );
      void sync();
    };

    resyncListeners.add(kick);
    const unsubTeam = subscribeActiveTeam(kick);
    // Organization changes made in app.zeros.build become visible as soon as
    // the user returns from the browser, rather than after the 15-minute poll.
    const onFocus = () => {
      if (disposed || running || !documentIsVisible()) return;
      if (
        pending ||
        organizationContextShouldRefreshOnFocus(
          lastSyncStartedAt,
          performance.now(),
        )
      ) {
        pending = true;
        void sync();
      } else {
        schedule();
      }
    };
    const onVisibility = () => {
      if (documentIsVisible()) {
        onFocus();
      } else {
        observationEpoch += 1;
        if (running) pending = true;
        clearTimer();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    kick();
    return () => {
      disposed = true;
      clearTimer();
      resyncListeners.delete(kick);
      unsubTeam();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [bridge, bridgeStatus, authStatus, userId]);
}
