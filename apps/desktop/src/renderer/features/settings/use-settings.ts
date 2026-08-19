// ──────────────────────────────────────────────────────────
// Settings foundation — renderer hooks (bridge-backed)
// ──────────────────────────────────────────────────────────
//
// The renderer never touches settings files: it reads resolved settings (with
// per-leaf provenance) and raw layer documents over the bridge, and patches a
// layer through `settings.write`. Live across devices: any engine-side change
// (another device's write, an external editor, git checkout) arrives as a
// DB_CHANGED { kinds: ["settings"] } broadcast → hooks refetch.
// ──────────────────────────────────────────────────────────

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

// Settings documents are shared server state, not component state. A bounded
// renderer cache makes repo/section switches read an already-complete immutable
// snapshot while a DB_CHANGED broadcast revalidates it in the background.
const resolvedSettingsCache = new KeyedAsyncCache<ResolvedSettingsWire>(48);
const settingsLayerCache = new KeyedAsyncCache<SettingsReadWire>(48);
const SETTINGS_CACHE_MAX_AGE_MS = 30_000;
const MAX_BOOT_PREFETCH_REPOS = 8;
const scheduledSettingsRefreshes = new Map<string, () => void>();

/** Coalesce the synchronous fan-out from retained settings panels. Every
 * subscriber first marks its exact key stale; one microtask then performs the
 * read. A second DB event during that read is still observed by
 * KeyedAsyncCache and becomes one queued generation. */
function scheduleSettingsRefresh(id: string, refresh: () => void): void {
  const alreadyScheduled = scheduledSettingsRefreshes.has(id);
  scheduledSettingsRefreshes.set(id, refresh);
  if (alreadyScheduled) return;
  queueMicrotask(() => {
    const scheduled = scheduledSettingsRefreshes.get(id);
    scheduledSettingsRefreshes.delete(id);
    scheduled?.();
  });
}

function resolvedSettingsKey(repoRoot?: string, mainRepoRoot?: string): string {
  return JSON.stringify([repoRoot ?? null, mainRepoRoot ?? null]);
}

function settingsLayerKey(layerName: SettingsLayer, repoRoot?: string): string {
  return JSON.stringify([layerName, repoRoot ?? null]);
}

/** Bind a cache key to React with stable, immutable snapshots. */
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

/** Interaction-intent prefetch for repository rows and menus. */
export function prefetchSettingsForRepo(repoRoot: string): void {
  const bridge = getActiveBridge();
  if (!repoRoot || !bridge || bridge.status !== "connected") return;
  prefetchSettingsDocuments(bridge, repoRoot);
}

/** Warm the small settings documents that back global and repository forms.
 * Called once from the always-mounted top bar after project hydration so a
 * first Settings/repo-section switch can render from a complete snapshot. */
export function usePrefetchSettings(repoRoots: readonly string[]): void {
  useEffect(() => {
    let cancelWarm = () => {};
    const stop = onActiveBridgeConnected((bridge, { initial }) => {
      cancelWarm();
      const maxAgeMs = bridgeConnectionCacheMaxAge(
        initial,
        SETTINGS_CACHE_MAX_AGE_MS,
      );
      // Global settings are a common first destination and only two small reads.
      prefetchSettingsDocuments(bridge, undefined, maxAgeMs);
      // Repository warming is useful but nonessential. Keep it out of the bridge
      // connection's critical path so workspace/chat hydration wins cold start.
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

/** Invoke `onChange` on every engine settings broadcast (another device's
 *  write, an external editor, a git checkout). Shared by the hooks below and
 *  by settings-derived caches (e.g. the repo page's branch catalog). */
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
  refresh: () => void;
}

/** The effective settings tree (+ provenance) for the user scope, or for one
 *  repo when `repoRoot` is given. Pass `mainRepoRoot` to resolve a worktree's
 *  per-workspace view (repo-local from the main checkout, workspace-local from
 *  the worktree). */
export function useResolvedSettings(
  repoRoot?: string,
  mainRepoRoot?: string,
): UseResolvedSettings {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus();
  const key = resolvedSettingsKey(repoRoot, mainRepoRoot);
  const snapshot = useSettingsSnapshot(resolvedSettingsCache, key);

  // A manual or DB-triggered refresh bypasses freshness but never clears a
  // resolved document while the engine builds its replacement.
  const refresh = useCallback(() => {
    if (!bridge || bridgeStatus !== "connected") return;
    void resolvedSettingsCache
      .load(key, () => bridgeSettingsResolve(bridge, repoRoot, mainRepoRoot), {
        force: true,
      })
      .catch(() => {
        // Error lives in the shared snapshot; confirmed data remains visible.
      });
  }, [bridge, bridgeStatus, key, repoRoot, mainRepoRoot]);

  // All retained panels for this exact key hear the same broadcast. Mark the
  // key stale synchronously, then coalesce their reads into one microtask.
  const refreshFromBroadcast = useCallback(() => {
    if (!bridge || bridgeStatus !== "connected") return;
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
  }, [bridge, bridgeStatus, key, repoRoot, mainRepoRoot]);

  useEffect(() => {
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
    });
  }, [key, repoRoot, mainRepoRoot]);
  useSettingsChanged(refreshFromBroadcast);

  return {
    resolved: snapshot.data ?? null,
    loading:
      bridgeStatus === "connecting" && snapshot.data === undefined
        ? true
        : bridgeStatus === "connected"
          ? snapshot.loading
          : false,
    error:
      snapshot.error?.message ??
      ((!bridge || bridgeStatus === "disconnected") &&
      snapshot.data === undefined
        ? "Not connected to the engine."
        : null),
    refresh,
  };
}

export interface UseSettingsLayer {
  layer: SettingsReadWire | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Patch this layer (`null` leaf deletes a key). Resolves once persisted; the
   *  refreshed LAYER document is applied here, and the refreshed RESOLVED tree
   *  follows a moment later over the settings-changed broadcast, which the
   *  engine now echoes back to the writer too (dbChangedIncludesOriginator).
   *  A caller holding optimistic state should therefore yield it when a NEW
   *  resolved snapshot arrives, not when this promise settles. */
  write: (
    patch: SettingsDoc,
    options?: { confirmDesignDirectoryChange?: boolean },
  ) => Promise<void>;
  /** Overwrite this layer's file with RAW TOML text (the "Edit settings.toml"
   *  editor). Validated server-side; rejects unparseable TOML. Desktop-only. */
  writeRaw: (text: string) => Promise<void>;
}

/** One raw layer document (what the file actually says — not the merged
 *  view), plus a patch-writer. */
export function useSettingsLayer(
  layerName: SettingsLayer,
  repoRoot?: string,
): UseSettingsLayer {
  const bridge = useBridge();
  const bridgeStatus = useBridgeStatus();
  const key = settingsLayerKey(layerName, repoRoot);
  const snapshot = useSettingsSnapshot(settingsLayerCache, key);

  // Shared forced refresh: every mounted consumer observes one replacement
  // document and duplicate DB_CHANGED listeners coalesce onto one request.
  const refresh = useCallback(() => {
    if (!bridge || bridgeStatus !== "connected") return;
    void settingsLayerCache
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
    return onActiveBridgeConnected((client, { initial }) => {
      void settingsLayerCache
        .load(key, () => bridgeSettingsRead(client, layerName, repoRoot), {
          maxAgeMs: bridgeConnectionCacheMaxAge(
            initial,
            SETTINGS_CACHE_MAX_AGE_MS,
          ),
        })
        .catch(() => {});
    });
  }, [key, layerName, repoRoot]);
  useSettingsChanged(refreshFromBroadcast);

  const write = useCallback(
    async (
      patch: SettingsDoc,
      options: { confirmDesignDirectoryChange?: boolean } = {},
    ) => {
      if (!bridge || bridgeStatus !== "connected")
        throw new Error("engine bridge not connected");
      if (layerName === "managed")
        throw new Error("managed settings are read-only");
      const result = await bridgeSettingsWrite(
        bridge,
        layerName,
        patch,
        repoRoot,
        options,
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
      // Carry the just-written text so the editor's saved baseline matches (no
      // false "dirty"); the broadcast refresh re-reads the same bytes.
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

  return {
    layer: snapshot.data ?? null,
    loading:
      bridgeStatus === "connecting" && snapshot.data === undefined
        ? true
        : bridgeStatus === "connected"
          ? snapshot.loading
          : false,
    error:
      snapshot.error?.message ??
      ((!bridge || bridgeStatus === "disconnected") &&
      snapshot.data === undefined
        ? "Not connected to the engine."
        : null),
    refresh,
    write,
    writeRaw,
  };
}

/** A draft string seeded from a saved value that re-syncs ONLY when the user
 *  hasn't diverged — so a background settings change (another device, an
 *  external editor, an agent) never clobbers an unsaved edit. */
export function useSyncedDraft(saved: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(saved);
  const lastSaved = useRef(saved);
  useEffect(() => {
    // Capture the PREVIOUS synced value before advancing the ref. setDraft's
    // functional updater runs DEFERRED (React calls it during the next render),
    // while `lastSaved.current = saved` runs synchronously right here — so if the
    // updater read `lastSaved.current` directly it would always see the
    // already-advanced value and never adopt (the bug that left the raw editor
    // blank: saved="<987 chars>" but draft=""). Compare the live draft against
    // this captured `prev` instead — that's the correct "user hasn't diverged" test.
    const prev = lastSaved.current;
    lastSaved.current = saved;
    setDraft((d) => (d === prev ? saved : d));
  }, [saved]);
  return [draft, setDraft];
}
