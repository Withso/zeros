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

/** `forced` and `computed` make the field read only (design-style-card.tsx
 * keeps edits out and opens the card on a press). */
export type DesignFieldMark = "changed" | "dimmed" | "forced" | "computed";

/** Why a field is read only, about the layer that makes it so. */
export interface DesignFieldLock {
  kind: "forced" | "computed";
  nodeId: string;
  layer: string;
  /** The value as written: what a computed field shows. */
  text: string;
  /** "Uses calc().", "Card is forced by .legacy-card". */
  why: string;
  /** The forcing rule and where it is written. */
  rule?: string;
  source?: string;
}

export interface DesignFieldOrigins {
  /** The field's mark across every loaded selected layer. */
  mark(property: string): DesignFieldMark | undefined;
  /** Read only when any selected layer's value is computed or forced. */
  lock(property: string): DesignFieldLock | null;
  /** A plain value that differs by theme on some selected layer. */
  themed(property: string): boolean;
  /** What an edit to a themed field changes: "Changes Light and Dark." */
  themeChange(property: string): string | null;
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
  lock: () => null,
  themed: () => false,
  themeChange: () => null,
  origin: () => null,
  styledBy: null,
  filter: null,
  hidden: () => false,
};

/** `held`: the layer shows a held state; the panel then shows only the
 * properties that state changes, and no Styled-by row filters it. */
export function designFieldOrigins(
  nodes: readonly DesignRuntimeNodeDetails[],
  context: DesignStyleOriginsContext,
  filterKey: string | null,
  held?: { properties: readonly string[] },
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
  const heldGroup: DesignStyledByGroup | null = held
    ? { kind: "state", key: "state", label: "State", name: "", properties: [...held.properties] }
    : null;
  const filter = heldGroup ?? ((filterKey && styledBy?.groups.find((group) => group.key === filterKey)) || null);
  // The rows match by key; each layer's group lists what it sets there.
  const filterGroups = heldGroup
    ? [heldGroup]
    : filter
      ? models.map((model) => model.styledBy!.groups.find((group) => group.key === filter.key)!)
      : [];
  const hidden = new Map<string, boolean>();
  const themed = new Map<string, boolean>();
  const themedOf = (property: string): boolean => {
    let value = themed.get(property);
    if (value === undefined) {
      value = models.some((model) => Boolean(model.of(property)?.card.themes));
      themed.set(property, value);
    }
    return value;
  };
  const locks = new Map<string, DesignFieldLock | null>();
  const lockOf = (property: string): DesignFieldLock | null => {
    if (locks.has(property)) return locks.get(property)!;
    // A forced value is the harder stop, so it is the one named.
    let lock: DesignFieldLock | null = null;
    for (const kind of ["forced", "computed"] as const) {
      const index = models.findIndex((model) => {
        const origin = model.of(property);
        return kind === "forced" ? origin?.kind === "forced" : Boolean(origin?.computed);
      });
      if (index < 0) continue;
      const node = nodes[index]!;
      const origin = models[index]!.of(property)!;
      const several = nodes.length > 1;
      const rule = origin.card.forcedBy ?? "";
      const why =
        kind === "forced"
          ? several ? `${node.name} is forced by ${rule}` : `Forced by ${rule}`
          : several ? `${node.name} uses ${origin.computed}().` : `Uses ${origin.computed}().`;
      lock = { kind, nodeId: node.oid, layer: node.name, text: origin.written ?? "", why };
      if (kind === "forced") {
        lock.rule = rule;
        if (origin.card.forcedSource) lock.source = origin.card.forcedSource;
      }
      break;
    }
    locks.set(property, lock);
    return lock;
  };
  return {
    mark(property) {
      if (!marks.has(property)) {
        const kinds = models.map((model) => model.of(property)?.kind);
        marks.set(
          property,
          lockOf(property)?.kind ??
            (kinds.every((kind) => kind === "changed")
              ? "changed"
              : kinds.every((kind) => kind === "inherited" || kind === "reset")
                ? "dimmed"
                : undefined),
        );
      }
      return marks.get(property);
    },
    lock: lockOf,
    themed: themedOf,
    themeChange(property) {
      if (!themedOf(property)) return null;
      const names = context.themes ?? [];
      return names.length > 1 ? `Changes ${listed(names)}.` : null;
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

/** Reset or Clear for one field: on each layer that changed it, or set it
 * in its own style, that declaration removed whole (a shorthand included);
 * other layers get no operation. */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function designResetStyles(
  nodes: readonly DesignRuntimeNodeDetails[],
  context: DesignStyleOriginsContext,
  properties: readonly string[],
): { nodeId: string; styles: Record<string, null> }[] {
  return nodes.flatMap((node) => {
    const model = designStyleOrigins(node, context);
    const styles: Record<string, null> = {};
    for (const property of properties) {
      const removed = model.of(property)?.card;
      for (const declared of removed?.reset?.properties ?? removed?.clear?.properties ?? []) styles[declared] = null;
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
  /** Why the field is read only, when it is. */
  lock: DesignFieldLock | null;
  /** Its plain value differs by theme: the field carries a theme mark. */
  themed: boolean;
} {
  const origins = useContext(DesignFieldOriginsContext);
  if (!property) return { mark: undefined, hidden: false, lock: null, themed: false };
  return {
    mark: origins.mark(property),
    hidden: origins.hidden(property) && (edits?.every((edited) => origins.hidden(edited)) ?? true),
    lock: origins.lock(property),
    themed: origins.themed(property),
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
      themes: [view.baseLabel, ...view.others.map((theme) => view.label(theme))],
    };
  }, [sources, themes]);
}
