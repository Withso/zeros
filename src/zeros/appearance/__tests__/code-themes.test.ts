import { describe, it, expect } from "vitest";
import {
  CODE_THEMES,
  DEFAULT_CODE_THEME_ID,
  codeThemesForVariant,
  defaultCodeThemeForVariant,
  migrateLegacyCodeTheme,
  resolveCodeTheme,
  resolveCodeThemeForVariant,
} from "../code-themes";
import { resolveDiffTheme } from "../diff-theme";

describe("resolveCodeTheme", () => {
  it("resolves a known id to its shiki theme name", () => {
    expect(resolveCodeTheme("dracula").shiki).toBe("dracula");
    expect(resolveCodeTheme("default").shiki).toBe("github-dark-default");
  });

  it("falls back to Default for an unknown/undefined id", () => {
    expect(resolveCodeTheme("does-not-exist").id).toBe(DEFAULT_CODE_THEME_ID);
    expect(resolveCodeTheme(undefined).id).toBe(DEFAULT_CODE_THEME_ID);
  });

  it("defaults to Default (github-dark-default)", () => {
    expect(DEFAULT_CODE_THEME_ID).toBe("default");
    const def = resolveCodeTheme(DEFAULT_CODE_THEME_ID);
    expect(def.shiki).toBe("github-dark-default");
    expect(def.appearance).toBe("dark");
  });
});

describe("resolveDiffTheme", () => {
  it("drives BOTH dark/light keys with the picked theme + tracks appearance", () => {
    const r = resolveDiffTheme("dracula");
    expect(r.theme.dark).toBe("dracula");
    expect(r.theme.light).toBe("dracula");
    expect(r.themeType).toBe("dark");
  });

  it("a light pick flips themeType so @pierre's light-dark() chrome follows", () => {
    const r = resolveDiffTheme("catppuccin-latte");
    expect(r.theme.light).toBe("catppuccin-latte");
    expect(r.themeType).toBe("light");
  });

  it("defaults to github-dark-default when no id is given", () => {
    expect(resolveDiffTheme().theme.dark).toBe("github-dark-default");
  });
});

describe("catalog", () => {
  it("offers the agreed dark set in order", () => {
    expect(codeThemesForVariant("dark").map((t) => t.id)).toEqual([
      "default",
      "dracula",
      "nord",
      "tokyo-night",
      "gruvbox-dark",
      "solarized-dark",
    ]);
  });

  it("offers the agreed light set in order (Latte first — it's the default)", () => {
    expect(codeThemesForVariant("light").map((t) => t.id)).toEqual([
      "catppuccin-latte",
      "github-light",
      "one-light",
      "solarized-light",
      "gruvbox-light",
      "rose-pine-dawn",
    ]);
  });

  it("splits the whole catalog by appearance — nothing unlisted", () => {
    expect(
      codeThemesForVariant("dark").length + codeThemesForVariant("light").length,
    ).toBe(CODE_THEMES.length);
    for (const t of codeThemesForVariant("dark")) expect(t.appearance).toBe("dark");
    for (const t of codeThemesForVariant("light")) expect(t.appearance).toBe("light");
  });

  it("drops the dark Catppuccin flavors (redundant under the uniform bg)", () => {
    for (const id of [
      "catppuccin-mocha",
      "catppuccin-macchiato",
      "catppuccin-frappe",
    ]) {
      expect(CODE_THEMES.find((t) => t.id === id)).toBeUndefined();
    }
  });

  it("every entry's shiki name is a real bundled theme (loaders resolve by name)", async () => {
    const { bundledThemes } = await import("shiki");
    for (const t of CODE_THEMES) {
      expect(bundledThemes, `unknown shiki theme: ${t.shiki}`).toHaveProperty(
        t.shiki,
      );
    }
  });

  it("picks the default by app variant: dark → Default, light → Catppuccin Latte", () => {
    expect(defaultCodeThemeForVariant("dark")).toBe("default");
    expect(defaultCodeThemeForVariant("orka-night")).toBe("default");
    expect(defaultCodeThemeForVariant("neutral")).toBe("default");
    expect(defaultCodeThemeForVariant("light")).toBe("catppuccin-latte");
  });
});

describe("resolveCodeThemeForVariant", () => {
  it("an explicit pick wins within its own variant", () => {
    expect(resolveCodeThemeForVariant("dracula", "dark").id).toBe("dracula");
    expect(resolveCodeThemeForVariant("one-light", "light").id).toBe("one-light");
  });

  it("no pick → the variant default", () => {
    expect(resolveCodeThemeForVariant(undefined, "dark").id).toBe("default");
    expect(resolveCodeThemeForVariant(undefined, "light").id).toBe(
      "catppuccin-latte",
    );
  });

  it("a wrong-polarity or unknown pick falls back to the variant default", () => {
    // Never render dark token colors on the light app bg (or vice versa).
    expect(resolveCodeThemeForVariant("dracula", "light").id).toBe(
      "catppuccin-latte",
    );
    expect(resolveCodeThemeForVariant("catppuccin-latte", "dark").id).toBe(
      "default",
    );
    expect(resolveCodeThemeForVariant("does-not-exist", "light").id).toBe(
      "catppuccin-latte",
    );
  });

  it("resolution always matches the variant's polarity (invariant)", () => {
    for (const t of CODE_THEMES) {
      expect(resolveCodeThemeForVariant(t.id, "dark").appearance).toBe("dark");
      expect(resolveCodeThemeForVariant(t.id, "light").appearance).toBe("light");
    }
  });
});

describe("migrateLegacyCodeTheme", () => {
  it("'default' — the value the old store froze for non-pickers — becomes 'no pick'", () => {
    expect(migrateLegacyCodeTheme("default")).toEqual({});
  });

  it("an unknown/retired id becomes 'no pick'", () => {
    expect(migrateLegacyCodeTheme("catppuccin-mocha")).toEqual({});
  });

  it("a real pick lands in the slot of its own appearance", () => {
    expect(migrateLegacyCodeTheme("dracula")).toEqual({ dark: "dracula" });
    expect(migrateLegacyCodeTheme("catppuccin-latte")).toEqual({
      light: "catppuccin-latte",
    });
  });
});
