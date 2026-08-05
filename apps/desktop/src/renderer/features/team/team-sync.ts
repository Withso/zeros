// ──────────────────────────────────────────────────────────
// Team → engine sync (O4c). The renderer owns the control-plane session,
// so IT fetches the active team's settings doc and couriers it into the
// engine's in-memory slot (team.setContext). (The shared-secrets vault
// was removed 2026-07-22 — the courier now carries the settings doc
// only, no decrypted values.)
//
// Sync triggers: bridge (re)connect, sign-in/out, active-team change, a
// 15-minute refresh, and an explicit requestTeamResync() after settings
// mutations or team membership changes.
//
// Correctness properties (audit 2026-07-04):
//   • Local bridge only — the engine operation rejects remote callers.
//   • Signed out → courier an EMPTY context so a prior account's team
//     settings do not linger in engine memory across accounts.
//   • The ACTIVE team (active-team.ts), not teams[0], drives what's synced,
//     so the panel's switcher and the engine agree. Zero teams is a
//     supported state → the context clears.
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
  const { status: authStatus } = useAuth();

  useEffect(() => {
    // LOCAL bridge only: the engine op is local-only.
    if (!CONTROL_PLANE_URL || !isNativeRuntime()) return;
    if (!bridge || bridgeStatus !== "connected") return;

    let disposed = false;
    let running = false; // exactly one sync in flight at a time
    let pending = false; // a request arrived while one was running → run once more

    const clearEngine = async () => {
      try {
        await bridgeTeamSetContext(bridge, { teamId: null, doc: null });
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
      try {
        // Signed out → clear the engine's team context (don't leave a prior
        // account's team settings resident).
        if (authStatus !== "authenticated") {
          await clearEngine();
          return;
        }
        const me = await controlPlane.me();
        // Honor the panel's selection; fall back to the first team. A user
        // with NO teams is a normal state now — the context clears.
        const wantId = getActiveTeamId();
        const team = me.teams.find((t) => t.id === wantId) ?? me.teams[0];
        if (disposed) return;
        if (!team) {
          await clearEngine();
          return;
        }
        const settings = await controlPlane.getTeamSettings(team.id);
        if (disposed) return;
        await bridgeTeamSetContext(bridge, {
          teamId: team.id,
          doc: settings.doc ?? null,
        });
      } catch (err) {
        // Signed out mid-flight / control plane unreachable — leave the
        // last-couriered context in place rather than blanking it on a
        // transient error. Sign-out clears explicitly.
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

    const kick = () => void sync();

    void sync();
    const timer = setInterval(() => void sync(), RESYNC_INTERVAL_MS);
    resyncListeners.add(kick);
    const unsubTeam = subscribeActiveTeam(kick);
    return () => {
      disposed = true;
      clearInterval(timer);
      resyncListeners.delete(kick);
      unsubTeam();
    };
  }, [bridge, bridgeStatus, authStatus]);
}
