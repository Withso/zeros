import {
  acceptPersonalPreferences,
  legacyPersonalPreferences,
  onPendingPreferences,
  pendingPreferences,
} from "../../platform/personal-preferences";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { isNativeRuntime } from "../../platform/runtime";
import { toast } from "../../shared/ui/primitives/elements";

/** One serialized writer, scoped to this device. Synchronous stores are caches;
 * acknowledged TOML values hydrate them, and edits made during a read win over
 * that old response. Unacknowledged edits survive reconnect/relaunch. */
export function startPersonalPreferencesSync(
  bridge: RuntimeClient,
): () => void {
  let disposed = false,
    running = false,
    requested = false,
    initialized = false;
  let connectionEpoch = 0;
  let failures = 0;
  let notified = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const noticeId = "personal-preferences-sync";
  const local = () =>
    !disposed &&
    isNativeRuntime() &&
    bridge.status === "connected" &&
    bridge.executionIdentity.kind === "local";
  const refresh = () => {
    requested = true;
    if (running || !local()) return;
    if (retry) clearTimeout(retry);
    retry = undefined;
    running = true;
    void (async () => {
      try {
        while (requested && local()) {
          requested = false;
          const sent = pendingPreferences();
          const epoch = connectionEpoch;
          const writing = !initialized || sent.size > 0;
          let result: unknown;
          try {
            result = writing
              ? await workspaceOp(bridge, "settings.syncPreferences", {
                  legacy: legacyPersonalPreferences(),
                  changes: Object.fromEntries(
                    [...sent].map(([key, entry]) => [key, entry.value]),
                  ),
                })
              : ((await workspaceOp(bridge, "settings.read", {
                  layer: "user",
                })) as { doc: { preferences?: unknown }; error?: string });
          } catch (error) {
            if (epoch !== connectionEpoch) continue;
            throw error;
          }
          if (!local()) break;
          if (epoch !== connectionEpoch) continue;
          if (!writing) {
            const read = result as {
              doc: { preferences?: unknown };
              error?: string;
            };
            if (read.error) throw new Error(read.error);
            acceptPersonalPreferences(read.doc.preferences ?? {}, sent);
          } else acceptPersonalPreferences(result, sent);
          initialized = true;
          failures = 0;
          if (notified) {
            toast.dismiss(noticeId);
            notified = false;
          }
          if (pendingPreferences().size) requested = true;
        }
      } catch {
        if (local()) {
          failures += 1;
          if (failures > 1 && !notified) {
            notified = true;
            toast.error(
              "Personal preferences could not be saved or refreshed. Pending choices are kept on this device and will retry.",
              { id: noticeId, duration: Infinity },
            );
          }
          retry = setTimeout(() => {
            retry = undefined;
            refresh();
          }, Math.min(30_000, 1_500 * 2 ** Math.min(failures - 1, 5)));
        }
      } finally {
        running = false;
      }
    })();
  };
  const offPending = onPendingPreferences(refresh);
  const offStatus = bridge.onStatusChange((status) => {
    connectionEpoch += 1;
    if (retry) clearTimeout(retry);
    retry = undefined;
    failures = 0;
    if (status === "connected") {
      initialized = false;
      refresh();
    }
  });
  const offDb = bridge.on("DB_CHANGED", (message) => {
    if ((message as { kinds?: string[] }).kinds?.includes("settings"))
      refresh();
  });
  window.addEventListener("focus", refresh);
  refresh();
  return () => {
    disposed = true;
    if (retry) clearTimeout(retry);
    if (notified) toast.dismiss(noticeId);
    offPending();
    offStatus();
    offDb();
    window.removeEventListener("focus", refresh);
  };
}
