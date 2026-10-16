// PURPOSE: Theme names for the Design tab. The engine reports every theme a
// directory uses with its display name; `base` marks the default theme, whose
// values are `:root`. When the default theme has an id, frames carry it as
// `data-zd-theme` too, so a style source's rules for that theme apply.

import type { DesignThemeWire } from "../../platform/git";

export const DESIGN_THEME_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const BASE_LABEL = "Base";

export interface DesignThemeView {
  /** The default theme's id, or null when `:root` has no name. */
  baseId: string | null;
  baseLabel: string;
  label(theme: string | null): string;
  /** Every theme except the default, in the engine's order. */
  others: readonly string[];
}

/** `high-contrast` → "High contrast", as the engine names undeclared themes. */
export function designThemeLabel(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/** Older engines send no names; malformed entries are ignored. */
export function designThemeView(
  themes: readonly DesignThemeWire[] | undefined,
  used: readonly string[] = [],
): DesignThemeView {
  const valid = (themes ?? []).filter(
    (theme) =>
      theme &&
      typeof theme.id === "string" &&
      DESIGN_THEME_ID.test(theme.id) &&
      typeof theme.label === "string" &&
      theme.label.trim().length > 0,
  );
  const base = valid.find((theme) => theme.base === true) ?? null;
  const labels = new Map(valid.map((theme) => [theme.id, theme.label.trim()]));
  const others = [
    ...new Set([
      ...valid.map((theme) => theme.id),
      ...[...used].sort((left, right) => left.localeCompare(right)),
    ]),
  ].filter((id) => id !== base?.id && DESIGN_THEME_ID.test(id));
  const baseLabel = base ? labels.get(base.id)! : BASE_LABEL;
  return {
    baseId: base?.id ?? null,
    baseLabel,
    label: (theme) =>
      theme === null || theme === base?.id
        ? baseLabel
        : (labels.get(theme) ?? designThemeLabel(theme)),
    others,
  };
}

/** The theme frames show: the chosen one, else the named default theme. */
export function effectiveDesignTheme(
  activeTheme: string | null,
  baseId: string | null,
): string | null {
  return activeTheme ?? baseId;
}

/** An id for a theme someone named, such as "High contrast" → "high-contrast";
 * null when the name has no letters to start one. */
export function designThemeIdFromName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return DESIGN_THEME_ID.test(slug) ? slug : null;
}
