import {
  acceptAgentPreferences,
  onPendingAgentPreferences,
  pendingAgentPreferences,
  registerAgentPreferencesFlush,
} from "../../platform/agent-preferences";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { isNativeRuntime } from "../../platform/runtime";
import { toast } from "../../shared/ui/primitives/elements";
import {
  hydrateModelsFromSettings,
  legacyModelPreferences,
} from "../agent/new-chat-defaults";
import {
  hydrateProviderPreferences,
  legacyProviderPreferences,
} from "./provider-prefs";

/** Serialized, acknowledged user-file sync. Reconnects reject stale responses;
 * file deletion clears caches; pending leaf edits overlay external refreshes. */
export function startAgentPreferencesSync(bridge: RuntimeClient): () => void {
  const lifetime = new AbortController();
  let disposed = false,
    requested = false,
    initialized = false,
    epoch = 0;
  let running: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const legacy = {
    models: legacyModelPreferences(),
    providers: legacyProviderPreferences(),
  };
  const ownsLocal = () =>
    !disposed &&
    isNativeRuntime() &&
    bridge.executionIdentity.kind === "local";
  const local = () => ownsLocal() && bridge.status === "connected";
  const refresh = (): Promise<void> => {
    requested = true;
    if (running) return running;
    if (!local()) return Promise.resolve();
    if (retry) {
      clearTimeout(retry);
      retry = undefined;
    }
    running = (async () => {
      while (requested && local()) {
        requested = false;
        const sent = pendingAgentPreferences(),
          generation = epoch;
        let response: Record<string, unknown>;
        try {
          if (!initialized || sent.size) {
            response = (await workspaceOp(
              bridge,
              "settings.syncAgentPreferences",
              {
                legacy,
                changes: [...sent.values()].map(({ path, value }) => ({
                  path,
                  value,
                })),
              },
            )) as Record<string, unknown>;
          } else {
            const read = (await workspaceOp(bridge, "settings.read", {
              layer: "user",
            })) as { doc: Record<string, unknown>; error?: string };
            if (read.error) throw new Error(read.error);
            response = read.doc;
          }
        } catch (error) {
          if (generation !== epoch) continue;
          throw error;
        }
        if (!local()) break;
        if (generation !== epoch) continue;
        const doc = acceptAgentPreferences(response, sent);
        hydrateModelsFromSettings(doc.models ?? {}, true);
        hydrateProviderPreferences(doc.providers ?? {});
        initialized = true;
        failures = 0;
        if (pendingAgentPreferences().size) requested = true;
      }
    })()
      .catch((error: unknown) => {
        if (local()) {
          failures += 1;
          if (failures === 1)
            toast.error(
              "Agent settings could not be saved or refreshed. Pending choices are kept on this device and will retry.",
            );
          retry = setTimeout(
            () => {
              retry = undefined;
              trigger();
            },
            Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)),
          );
        }
        throw error;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  const trigger = () => {
    void refresh().catch(() => {
      /* reported above; outbox retained */
    });
  };
  const offPending = onPendingAgentPreferences(trigger);
  const offStatus = bridge.onStatusChange((status) => {
    epoch += 1;
    if (status === "connected") {
      initialized = false;
      trigger();
    }
  });
  const offDb = bridge.on("DB_CHANGED", (message) => {
    if ((message as { kinds?: string[] }).kinds?.includes("settings"))
      trigger();
  });
  const offFlush =
    bridge.executionIdentity.kind === "local"
      ? registerAgentPreferencesFlush(async () => {
          // Restoring a chat can reach provider setup before the Local engine
          // connects. Wait for readiness, then require the usual settings ACK.
          // Match the workbench's Local startup grace and retire with this sync.
          const deadline = Date.now() + 45_000;
          do {
            if (!ownsLocal())
              throw new Error(
                "Connect to the local engine to save agent settings.",
              );
            await bridge.waitUntilReady({
              signal: lifetime.signal,
              timeoutMs: Math.max(0, deadline - Date.now()),
            });
            await refresh();
            // A disconnect can retire readiness or the settings response before
            // this continuation runs. Rejoin within the original startup bound.
          } while (!local());
          if (pendingAgentPreferences().size)
            throw new Error("Agent settings are still waiting to be saved.");
        })
      : () => {};
  window.addEventListener("focus", trigger);
  trigger();
  return () => {
    disposed = true;
    lifetime.abort();
    if (retry) clearTimeout(retry);
    offPending();
    offStatus();
    offDb();
    offFlush();
    window.removeEventListener("focus", trigger);
  };
}
