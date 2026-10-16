import { readCanvas, writeCanvas } from "./document-storage";
import { initializeDesignDocumentUnlocked } from "./document-transactions";
import { withDesignDocumentWrite } from "./document-write-lock";
import { DESIGN_THEME_ID, MAX_DESIGN_THEME_LABEL, MAX_DESIGN_THEMES, readDesignThemeCatalog, type DesignThemeSummary } from "./themes";

// Writes meta/canvas.json's `themes` list for the theme editor: renaming a
// theme or naming a new one. Agents edit the same list as an ordinary file.

/** Replace the declared names, validated as the reader validates them. */
export async function updateDesignThemes(
  workspacePath: string,
  input: ReadonlyArray<{ id: string; label: string; base?: boolean }>,
): Promise<DesignThemeSummary[]> {
  if (input.length > MAX_DESIGN_THEMES) throw new Error(`A Design directory names at most ${MAX_DESIGN_THEMES} themes.`);
  const themes: DesignThemeSummary[] = [];
  for (const theme of input) {
    if (!DESIGN_THEME_ID.test(theme.id)) {
      throw new Error("Theme ids start with a lowercase letter and use letters, digits, _ or -.");
    }
    const label = theme.label.trim();
    if (!label || label.length > MAX_DESIGN_THEME_LABEL) {
      throw new Error(`A theme label needs 1–${MAX_DESIGN_THEME_LABEL} characters.`);
    }
    if (themes.some((existing) => existing.id === theme.id)) throw new Error(`Theme ${JSON.stringify(theme.id)} is named twice.`);
    if (theme.base && themes.some((existing) => existing.base)) throw new Error("Only one theme can be the default.");
    themes.push({ id: theme.id, label, ...(theme.base ? { base: true as const } : {}) });
  }
  return withDesignDocumentWrite(workspacePath, async () => {
    await initializeDesignDocumentUnlocked(workspacePath);
    const canvas = await readCanvas(workspacePath) as Awaited<ReturnType<typeof readCanvas>> & { themes?: unknown };
    if (JSON.stringify(canvas.themes ?? null) !== JSON.stringify(themes.length ? themes : null)) {
      if (themes.length) canvas.themes = themes;
      else delete canvas.themes;
      await writeCanvas(workspacePath, canvas);
    }
    return themes;
  });
}

/** Name one theme, or make it the default, keeping every other declared
 * name. Making a theme the default moves the mark from the previous one. */
export async function upsertDesignTheme(
  workspacePath: string,
  theme: { id: string; label: string; base?: boolean },
): Promise<DesignThemeSummary[]> {
  if (!DESIGN_THEME_ID.test(theme.id)) {
    throw new Error("Theme ids start with a lowercase letter and use letters, digits, _ or -.");
  }
  const canvas = await readCanvas(workspacePath).catch(() => null);
  const declared = canvas ? readDesignThemeCatalog(canvas).themes : [];
  const existing = declared.findIndex((entry) => entry.id === theme.id);
  const next = declared.map((entry) => ({
    id: entry.id,
    label: entry.label,
    base: theme.base ? false : entry.base === true,
  }));
  const named = { id: theme.id, label: theme.label, base: theme.base ?? declared[existing]?.base === true };
  if (existing >= 0) next[existing] = named;
  else next.push(named);
  // The default theme leads the list, as the theme editor shows it.
  next.sort((left, right) => Number(right.base) - Number(left.base));
  return updateDesignThemes(workspacePath, next);
}
