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

import { designTokenDetachHint } from "./design-token-catalog";
import { useDesignTokenDetach, useDesignTokens } from "./design-token-context";
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

/** The shorthands that can set a longhand whole, nearest first. */
function designStyleShorthands(property: string): readonly string[] {
  let shorthands = SHORTHANDS.get(property);
  if (!shorthands) {
    shorthands = shorthandsFor(property);
    SHORTHANDS.set(property, shorthands);
  }
  return shorthands;
}

const SHORTHANDS = new Map<string, readonly string[]>();

function shorthandsFor(property: string): string[] {
  const side = /^(padding|margin)-(?:top|right|bottom|left)$/.exec(property);
  if (side) return [side[1]!];
  if (property === "row-gap" || property === "column-gap") return ["gap"];
  if (/^border-(?:top|bottom)-(?:left|right)-radius$/.test(property)) return ["border-radius"];
  const border = /^border-(?:top|right|bottom|left)-(width|style|color)$/.exec(property);
  if (border) return [`border-${border[1]}`];
  return [];
}

/** The token a Style panel field shows for one property, if any: its own
 * declaration's, else a shorthand's that sets it whole (`padding:
 * var(--space-4)` for each padding side). */
export function designStyleTokenDisplay(
  details: DesignRuntimeNodeDetails | null | undefined,
  property: string,
  label: DesignStyleOriginLabel,
): DesignStyleTokenDisplay | null {
  const authored =
    details?.authoredStyles?.[property] ??
    designStyleShorthands(property)
      .map((shorthand) => details?.authoredStyles?.[shorthand])
      .find(Boolean);
  if (!authored) return null;
  // Fields render often; a declaration is parsed once per snapshot entry.
  let name = TOKEN_REFERENCES.get(authored);
  if (name === undefined) {
    const tokens = new Map((authored.tokens ?? []).map((token) => [token.name, token]));
    name = designStyleTokenReference(authored.value, (candidate) => tokens.get(candidate)?.value);
    TOKEN_REFERENCES.set(authored, name);
  }
  if (!name) return null;
  const token = authored.tokens?.find((candidate) => candidate.name === name);
  return { name, value: token?.value ?? "", source: token?.origin ? label(token) : null };
}

const TOKEN_REFERENCES = new WeakMap<object, string | null>();

/** What Detach writes: on each selected layer, the value each property
 * computes to there. A layer with no reading for a property keeps its token
 * for it, so Detach never removes a declaration; layers with nothing to
 * write are left out. */
export function designDetachedStyles(
  nodeIds: readonly string[],
  properties: readonly string[],
  computed: (nodeId: string, property: string) => string | undefined,
): { nodeId: string; styles: Record<string, string> }[] {
  return nodeIds.flatMap((nodeId) => {
    const styles: Record<string, string> = {};
    for (const property of properties) {
      const value = computed(nodeId, property)?.trim();
      if (value) styles[property] = value;
    }
    return Object.keys(styles).length > 0 ? [{ nodeId, styles }] : [];
  });
}

/** The style writes of one commit across the selection, before position
 * context: every layer gets `styles`, or with `perNode` its own values, and
 * a layer given nothing of its own gets no operation. */
export function designSelectionStyleUpdates(
  nodeIds: readonly string[],
  styles: Record<string, string | null>,
  perNode?: (nodeId: string) => Record<string, string | null>,
): { nodeId: string; styles: Record<string, string | null> }[] {
  return nodeIds.flatMap((nodeId) => {
    if (!perNode) return [{ nodeId, styles }];
    const own = perNode(nodeId);
    return Object.keys(own).length > 0 ? [{ nodeId, styles: own }] : [];
  });
}

/** Hover text for a token field: its name in full, where it is declared,
 * and what it resolves to; or that it is no longer declared. */
export function designStyleTokenDescription(token: DesignStyleTokenDisplay): string {
  const name = token.name.replace(/^--/, "");
  if (!token.value.trim()) return `${name} is not declared; the field keeps its last value`;
  return [name, token.source, token.value].filter(Boolean).join(" · ");
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

export interface DesignStyleTokenField {
  tokenName?: string;
  tokenDescription?: string;
  /** The frame no longer declares the token. */
  tokenMissing?: boolean;
  /** Detach's hint when the token differs by theme. */
  tokenDetachHint?: string;
  /** Each selected layer keeps its own resolved value. */
  onDetachToken?: () => void;
}

/** The token a field shows for one property of the selected element. */
export function useDesignStyleToken(
  details: DesignRuntimeNodeDetails | null | undefined,
  property: string,
): DesignStyleTokenField {
  const label = useContext(DesignStyleOriginLabelContext);
  const catalog = useDesignTokens();
  const detach = useDesignTokenDetach();
  return useMemo(() => {
    const token = label ? designStyleTokenDisplay(details, property, label) : null;
    if (!token) return {};
    return {
      tokenName: token.name,
      tokenDescription: designStyleTokenDescription(token),
      tokenMissing: !token.value.trim(),
      tokenDetachHint: designTokenDetachHint(catalog.byName.get(token.name), catalog.themeLabel),
      ...(detach ? { onDetachToken: () => detach([property]) } : {}),
    };
  }, [catalog, detach, details, label, property]);
}
