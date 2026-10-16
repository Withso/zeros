import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeDesignDocument, readDesignThemeNames, readDesignWorkspaceSnapshot } from "../document";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";
import { updateDesignThemes, upsertDesignTheme } from "../theme-lifecycle";
import { designThemeLabel, mergeDesignThemes, readDesignThemeCatalog } from "../themes";

describe("theme names", () => {
  it("reads labels and the default theme, keeping valid entries and reporting the rest", () => {
    const catalog = readDesignThemeCatalog({
      themes: [
        { id: "dark", label: "  Dark  ", base: true },
        { id: "light" },
        { id: "high-contrast", label: "High contrast", base: true },
        { id: "Bad Id", label: "Nope" },
        { id: "light", label: "Twice" },
        "not an object",
      ],
    });
    expect(catalog.themes).toEqual([
      { id: "dark", label: "Dark", base: true },
      { id: "light", label: "Light" },
      { id: "high-contrast", label: "High contrast" },
    ]);
    expect(catalog.baseId).toBe("dark");
    expect(catalog.errors).toEqual([
      'Only one theme can be the default; "high-contrast" is not.',
      "Theme 4 needs an id that starts with a lowercase letter (letters, digits, _ or -).",
      'Theme id "light" is declared more than once.',
      "Theme 6 needs an id that starts with a lowercase letter (letters, digits, _ or -).",
    ]);
    expect(readDesignThemeCatalog({})).toEqual({ themes: [], baseId: null, errors: [] });
    expect(readDesignThemeCatalog({ themes: {} }).errors).toEqual(["meta/canvas.json `themes` must be a list."]);
  });

  it("names undeclared themes from their ids", () => {
    expect(designThemeLabel("light")).toBe("Light");
    expect(designThemeLabel("high-contrast")).toBe("High contrast");
    expect(designThemeLabel("brand_2")).toBe("Brand 2");
  });

  it("lists the default theme first, then declared themes, then every other theme the directory uses", () => {
    const catalog = readDesignThemeCatalog({ themes: [{ id: "light", label: "Day" }, { id: "dark", label: "Night", base: true }] });
    expect(mergeDesignThemes(catalog, ["sepia", "light", "dark", "amber"])).toEqual([
      { id: "dark", label: "Night", base: true },
      { id: "light", label: "Day" },
      { id: "amber", label: "Amber" },
      { id: "sepia", label: "Sepia" },
    ]);
    expect(mergeDesignThemes(readDesignThemeCatalog({}), ["light"])).toEqual([{ id: "light", label: "Light" }]);
  });
});

describe("theme names in a Design directory", () => {
  let root: string;
  let directory: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-themes-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    directory = designDirectoryNameFor(root);
    await writeFile(path.join(root, directory, "tokens.css"), ':root { --bg: black; } [data-zd-theme="light"] { --bg: white; }');
  });
  afterEach(async () => {
    forgetDesignDirectoryName(root);
    await rm(root, { recursive: true, force: true });
  });

  it("saves names and the default theme without touching other canvas data", async () => {
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [{ id: "app", kind: "css", path: "styles/app.css" }];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    const themes = await updateDesignThemes(root, [
      { id: "dark", label: "Dark", base: true },
      { id: "light", label: "Light" },
    ]);
    expect(themes).toEqual([{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Light" }]);
    const saved = JSON.parse(await readFile(canvasFile, "utf8"));
    expect(saved.themes).toEqual([{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Light" }]);
    expect(saved.styles).toEqual(canvas.styles);
    expect(saved.pages).toEqual(canvas.pages);
    await expect(updateDesignThemes(root, [{ id: "Dark", label: "Dark" }])).rejects.toThrow(/lowercase letter/);
    await expect(updateDesignThemes(root, [{ id: "dark", label: "" }])).rejects.toThrow(/label/);
  });

  it("names one theme at a time and moves the default mark", async () => {
    expect(await upsertDesignTheme(root, { id: "light", label: "Day" })).toEqual([{ id: "light", label: "Day" }]);
    expect(await upsertDesignTheme(root, { id: "dark", label: "Night", base: true })).toEqual([
      { id: "dark", label: "Night", base: true },
      { id: "light", label: "Day" },
    ]);
    expect(await upsertDesignTheme(root, { id: "light", label: "Daylight", base: true })).toEqual([
      { id: "light", label: "Daylight", base: true },
      { id: "dark", label: "Night" },
    ]);
  });

  it("offers the default theme by id and reports every theme with its name in the snapshot", async () => {
    await updateDesignThemes(root, [{ id: "dark", label: "Dark", base: true }]);
    expect(await readDesignThemeNames(root)).toEqual(["dark", "light"]);
    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(snapshot.themes).toEqual([{ id: "dark", label: "Dark", base: true }, { id: "light", label: "Light" }]);
  });
});
