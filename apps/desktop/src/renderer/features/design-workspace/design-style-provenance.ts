// Design style provenance — which declaration and token a value comes from.
//
// The frame runtime reports each authored property's winning declaration as
// written, where it lives, and the tokens it reads
// (`DesignRuntimeNodeDetails.authoredStyles`). These pure helpers turn that
// into what the inspector shows: the token name and the source that declares
// it, with the computed value as secondary detail. Older runtimes omit the
// field and every caller falls back to computed values.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeStyleOrigin,
} from "@zeros/protocol/design-runtime";

import { designWorkspaceSnapshotCache } from "./state/design-workspace-cache";

export type DesignStyleOriginLabel = (
  origin: Partial<DesignRuntimeStyleOrigin> | undefined,
) => string | null;

export interface DesignStyleTokenDisplay {
  /** Custom property name, including its leading dashes. */
  name: string;
  /** Resolved value of the token on the element. */
  value: string;
  /** Where the token is declared, such as "App styles" or "Manual". */
  source: string | null;
}

/** tokens.css is the theme editor's "Manual" source. */
export function designStyleOriginLabel(
  origin: Partial<DesignRuntimeStyleOrigin> | undefined,
  sourceTitles: ReadonlyMap<string, string>,
): string | null {
  switch (origin?.origin) {
    case "source":
      if (origin.sourceId === "@fonts") return "App fonts";
      return (origin.sourceId && sourceTitles.get(origin.sourceId)) || origin.sourceId || "Imported styles";
    case "linked":
      return origin.file === "tokens.css" ? "Manual" : (origin.file ?? "Linked stylesheet");
    case "frame":
      return "Frame styles";
    case "inline":
      return "Inline style";
    default:
      return null;
  }
}

/** The custom property a value displays: `var(--a)`, or for
 * `var(--a, var(--b))` the first one that resolves on the element. Null for
 * anything that is not a token reference, such as `calc()` or a literal. */
export function designStyleTokenReference(
  value: string,
  resolved: (name: string) => string | undefined,
): string | null {
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(value.trim());
  if (!match) return null;
  const [, name, fallback] = match;
  if (resolved(name!)?.trim()) return name!;
  if (fallback === undefined) return name!;
  return designStyleTokenReference(fallback, resolved);
}

/** The token a Style panel field shows for one property, if any. */
export function designStyleTokenDisplay(
  details: DesignRuntimeNodeDetails | null | undefined,
  property: string,
  label: DesignStyleOriginLabel,
): DesignStyleTokenDisplay | null {
  const authored = details?.authoredStyles?.[property];
  if (!authored) return null;
  const tokens = new Map((authored.tokens ?? []).map((token) => [token.name, token]));
  const name = designStyleTokenReference(authored.value, (candidate) => tokens.get(candidate)?.value);
  if (!name) return null;
  const token = tokens.get(name);
  return { name, value: token?.value ?? "", source: token?.origin ? label(token) : null };
}

/** Accessible and hover text for a token field. */
export function designStyleTokenDescription(token: DesignStyleTokenDisplay): string {
  return [token.name, token.source, token.value].filter(Boolean).join(" · ");
}

export interface DesignCssDeclarationHint {
  /** Computed value, when it differs from what is written. */
  computed: string | null;
  /** Where the winning declaration lives. */
  source: string | null;
}

/** Secondary detail for authored declarations the CSS panel shows: the
 * computed value when it differs from what is written, and the source when
 * the winner comes from an imported source or a linked stylesheet (the
 * frame's own CSS needs no label). */
export function designCssDeclarationHints(
  details: DesignRuntimeNodeDetails,
  computedValue: (property: string) => string,
  label: DesignStyleOriginLabel,
): Map<string, DesignCssDeclarationHint> {
  const hints = new Map<string, DesignCssDeclarationHint>();
  for (const [property, authored] of Object.entries(details.authoredStyles ?? {})) {
    const computed = computedValue(property).trim();
    const differs = computed !== "" && computed.replace(/\s+/g, " ") !== authored.value.replace(/\s+/g, " ");
    const source =
      authored.origin === "source" || authored.origin === "linked" ? label(authored) : null;
    if (!differs && !source) continue;
    hints.set(property, { computed: differs ? computed : null, source });
  }
  return hints;
}

/** Style source titles from the exact workspace's confirmed snapshot. */
export function useDesignStyleOriginLabel(
  workspaceId: string | null | undefined,
): DesignStyleOriginLabel {
  const subscribe = useCallback(
    (listener: () => void) =>
      workspaceId ? designWorkspaceSnapshotCache.subscribe(workspaceId, listener) : () => {},
    [workspaceId],
  );
  const read = useCallback(
    () =>
      workspaceId
        ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.styleSources
        : undefined,
    [workspaceId],
  );
  const sources = useSyncExternalStore(subscribe, read, read);
  return useCallback(
    (origin) =>
      designStyleOriginLabel(
        origin,
        new Map((sources ?? []).map((source) => [source.id, source.title])),
      ),
    [sources],
  );
}

/** The inspector's origin labels for the exact workspace it shows. Fields
 * outside an inspector (tests, other surfaces) show no tokens. */
export const DesignStyleOriginLabelContext =
  createContext<DesignStyleOriginLabel | null>(null);

/** The token a field shows for one property of the selected element. */
export function useDesignStyleToken(
  details: DesignRuntimeNodeDetails | null | undefined,
  property: string,
): { tokenName?: string; tokenDescription?: string } {
  const label = useContext(DesignStyleOriginLabelContext);
  return useMemo(() => {
    const token = label ? designStyleTokenDisplay(details, property, label) : null;
    return token
      ? { tokenName: token.name, tokenDescription: designStyleTokenDescription(token) }
      : {};
  }, [details, label, property]);
}
