import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { designImageResidency, type DesignImageLease } from "./design-image-residency";

/** React can batch several ready images into one commit. Keep ownership of
 * every published value, including ones it skips, until DOM replacement or
 * unmount actually releases them. No resource is allocated during render. */
export function useDesignImageState<T extends { lease: DesignImageLease }>(): [T | null, (next: T | null) => void] {
  const [shown, setShown] = useState<T | null>(null);
  const owned = useRef(new Set<T>());
  const pending = useRef<T | null>(null);
  const publish = useCallback((next: T | null) => {
    if (next) owned.current.add(next);
    pending.current = next;
    setShown(next);
  }, []);
  useLayoutEffect(() => {
    for (const entry of owned.current) {
      if (entry === shown || entry === pending.current) continue;
      owned.current.delete(entry);
      entry.lease.release();
    }
  });
  useLayoutEffect(() => {
    const entries = owned.current;
    return () => {
      for (const entry of entries) entry.lease.release();
      entries.clear();
    };
  }, []);
  return [shown, publish];
}

/** Runtime-store images already have an encoded-data guard. A displayed copy
 * also needs pixel admission, and may outlive its store entry during a swap. */
export function useDesignImageDisplay<T extends { dataUrl: string; width: number; height: number }>(
  image: T | null | undefined,
  active: boolean,
): T | null {
  const dataUrl = active ? image?.dataUrl : undefined;
  const width = image?.width;
  const height = image?.height;
  const [owned, setOwned] = useDesignImageState<{ dataUrl: string; width: number; height: number; lease: DesignImageLease }>();
  useLayoutEffect(() => {
    if (!dataUrl || !width || !height) {
      setOwned(null);
      return;
    }
    const admit = () => {
      const lease = designImageResidency.acquire(dataUrl, width, height, dataUrl.length * 2);
      if (!lease) return false;
      setOwned({ dataUrl, width, height, lease });
      return true;
    };
    if (admit()) return;
    setOwned(null);
    let done = false;
    const unsubscribe = designImageResidency.subscribeAvailable(() => {
      if (!done && admit()) { done = true; unsubscribe(); }
    });
    return () => { done = true; unsubscribe(); };
  }, [dataUrl, width, height, setOwned]);
  return active && image && owned?.dataUrl === image.dataUrl && owned.width === image.width && owned.height === image.height ? image : null;
}
