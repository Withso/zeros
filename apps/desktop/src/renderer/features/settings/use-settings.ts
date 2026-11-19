
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  bridgeSettingsRead,
  bridgeSettingsResolve,
  bridgeSettingsWrite,
  bridgeSettingsWriteRaw,
  type ResolvedSettingsWire,
  type SettingsDoc,
  type SettingsLayer,
  type SettingsReadWire,
} from "../../platform/bridge/workspace-bridge";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import {
  bridgeConnectionCacheMaxAge,
  getActiveBridge,
  onActiveBridgeConnected,
} from "../../platform/bridge/active-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import {
  KeyedAsyncCache,
  type AsyncCacheSnapshot,
} from "../../shared/lib/keyed-async-cache";
import { useReadRecovery } from "../../state/use-read-recovery";
import { useDocumentActive } from "../../state/use-document-active";

// Reuse exact-key snapshots across panels while engine broadcasts revalidate them.
const resolvedSettingsCache = new KeyedAsyncCache<ResolvedSettingsWire>(48);
const settingsLayerCache = new KeyedAsyncCache<SettingsReadWire>(48);
const SETTINGS_CACHE_MAX_AGE_MS = 30_000;
const MAX_BOOT_PREFETCH_REPOS = 8;
const scheduledSettingsRefreshes = new Map<string, { refresh: () => void }>();

// Coalesce one event's reads after synchronous invalidation; a later event during I/O still queues another generation.
function scheduleSettingsRefresh(id: string, refresh: () => void): void {
  const queued = scheduledSettingsRefreshes.get(id);
  if (queued) {
    queued.refresh = refresh;
    return;
  }
  const pending = { refresh };
  scheduledSettingsRefreshes.set(id, pending);
  queueMicrotask(() => {
    scheduledSettingsRefreshes.delete(id);
    pending.refresh();
  });
}

function resolvedSettingsKey(repoRoot?: string, mainRepoRoot?: string): string {
  return JSON.stringify([repoRoot ?? null, mainRepoRoot ?? null]);
}

function settingsLayerKey(layerName: SettingsLayer, repoRoot?: string): string {
  return JSON.stringify([layerName, repoRoot ?? null]);
}

export function primeSettingsLayer(layer: SettingsLayer, repoRoot: string | undefined, result: Pick<SettingsReadWire, "path" | "doc">): void {
  settingsLayerCache.setData(settingsLayerKey(layer, repoRoot), { ...result, layer, exists: true });
}

function useSettingsSnapshot<T>(
  cache: KeyedAsyncCache<T>,
  key: string,
): AsyncCacheSnapshot<T> {
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(key, listener),
    [cache, key],
  );
  const getSnapshot = useCallback(() => cache.getSnapshot(key), [cache, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function prefetchSettingsDocuments(
  bridge: RuntimeClient,
  root?: string,
  maxAgeMs = SETTINGS_CACHE_MAX_AGE_MS,
): void {
  const resolvedKey = resolvedSettingsKey(root);
  void resolvedSettingsCache
    .load(resolvedKey, () => bridgeSettingsResolve(bridge, root), {
      maxAgeMs,
    })
    .catch(() => {});
  const layerName: SettingsLayer = root ? "repo-local" : "user";
  const layerKey = settingsLayerKey(layerName, root);
  void settingsLayerCache
    .load(layerKey, () => bridgeSettingsRead(bridge, layerName, root), {
      maxAgeMs,
    })
    .catch(() => {});
}

export function prefetchSettingsForRepo(repoRoot: string): void {
  const bridge = getActiveBridge();
  if (!repoRoot || !bridge || bridge.status !== "connected") return;
  prefetchSettingsDocuments(bridge, repoRoot);
}

export function usePrefetchSettings(repoRoots: readonly string[]): void {
  useEffect(() => {
    let cancelWarm = () => {};
    const stop = onActiveBridgeConnected((bridge, { initial }) => {
      cancelWarm();
      const maxAgeMs = bridgeConnectionCacheMaxAge(
        initial,
        SETTINGS_CACHE_MAX_AGE_MS,
      );
      prefetchSettingsDocuments(bridge, undefined, maxAgeMs);
      // Warm repositories off the connection's critical path so workspace and chat hydration go first.
      const roots = [...new Set(repoRoots)].slice(0, MAX_BOOT_PREFETCH_REPOS);
      const warmRepos = () => {
        for (const root of roots) {
          prefetchSettingsDocuments(bridge, root, maxAgeMs);
        }
      };
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(warmRepos, { timeout: 1_000 });
        cancelWarm = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(warmRepos, 0);
        cancelWarm = () => window.clearTimeout(id);
      }
    });
    return () => {
      cancelWarm();
      stop();
    };
  }, [repoRoots]);
}

// Settings broadcasts include writes from other clients, external edits, and Git checkouts.
export function useSettingsChanged(onChange: () => void): void {
  const bridge = useBridge();
  useEffect(() => {
    if (!bridge) return;
    return bridge.on("DB_CHANGED", (msg) => {
      const kinds = (msg as { kinds?: unknown }).kinds;
      if (Array.isArray(kinds) && kinds.includes("settings")) onChange();
    });
  }, [bridge, onChange]);
}

export interface UseResolvedSettings {
  resolved: ResolvedSettingsWire | null;
  loading: boolean;
  error: string | null;
  /** Raw failure for write safety; presentation may still be recovering. */
  readError: string | null;
  refresh: () => void;
}

// Pass the main checkout root so linked worktrees share its personal settings file.
export function useResolvedSettings(
  repoRoot?: string,
  mainRepoRoot?: string,
  enabled = true,
): UseResolvedSettings {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus(repoRoot);
  const active = useDocumentActive(enabled);
  const key = resolvedSettingsKey(repoRoot, mainRepoRoot);
  const snapshot = useSettingsSnapshot(resolvedSettingsCache, key);

  // A forced refresh must not clear the last confirmed document.
  const refresh = useCallback(() => {
    if (!enabled || !bridge || bridgeStatus !== "connected") return;
    return resolvedSettingsCache
      .load(key, () => bridgeSettingsResolve(bridge, repoRoot, mainRepoRoot), {
        force: true,
      })
      .catch(() => {
        // Error lives in the shared snapshot; confirmed data remains visible.
      });
  }, [enabled, bridge, bridgeStatus, key, repoRoot, mainRepoRoot]);

  const refreshFromBroadcast = useCallback(() => {
    if (!enabled || !bridge || bridgeStatus !== "connected") return;
    resolvedSettingsCache.invalidate(key);
    scheduleSettingsRefresh(`resolved:${key}`, () => {
      void resolvedSettingsCache
        .load(
          key,
          () => bridgeSettingsResolve(bridge, repoRoot, mainRepoRoot),
          { maxAgeMs: -1 },
        )
        .catch(() => {});
    });
  }, [enabled, bridge, bridgeStatus, key, repoRoot, mainRepoRoot]);

  useEffect(() => {
    if (!active) return;
    return onActiveBridgeConnected((client, { initial }) => {
      void resolvedSettingsCache
        .load(
          key,
          () => bridgeSettingsResolve(client, repoRoot, mainRepoRoot),
          {
            maxAgeMs: bridgeConnectionCacheMaxAge(
              initial,
              SETTINGS_CACHE_MAX_AGE_MS,
            ),
          },
        )
        .catch(() => {});
    }, repoRoot);
  }, [active, key, repoRoot, mainRepoRoot]);
  useSettingsChanged(refreshFromBroadcast);
  const recovery = useReadRecovery(`settings-resolved:${key}`, {
    error: snapshot.error,
    pending: snapshot.loading || snapshot.refreshing,
    hasContent: snapshot.data !== undefined,
    retry: refresh,
    connected: bridgeStatus === "connected",
    active,
    folder: repoRoot,
  });

  return {
    resolved: snapshot.data ?? null,
    loading: snapshot.data === undefined && (bridgeStatus !== "connected" || recovery.pending),
    error: recovery.error?.message ?? null,
    readError: recovery.readError?.message ?? null,
    refresh,
  };
}

export interface UseSettingsLayer {
  layer: SettingsReadWire | null;
  loading: boolean;
  error: string | null;
  /** Raw failure for write safety; presentation may still be recovering. */
  readError: string | null;
  refresh: () => void;
  // Null deletes a leaf. The ACK updates the raw layer; yield optimistic state only to a newer resolved snapshot after the writer's echo (dbChangedIncludesOriginator).
  write: (patch: SettingsDoc) => Promise<void>;
  // Raw TOML is desktop-only and must parse before the engine writes it.
  writeRaw: (text: string) => Promise<void>;
}

export function useSettingsLayer(
  layerName: SettingsLayer,
  repoRoot?: string,
): UseSettingsLayer {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus(repoRoot);
  const active = useDocumentActive(true);
  const key = settingsLayerKey(layerName, repoRoot);
  const snapshot = useSettingsSnapshot(settingsLayerCache, key);

  const refresh = useCallback(() => {
    if (!bridge || bridgeStatus !== "connected") return;
    return settingsLayerCache
      .load(key, () => bridgeSettingsRead(bridge, layerName, repoRoot), {
        force: true,
      })
      .catch(() => {});
  }, [bridge, bridgeStatus, key, layerName, repoRoot]);

  const refreshFromBroadcast = useCallback(() => {
    if (!bridge || bridgeStatus !== "connected") return;
    settingsLayerCache.invalidate(key);
    scheduleSettingsRefresh(`layer:${key}`, () => {
      void settingsLayerCache
        .load(key, () => bridgeSettingsRead(bridge, layerName, repoRoot), {
          maxAgeMs: -1,
        })
        .catch(() => {});
    });
  }, [bridge, bridgeStatus, key, layerName, repoRoot]);

  useEffect(() => {
    if (!active) return;
    return onActiveBridgeConnected((client, { initial }) => {
      void settingsLayerCache
        .load(key, () => bridgeSettingsRead(client, layerName, repoRoot), {
          maxAgeMs: bridgeConnectionCacheMaxAge(
            initial,
            SETTINGS_CACHE_MAX_AGE_MS,
          ),
        })
        .catch(() => {});
    }, repoRoot);
  }, [active, key, layerName, repoRoot]);
  useSettingsChanged(refreshFromBroadcast);

  const write = useCallback(
    async (patch: SettingsDoc) => {
      if (!bridge || bridgeStatus !== "connected")
        throw new Error("engine bridge not connected");
      if (layerName === "managed")
        throw new Error("managed settings are read-only");
      const result = await bridgeSettingsWrite(
        bridge,
        layerName,
        patch,
        repoRoot,
      );
      settingsLayerCache.setData(key, {
        layer: layerName,
        path: result.path,
        doc: result.doc,
        exists: true,
      });
    },
    [bridge, bridgeStatus, key, layerName, repoRoot],
  );

  const writeRaw = useCallback(
    async (text: string) => {
      if (!bridge || bridgeStatus !== "connected")
        throw new Error("engine bridge not connected");
      if (layerName === "managed")
        throw new Error("managed settings are read-only");
      const result = await bridgeSettingsWriteRaw(
        bridge,
        layerName,
        text,
        repoRoot,
      );
      // Keep the exact saved text so the editor does not mark it dirty before revalidation.
      settingsLayerCache.setData(key, {
        layer: layerName,
        path: result.path,
        doc: result.doc,
        exists: true,
        text,
      });
    },
    [bridge, bridgeStatus, key, layerName, repoRoot],
  );
  const recovery = useReadRecovery(`settings-layer:${key}`, {
    error: snapshot.error,
    pending: snapshot.loading || snapshot.refreshing,
    hasContent: snapshot.data !== undefined,
    retry: refresh,
    connected: bridgeStatus === "connected",
    active,
    folder: repoRoot,
  });

  return {
    layer: snapshot.data ?? null,
    loading: snapshot.data === undefined && (bridgeStatus !== "connected" || recovery.pending),
    error: recovery.error?.message ?? null,
    readError: recovery.readError?.message ?? null,
    refresh,
    write,
    writeRaw,
  };
}

// Refresh only untouched drafts; a background read must not replace unsaved edits.
export function useSyncedDraft(saved: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(saved);
  const lastSaved = useRef(saved);
  useEffect(() => {
    // Capture the prior saved value before the deferred updater can observe the advanced ref.
    const prev = lastSaved.current;
    lastSaved.current = saved;
    setDraft((d) => (d === prev ? saved : d));
  }, [saved]);
  return [draft, setDraft];
}
