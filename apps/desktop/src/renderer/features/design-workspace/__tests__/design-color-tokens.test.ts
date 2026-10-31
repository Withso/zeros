import { describe, expect, it } from "vitest";

import type { DesignStyleSourceWire, DesignTokenWire } from "../../../platform/git";
import {
  activeDesignColorToken,
  designColorTokenFamily,
  designColorTokenGroups,
  designColorTokenGroupsKey,
  designColorTokenValue,
  filterDesignColorTokenGroups,
  resolveDesignTokenReferences,
} from "../design-color-tokens";

// check:ui ignore-next -- token fixtures need literal color values.
const C = { bg0: "#0d0d0d", white: "#ffffff", hover: "#1f1f1f", side: "#171717", red: "#ff6b6b", scrim: "rgba(0, 0, 0, 0.5)", shadow: "0 8px 24px rgba(0, 0, 0, 0.4)", manual: "#111111", light: "#fafafa", oklch: "oklch(0.7 0.1 250)", probe: "#123456" };

const source = (
  tokens: DesignStyleSourceWire["tokens"],
  overrides: Partial<DesignStyleSourceWire> = {},
): DesignStyleSourceWire => ({
  id: "app",
  title: "App tokens",
  kind: "tailwind",
  path: "styles/zeros-tokens.css",
  status: "ready",
  messages: [],
  themes: ["light"],
  tokens,
  bytes: 1,
  revision: null,
  ...overrides,
});

const manual = (name: string, value: string, themeValues: Record<string, string> = {}): DesignTokenWire => ({
  name,
  syntax: "*",
  inherits: true,
  initialValue: value,
  value,
  themeValues,
  usageCount: 0,
  line: 1,
});

const app = source([
  { name: "--bg0", value: C.bg0, themeValues: { light: C.white } },
  { name: "--bg1-hover", value: C.hover, themeValues: {} },
  { name: "--sidebar-bg", value: C.side, themeValues: {} },
  { name: "--bg3", value: "var(--sidebar-bg)", themeValues: {} },
  { name: "--scrim", value: C.scrim, themeValues: {} },
  { name: "--selected-glass", value: "color-mix(in srgb, var(--bg0) 8%, transparent)", themeValues: {} },
  { name: "--red-primary", value: C.red, themeValues: {} },
  { name: "--space-3", value: "12px", themeValues: {} },
  { name: "--shadow-dropdown", value: C.shadow, themeValues: {} },
  { name: "--loop-a", value: "var(--loop-b)", themeValues: {} },
  { name: "--loop-b", value: "var(--loop-a)", themeValues: {} },
]);

describe("color token catalog", () => {
  it("lists only color tokens, grouped by source and family in cascade order", () => {
    const groups = designColorTokenGroups({ manual: [], sources: [app], theme: null });
    expect(groups.map((group) => group.label)).toEqual([
      "App tokens › bg",
      "App tokens › sidebar",
      "App tokens › scrim",
      "App tokens › selected",
      "App tokens › red",
    ]);
    expect(groups[0]!.tokens.map((token) => token.name)).toEqual(["--bg0", "--bg1-hover", "--bg3"]);
    // Lengths, shadows and unresolvable cycles are not colors a swatch can show.
    const names = groups.flatMap((group) => group.tokens.map((token) => token.name));
    expect(names).not.toContain("--space-3");
    expect(names).not.toContain("--shadow-dropdown");
    expect(names).not.toContain("--loop-a");
  });

  it("keeps the declared value and resolves aliases for the swatch", () => {
    const groups = designColorTokenGroups({ manual: [], sources: [app], theme: null });
    const bg3 = groups[0]!.tokens.find((token) => token.name === "--bg3")!;
    expect(bg3).toEqual({ name: "--bg3", declared: "var(--sidebar-bg)", color: C.side });
    const glass = groups.find((group) => group.label.endsWith("selected"))!.tokens[0]!;
    expect(glass.color).toBe(`color-mix(in srgb, ${C.bg0} 8%, transparent)`);
  });

  it("reads the theme frames show and lets Manual override an imported name", () => {
    const groups = designColorTokenGroups({
      manual: [manual("--bg0", C.manual, { light: C.light }), manual("--brand-accent", C.oklch)],
      sources: [app],
      theme: "light",
    });
    const imported = groups.find((group) => group.label === "App tokens › bg")!;
    expect(imported.tokens.map((token) => token.name)).toEqual(["--bg1-hover", "--bg3"]);
    const overridden = groups.find((group) => group.label === "Manual › bg")!;
    expect(overridden.tokens).toEqual([{ name: "--bg0", declared: C.light, color: C.light }]);
    expect(groups.at(-1)!.label).toBe("Manual › brand");
  });

  it("lists a token only when its value paints as a color, whatever its name", () => {
    const groups = designColorTokenGroups({
      manual: [manual("--text-transform", "uppercase"), manual("--background-image", "none"), manual("--surface-overflow", "hidden"), manual("--text-muted", C.probe)],
      sources: [],
      theme: null,
    });
    expect(groups.flatMap((group) => group.tokens.map((token) => token.name))).toEqual(["--text-muted"]);
  });

  it("keeps an earlier declaration for themes a later declarer leaves unset", () => {
    const base = source([
      { name: "--bg", value: C.white, themeValues: {} },
      { name: "--card-bg", value: "var(--bg)", themeValues: {} },
    ]);
    const contrast = manual("--bg", "", { "high-contrast": C.red });
    const names = (theme: string | null) =>
      designColorTokenGroups({ manual: [contrast], sources: [base], theme })
        .flatMap((group) => group.tokens.map((token) => `${token.name}=${token.color}`));
    expect(names(null)).toEqual([`--bg=${C.white}`, `--card-bg=${C.white}`]);
    expect(names("high-contrast")).toEqual([`--card-bg=${C.red}`, `--bg=${C.red}`]);
  });

  it("resolves fallbacks and refuses cycles and unbalanced references", () => {
    const lookup = (name: string) => ({ "--a": C.probe, "--self": "var(--self)" })[name];
    expect(resolveDesignTokenReferences("var(--missing, var(--a))", lookup)).toBe(C.probe);
    expect(resolveDesignTokenReferences("var(--self)", lookup)).toBeNull();
    expect(resolveDesignTokenReferences("var(--a", lookup)).toBeNull();
    expect(resolveDesignTokenReferences("var(--missing)", lookup)).toBeNull();
  });

  it("names token families by the leading letters of the first segment", () => {
    expect(designColorTokenFamily("--bg1-hover")).toBe("bg");
    expect(designColorTokenFamily("--red-500")).toBe("red");
    expect(designColorTokenFamily("--scrim")).toBe("scrim");
    expect(designColorTokenFamily("--9")).toBe("other");
    expect(designColorTokenFamily("--color-red-500")).toBe("red");
    expect(designColorTokenFamily("--color-bg")).toBe("bg");
    expect(designColorTokenFamily("--color")).toBe("color");
  });
});

describe("color token search and selection", () => {
  const groups = designColorTokenGroups({ manual: [], sources: [app], theme: null });

  it("returns the same groups for an empty query", () => {
    expect(filterDesignColorTokenGroups(groups, "  ")).toBe(groups);
  });

  it("matches names with or without dashes, declared values and group labels", () => {
    expect(
      filterDesignColorTokenGroups(groups, "--bg1").flatMap((group) => group.tokens.map((token) => token.name)),
    ).toEqual(["--bg1-hover"]);
    expect(
      filterDesignColorTokenGroups(groups, "sidebar-bg").flatMap((group) => group.tokens.map((token) => token.name)),
    ).toEqual(["--bg3", "--sidebar-bg"]);
    expect(filterDesignColorTokenGroups(groups, "app tokens › red")[0]!.tokens).toBe(
      groups.find((group) => group.label === "App tokens › red")!.tokens,
    );
    expect(filterDesignColorTokenGroups(groups, "no-such-token")).toEqual([]);
  });

  it("marks the listed token a field reads and writes a var() reference", () => {
    expect(activeDesignColorToken(groups, "--bg3")).toBe("--bg3");
    expect(activeDesignColorToken(groups, "scrim")).toBe("--scrim");
    expect(activeDesignColorToken(groups, "--space-3")).toBeNull();
    expect(activeDesignColorToken(groups, undefined)).toBeNull();
    expect(designColorTokenValue("--bg3")).toBe("var(--bg3)");
    expect(designColorTokenValue("fg1")).toBe("var(--fg1)");
  });

  it("keys equal catalogs equally so the inspector can keep one reference", () => {
    const again = designColorTokenGroups({ manual: [], sources: [app], theme: null });
    expect(designColorTokenGroupsKey(again)).toBe(designColorTokenGroupsKey(groups));
    const light = designColorTokenGroups({ manual: [], sources: [app], theme: "light" });
    expect(designColorTokenGroupsKey(light)).not.toBe(designColorTokenGroupsKey(groups));
    const retitled = designColorTokenGroups({ manual: [], sources: [{ ...app, title: "Brand tokens" }], theme: null });
    expect(designColorTokenGroupsKey(retitled)).not.toBe(designColorTokenGroupsKey(groups));
  });
});
