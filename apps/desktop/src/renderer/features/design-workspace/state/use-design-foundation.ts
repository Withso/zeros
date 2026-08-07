// React binding for one exact authored Design Foundation generation.

import { useCachedRead } from "../../../state/use-cached-read";
import {
  designFoundationCache,
  designFoundationKey,
  fetchDesignFoundation,
} from "./design-workspace-cache";

export function useDesignFoundation(
  workspaceId: string | null | undefined,
  frame: string | null | undefined,
  sourceVersion: string | null | undefined,
  active = true,
) {
  const key =
    workspaceId && frame && sourceVersion
      ? designFoundationKey(workspaceId, frame, sourceVersion)
      : null;
  return useCachedRead(
    designFoundationCache,
    key,
    fetchDesignFoundation,
    // The renderer source generation is part of the key. An exact-key result
    // remains valid indefinitely; code/Git edits produce a different key.
    { maxAgeMs: Number.POSITIVE_INFINITY, enabled: active },
  );
}
