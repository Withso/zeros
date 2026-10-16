import { useCallback, useEffect, useSyncExternalStore } from "react";
import { safeToolImageSource } from "@zeros/protocol/tool-artwork";
import { KeyedAsyncCache } from "../shared/lib/keyed-async-cache";
import { nativeInvoke, useNativeRuntime } from "./runtime";

function safeAppName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 200 ? name : null;
}

export function createNativeAppArtworkResource(
  read: (bundleIds: string[]) => Promise<Record<string, string | null>>,
  sanitize: (value: unknown) => string | null = (value) =>
    safeToolImageSource(value) ?? null,
) {
  const cache = new KeyedAsyncCache<string | null>({
    maxEntries: 128,
    maxWeight: 4 * 1024 * 1024,
    weightOf: (value) => value?.length ?? 0,
  });
  const pending = new Map<string, (icon: string | null) => void>();
  let scheduled = false;
  const flush = async () => {
    const batch = [...pending].slice(0, 16);
    for (const [id] of batch) pending.delete(id);
    const result = await read(batch.map(([id]) => id)).catch(
      () => ({}) as Record<string, string | null>,
    );
    for (const [id, settle] of batch) settle(sanitize(result?.[id]));
    scheduled = false;
    if (pending.size) {
      scheduled = true;
      queueMicrotask(() => void flush());
    }
  };
  const load = (id: string) =>
    cache.load(
      id,
      () =>
        new Promise<string | null>((settle) => {
          pending.set(id, settle);
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => void flush());
          }
        }),
      { maxAgeMs: 60_000 },
    );
  return { cache, load };
}

type NativeCommand =
  | "native_app_icons"
  | "native_app_names"
  | "tool_artwork_images";
type ImageResult = Record<string, string | null>;
const resources = new WeakMap<
  object,
  Map<NativeCommand, ReturnType<typeof createNativeAppArtworkResource>>
>();
const unavailable = createNativeAppArtworkResource(async () => ({}));
function readNative(command: NativeCommand, ids: string[]) {
  switch (command) {
    case "native_app_icons":
      return nativeInvoke<ImageResult>("native_app_icons", { bundleIds: ids });
    case "native_app_names":
      return nativeInvoke<ImageResult>("native_app_names", { bundleIds: ids });
    case "tool_artwork_images":
      return nativeInvoke<ImageResult>("tool_artwork_images", { urls: ids });
  }
}
function currentResource(command: NativeCommand) {
  const bridge =
    typeof window !== "undefined" ? window.__ZEROS_NATIVE__ : undefined;
  if (!bridge) return unavailable;
  let commands = resources.get(bridge);
  if (!commands) {
    commands = new Map();
    resources.set(bridge, commands);
  }
  let resource = commands.get(command);
  if (!resource) {
    resource = createNativeAppArtworkResource(
      (ids) => {
        if (window.__ZEROS_NATIVE__ !== bridge) return Promise.resolve({});
        return readNative(command, ids);
      },
      command === "native_app_names" ? safeAppName : undefined,
    );
    commands.set(command, resource);
  }
  return resource;
}

function nativeBundleId(bundleId: string | undefined): string {
  return bundleId &&
    bundleId.length <= 255 &&
    /^[\w-]+(?:\.[\w-]+)+$/.test(bundleId)
    ? bundleId
    : "";
}

export function useNativeAppIcon(
  bundleId: string | undefined,
  active: boolean,
): string | null {
  useNativeRuntime();
  const resource = currentResource("native_app_icons");
  return useCachedArtwork(resource, nativeBundleId(bundleId), active);
}

/** The installed app's name, or null until Launch Services answers or when
 * the app is not installed. */
export function useNativeAppName(
  bundleId: string | undefined,
  active: boolean,
): string | null {
  useNativeRuntime();
  const resource = currentResource("native_app_names");
  return useCachedArtwork(resource, nativeBundleId(bundleId), active);
}

export function useToolArtworkImage(
  source: unknown,
  active: boolean,
): string | null {
  const { ready: native } = useNativeRuntime();
  const safe = safeToolImageSource(source);
  const id = safe?.startsWith("https:") && native ? safe : "";
  const resolved = useCachedArtwork(
    currentResource("tool_artwork_images"),
    id,
    active,
  );
  return id ? resolved : (safe ?? null);
}

function useCachedArtwork(
  resource: ReturnType<typeof createNativeAppArtworkResource>,
  id: string,
  active: boolean,
): string | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      id ? resource.cache.subscribe(id, listener) : () => {},
    [resource, id],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => resource.cache.getSnapshot(id),
    () => resource.cache.getSnapshot(id),
  );
  useEffect(() => {
    if (id && active) void resource.load(id);
  }, [id, active, resource]);
  return snapshot.data ?? null;
}
