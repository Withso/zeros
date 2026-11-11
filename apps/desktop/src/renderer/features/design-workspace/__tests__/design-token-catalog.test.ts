import { describe, expect, it, vi } from "vitest";

import type { DesignStyleSourceWire, DesignTokenWire } from "../../../platform/git";
import {
  designTextStyleMeasure,
  designTextStyleSummary,
  designTextStyles,
  designTokenCatalog,
  designTokenFieldTypes,
  designTokenGroups,
  designTokenKindLabel,
  designTokenSummary,
  designTokenTypes,
} from "../design-token-catalog";
import { designTokenListGroups, filterDesignTokenListGroups } from "../design-token-picker";

const manual = (
  name: string,
  value: string,
  extra: Partial<DesignTokenWire> = {},
): DesignTokenWire => ({
  name,
  syntax: "*",
  inherits: true,
  initialValue: "",
  value,
  themeValues: {},
  usageCount: 0,
  line: 1,
  ...extra,
});

const source = (
  id: string,
  tokens: { name: string; value: string; themeValues?: Record<string, string> }[],
): DesignStyleSourceWire => ({
  id,
  title: id === "app" ? "App styles" : id,
  kind: "css",
  path: `${id}.css`,
  status: "ready",
  messages: [],
  themes: [],
  tokens: tokens.map((token) => ({ themeValues: {}, ...token })),
  bytes: 0,
  revision: null,
});

// The renderer asks the browser whether a value paints as a colour; Node has
// no CSS object, so the tests name the few colours they use.
const COLORS = new Set(["white", "black", "tomato", "rebeccapurple", "gray", "midnightblue", "silver"]);
vi.stubGlobal("CSS", { supports: (_property: string, value: string) => COLORS.has(value) });

describe("token types come from the resolved value", () => {
  it.each([
    ["--bg1", "white", ["color"]],
    ["--bg2", "midnightblue", ["color"]],
    ["--radius-md", "6px", ["length"]],
    ["--space-4", "1rem", ["length"]],
    ["--zero", "0", ["number", "length"]],
    ["--weight-medium", "500", ["number", "font-weight"]],
    ["--leading", "1.4", ["number"]],
    ["--weight-bold", "bold", ["font-weight"]],
    ["--half", "50%", ["percentage"]],
    ["--duration-fast", "120ms", ["duration"]],
    ["--ease-out", "cubic-bezier(0.2, 0, 0, 1)", ["easing"]],
    ["--shadow-sm", "0 1px 2px black", ["shadow"]],
    ["--font-sans", '"Inter", system-ui, sans-serif', ["font-family"]],
    ["--font-body", "Inter", ["font-family"]],
    ["--surface", "ink", []],
    ["--gutter", "calc(8px + 2vw)", ["length"]],
  ] as const)("%s: %s", (name, value, types) => {
    expect(designTokenTypes(name, value)).toEqual(types);
  });

  it("types nothing that cannot resolve", () => {
    expect(designTokenTypes("--missing", null)).toEqual([]);
  });
});

describe("the frame's token catalog", () => {
  it("resolves aliases and lets tokens.css override an imported name", () => {
    const catalog = designTokenCatalog({
      manual: [manual("--primary-bg", "var(--bg2)"), manual("--bg2", "silver", { description: "Raised" })],
      sources: [source("app", [{ name: "--bg2", value: "gray" }, { name: "--radius-md", value: "6px" }])],
      theme: null,
    });
    expect(catalog.byName.get("--bg2")).toMatchObject({ resolved: "silver", source: "Manual", description: "Raised" });
    expect(catalog.byName.get("--primary-bg")).toMatchObject({ declared: "var(--bg2)", resolved: "silver", types: ["color"] });
    expect(catalog.byName.get("--radius-md")).toMatchObject({ source: "App styles", types: ["length"] });
  });

  it("leaves a cycle or an undeclared alias unresolved and untyped", () => {
    const catalog = designTokenCatalog({
      manual: [manual("--a", "var(--b)"), manual("--b", "var(--a)"), manual("--c", "var(--nowhere)")],
      sources: [],
      theme: null,
    });
    for (const name of ["--a", "--b", "--c"])
      expect(catalog.byName.get(name)).toMatchObject({ resolved: null, types: [] });
  });

  it("offers a frame only the sources it receives", () => {
    const input = {
      manual: [],
      sources: [
        source("app", [{ name: "--bg1", value: "white" }]),
        source("brand", [{ name: "--brand", value: "tomato" }]),
        source("@fonts", [{ name: "--font-sans", value: '"Inter", sans-serif' }]),
      ],
      theme: null,
    };
    expect([...designTokenCatalog(input).byName.keys()]).toEqual(["--bg1", "--brand", "--font-sans"]);
    expect([...designTokenCatalog({ ...input, sourceIds: ["brand"] }).byName.keys()]).toEqual(["--brand", "--font-sans"]);
    // An empty choice opts out of every source, App fonts included.
    expect([...designTokenCatalog({ ...input, sourceIds: [] }).byName.keys()]).toEqual([]);
  });

  it("knows where a token differs by theme, for Detach's hint", () => {
    const catalog = designTokenCatalog({
      manual: [manual("--bg1", "white", { themeValues: { dark: "black" } }), manual("--radius", "6px")],
      sources: [],
      themes: [{ id: "light", label: "Light", base: true }, { id: "dark", label: "Dark" }],
      theme: "dark",
    });
    expect(catalog.themeLabel).toBe("Dark");
    expect(catalog.byName.get("--bg1")).toMatchObject({
      resolved: "black",
      differsIn: [{ theme: "light", label: "Light", resolved: "white" }],
    });
    expect(catalog.byName.get("--radius")?.differsIn).toEqual([]);
  });
});

describe("groups by role", () => {
  const catalog = designTokenCatalog({
    manual: [
      manual("--bg1", "white", { description: "App canvas" }),
      manual("--bg2", "silver"),
      manual("--fg1", "black"),
      manual("--primary-button-bg", "tomato"),
      manual("--primary-button-fg", "white"),
      manual("--brand", "rebeccapurple"),
      manual("--radius-md", "6px"),
      manual("--radius-lg", "8px"),
      manual("--space-2", "8px"),
    ],
    sources: [],
    theme: null,
  });

  it("names known families, keeps a shared family word, and puts single tokens under Other", () => {
    expect(designTokenGroups(catalog, ["color"]).map((group) => [group.label, group.tokens.map((token) => token.name)])).toEqual([
      ["Surfaces", ["--bg1", "--bg2"]],
      ["Text", ["--fg1"]],
      ["Primary", ["--primary-button-bg", "--primary-button-fg"]],
      ["Other", ["--brand"]],
    ]);
  });

  it("lists only the tokens a field's type accepts", () => {
    expect(designTokenGroups(catalog, ["length"]).map((group) => group.label)).toEqual(["Radius", "Spacing"]);
    expect(designTokenGroups(catalog, ["font-family"])).toEqual([]);
  });

  it("searches names, values and descriptions", () => {
    const groups = designTokenListGroups(designTokenGroups(catalog, ["color"]));
    expect(filterDesignTokenListGroups(groups, "canvas").flatMap((group) => group.rows.map((row) => row.name))).toEqual(["--bg1"]);
    expect(filterDesignTokenListGroups(groups, "--fg").flatMap((group) => group.rows.map((row) => row.name))).toEqual(["--fg1", "--primary-button-fg"]);
    expect(filterDesignTokenListGroups(groups, "")).toBe(groups);
  });

  it("describes a token by its comment, else its value", () => {
    expect(designTokenSummary(catalog.byName.get("--bg1")!)).toBe("App canvas");
    expect(designTokenSummary(catalog.byName.get("--radius-md")!)).toBe("6px");
  });
});

describe("which fields take a pill", () => {
  it.each([
    ["background-color", ["color"]],
    ["border-top-color", ["color"]],
    ["opacity", ["number", "percentage"]],
    ["border-radius", ["length"]],
    ["border-top-left-radius", ["length"]],
    ["padding-left", ["length"]],
    ["row-gap", ["length"]],
    ["min-width", ["length", "percentage"]],
    ["line-height", ["number", "length", "percentage"]],
    ["font-weight", ["font-weight"]],
    ["font-family", ["font-family"]],
    ["border-left-width", ["length"]],
  ] as const)("%s", (property, types) => {
    expect(designTokenFieldTypes(property)).toEqual(types);
  });

  it.each(["left", "top", "rotate", "z-index", "display"])("never %s", (property) => {
    expect(designTokenFieldTypes(property)).toBeNull();
  });

  it("answers a property with the same list each time, so a field's memo holds", () => {
    expect(designTokenFieldTypes("padding-left")).toBe(designTokenFieldTypes("padding-left"));
    expect(designTokenFieldTypes("padding-left")).toBe(designTokenFieldTypes("row-gap"));
  });

  it("names what a field lists", () => {
    expect(designTokenKindLabel(["color"])).toBe("color");
    expect(designTokenKindLabel(["length", "percentage"])).toBe("size");
    expect(designTokenKindLabel(["number", "percentage"])).toBe("number");
  });
});

describe("text styles", () => {
  const catalog = designTokenCatalog({
    manual: [],
    sources: [
      source("app", [
        { name: "--text-xxs", value: "10px" },
        { name: "--text-xs", value: "0.8125rem" },
        { name: "--text-xs--line-height", value: "calc(18 / 13)" },
        { name: "--text-heading-lg", value: "28px" },
        { name: "--text-heading-lg--line-height", value: "36px" },
        { name: "--text-heading-lg--font-weight", value: "600" },
        { name: "--text-heading-lg--letter-spacing", value: "-0.02em" },
        { name: "--text-muted", value: "gray" },
      ]),
    ],
    theme: null,
  });

  it("are the --text-<name> sizes with their optional line, spacing and weight", () => {
    const styles = designTextStyles(catalog);
    expect(styles.map((style) => style.name)).toEqual(["--text-xxs", "--text-xs", "--text-heading-lg"]);
    expect(styles[2]).toMatchObject({
      lineHeight: { name: "--text-heading-lg--line-height" },
      fontWeight: { name: "--text-heading-lg--font-weight" },
      letterSpacing: { name: "--text-heading-lg--letter-spacing" },
    });
  });

  it("read as drawn: size, then the line it sits on", () => {
    const [xxs, xs, heading] = designTextStyles(catalog);
    expect(designTextStyleMeasure(xxs!)).toBe("10");
    expect(designTextStyleMeasure(xs!)).toBe("13 on an 18 line");
    expect(designTextStyleSummary(heading!)).toBe("28 on a 36 line");
  });

  it("are none when the directory declares none", () => {
    expect(designTextStyles(designTokenCatalog({ manual: [manual("--bg1", "white")], sources: [], theme: null }))).toEqual([]);
  });
});
