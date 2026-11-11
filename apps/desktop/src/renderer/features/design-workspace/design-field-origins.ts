// PURPOSE: The origin model across the selected layers, for the Style panel:
// each field's mark (a dot for a value changed here, dimmed for one taken from
// a parent or a reset), the Styled-by line and its filter, and what Reset
// removes. Built once per selection; fields read it from context.

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import { designThemeView } from "./design-themes";
import {
  designStyleFilterIncludes,
  designStyleOrigins,
  type DesignStyledBy,
  type DesignStyledByGroup,
  type DesignStyleOrigin,
  type DesignStyleOriginsContext,
} from "./design-style-origins";
import { designStyleOriginLabel } from "./design-style-provenance";
import { designWorkspaceSnapshotCache } from "./state/design-workspace-cache";

export type DesignFieldMark = "changed" | "dimmed";

export interface DesignFieldOrigins {
  /** The field's mark across every loaded selected layer. */
  mark(property: string): DesignFieldMark | undefined;
  /** The first selected layer's origin, which the hover card describes. */
  origin(property: string): DesignStyleOrigin | null;
  /** Shown only when every selected layer has the same sources, in order. */
  styledBy: DesignStyledBy | null;
  /** The Styled-by row the panel is narrowed to. */
  filter: DesignStyledByGroup | null;
  /** Whether the filter hides a field. */
  hidden(property: string): boolean;
}

const NO_ORIGINS: DesignFieldOrigins = {
  mark: () => undefined,
  origin: () => null,
  styledBy: null,
  filter: null,
  hidden: () => false,
};

export function designFieldOrigins(
  nodes: readonly DesignRuntimeNodeDetails[],
  context: DesignStyleOriginsContext,
  filterKey: string | null,
): DesignFieldOrigins {
  if (nodes.length === 0) return NO_ORIGINS;
  const models = nodes.map((node) => designStyleOrigins(node, context));
  const marks = new Map<string, DesignFieldMark | undefined>();
  const primary = models[0]!.styledBy;
  const keys = primary?.groups.map((group) => group.key).join("\u0000");
  const styledBy =
    primary &&
    models.every((model) => model.styledBy?.groups.map((group) => group.key).join("\u0000") === keys)
      ? primary
      : null;
  const filter = (filterKey && styledBy?.groups.find((group) => group.key === filterKey)) || null;
  // The rows match by key; each layer's group lists what it sets there.
  const filterGroups = filter
    ? models.map((model) => model.styledBy!.groups.find((group) => group.key === filter.key)!)
    : [];
  const hidden = new Map<string, boolean>();
  return {
    mark(property) {
      if (!marks.has(property)) {
        const kinds = models.map((model) => model.of(property)?.kind);
        marks.set(
          property,
          kinds.every((kind) => kind === "changed")
            ? "changed"
            : kinds.every((kind) => kind === "inherited" || kind === "reset")
              ? "dimmed"
              : undefined,
        );
      }
      return marks.get(property);
    },
    origin: (property) => models[0]!.of(property),
    styledBy,
    filter,
    hidden(property) {
      if (!filter) return false;
      if (!hidden.has(property))
        hidden.set(property, !filterGroups.some((group) => designStyleFilterIncludes(group, property)));
      return hidden.get(property)!;
    },
  };
}

/** Reset for one field: on each layer that changed it, its own declaration
 * removed whole (a shorthand included); other layers get no operation. */
export function designResetStyles(
  nodes: readonly DesignRuntimeNodeDetails[],
  context: DesignStyleOriginsContext,
  properties: readonly string[],
): { nodeId: string; styles: Record<string, null> }[] {
  return nodes.flatMap((node) => {
    const model = designStyleOrigins(node, context);
    const styles: Record<string, null> = {};
    for (const property of properties) {
      const origin = model.of(property);
      if (origin?.kind !== "changed") continue;
      for (const declared of origin.card.reset?.properties ?? []) styles[declared] = null;
    }
    return Object.keys(styles).length > 0 ? [{ nodeId: node.oid, styles }] : [];
  });
}

/** The inspector's origin model; fields outside an inspector have none. */
export const DesignFieldOriginsContext = createContext<DesignFieldOrigins>(NO_ORIGINS);

/** The attributes a field carries: its mark on the field, and whether the
 * Styled-by filter hides it on the field's cell. A field that edits other
 * properties too (linked sides, a fill's image) passes them as `edits`: it
 * hides only when the source sets none of them. */
export function useDesignFieldOrigin(
  property: string | undefined,
  edits?: readonly string[],
): {
  mark: DesignFieldMark | undefined;
  hidden: boolean;
} {
  const origins = useContext(DesignFieldOriginsContext);
  if (!property) return { mark: undefined, hidden: false };
  return {
    mark: origins.mark(property),
    hidden: origins.hidden(property) && (edits?.every((edited) => origins.hidden(edited)) ?? true),
  };
}

/** Labels, utility sources and theme names for the workspace the inspector
 * shows; one identity while the snapshot's sources and themes are unchanged. */
export function useDesignStyleOriginsContext(
  workspaceId: string | null | undefined,
): DesignStyleOriginsContext {
  const subscribe = useCallback(
    (listener: () => void) =>
      workspaceId ? designWorkspaceSnapshotCache.subscribe(workspaceId, listener) : () => {},
    [workspaceId],
  );
  const readSources = useCallback(
    () => (workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.styleSources : undefined),
    [workspaceId],
  );
  const readThemes = useCallback(
    () => (workspaceId ? designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.themes : undefined),
    [workspaceId],
  );
  const sources = useSyncExternalStore(subscribe, readSources, readSources);
  const themes = useSyncExternalStore(subscribe, readThemes, readThemes);
  return useMemo(() => {
    const titles = new Map((sources ?? []).map((source) => [source.id, source.title]));
    const view = designThemeView(themes);
    return {
      label: (origin) => designStyleOriginLabel(origin, titles),
      utilitySources: new Set(
        (sources ?? []).filter((source) => source.kind === "tailwind").map((source) => source.id),
      ),
      themeLabel: (theme) => view.label(theme),
    };
  }, [sources, themes]);
}
