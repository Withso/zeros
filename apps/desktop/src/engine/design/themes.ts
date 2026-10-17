// Theme names. A Design theme is identified by the lowercase id tokens.css
// (`[data-zd-theme="<id>"]`) and style sources (`themes`) use; meta/canvas.json
// may declare a `themes` list that names them for people and says which theme
// `:root` holds. Older engines preserve and ignore the list.
//
// The default theme ("base") is what frames show when no other theme is
// chosen. When it has an id, frames carry `data-zd-theme="<id>"` in it too,
// so rules a style source maps to that id apply, while `:root` keeps its
// values.

export const MAX_DESIGN_THEMES = 64;
export const MAX_DESIGN_THEME_LABEL = 64;
export const DESIGN_THEME_ID = /^[a-z][a-z0-9_-]{0,63}$/;

export interface DesignThemeSummary {
  id: string;
  label: string;
  /** The default theme, whose values are `:root`. */
  base?: true;
}

export interface DesignThemeCatalog {
  themes: DesignThemeSummary[];
  baseId: string | null;
  /** Problems with the declared list; entries that have them are skipped. */
  errors: string[];
}

/** A readable name for a theme nobody named: `high-contrast` → "High contrast". */
export function designThemeLabel(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readDesignThemeCatalog(canvas: object): DesignThemeCatalog {
  const raw = (canvas as Record<string, unknown>).themes;
  if (raw === undefined) return { themes: [], baseId: null, errors: [] };
  if (!Array.isArray(raw)) return { themes: [], baseId: null, errors: ["meta/canvas.json `themes` must be a list."] };
  const themes: DesignThemeSummary[] = [];
  const errors: string[] = [];
  let baseId: string | null = null;
  if (raw.length > MAX_DESIGN_THEMES) errors.push(`Only the first ${MAX_DESIGN_THEMES} themes are used.`);
  for (const [index, entry] of raw.slice(0, MAX_DESIGN_THEMES).entries()) {
    const value = record(entry);
    const id = typeof value?.id === "string" ? value.id : "";
    if (!value || !DESIGN_THEME_ID.test(id)) {
      errors.push(`Theme ${index + 1} needs an id that starts with a lowercase letter (letters, digits, _ or -).`);
      continue;
    }
    if (themes.some((theme) => theme.id === id)) {
      errors.push(`Theme id ${JSON.stringify(id)} is declared more than once.`);
      continue;
    }
    const label = typeof value.label === "string" && value.label.trim()
      ? value.label.trim().slice(0, MAX_DESIGN_THEME_LABEL)
      : designThemeLabel(id);
    if (value.base === true && baseId !== null) {
      errors.push(`Only one theme can be the default; ${JSON.stringify(id)} is not.`);
    }
    const base = value.base === true && baseId === null;
    if (base) baseId = id;
    themes.push({ id, label, ...(base ? { base: true as const } : {}) });
  }
  return { themes, baseId, errors };
}

/** Every theme the directory uses, named: the default first, then declared
 * themes in order, then the rest by id. */
export function mergeDesignThemes(catalog: DesignThemeCatalog, used: Iterable<string>): DesignThemeSummary[] {
  const declared = new Map(catalog.themes.map((theme) => [theme.id, theme]));
  const base = catalog.baseId ? declared.get(catalog.baseId)! : null;
  const others = [...new Set(used)]
    .filter((id) => DESIGN_THEME_ID.test(id) && !declared.has(id))
    .sort()
    .map((id) => ({ id, label: designThemeLabel(id) }));
  return [
    ...(base ? [base] : []),
    ...catalog.themes.filter((theme) => theme !== base),
    ...others,
  ];
}
