import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildTokens,
  checkGeneratedTokens,
  readTokenSources,
  renderMarketingTokenCss,
  renderTokenCss,
} from "../design-system/build-tokens.mjs";
import {
  declarations,
  extractBlock,
  hslToRgb,
  readThemes,
  resolveRgb,
  resolveValue,
  toHex,
} from "../design-system/token-palette.mjs";

const ROOT = process.cwd();
const temporaryRoots: string[] = [];
const fixtureCss = `@import "tailwindcss" source(none);
@theme inline {
  --color-*: initial;
  --text-xs: 0.8125rem;
  /* @generated tokens:utilities:start */
  /* @generated tokens:utilities:end */
}
:root {
  color-scheme: dark;
  /* Authored explanation stays byte-identical. */
  /* @generated tokens:base:start */
  /* @generated tokens:base:end */
}
[data-theme="light"] {
  color-scheme: light;
  /* @generated tokens:light:start */
  /* @generated tokens:light:end */
}
@layer base { * { border-color: var(--bg); } }
`;
const fixtureMarketingCss = `@import "tailwindcss";
@custom-variant dark (@media (prefers-color-scheme: dark));
:root {
  color-scheme: dark;
  --art-direction: hsl(37 90% 60%);
  /* @generated tokens:marketing-dark-surfaces:start */
  /* @generated tokens:marketing-dark-surfaces:end */
  --shadow-product: 0 30px 80px -20px rgba(0, 0, 0, 0.7);
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    /* @generated tokens:marketing-light-surfaces:start */
    /* @generated tokens:marketing-light-surfaces:end */
    --art-direction: hsl(37 90% 28.5%);
  }
}
@layer base { body { background: var(--bg); } }
`;

const token = (type: string, value: unknown, name: string, section = "base", utility = false) => ({
  $type: type,
  $value: value,
  $description: `${name} description`,
  $extensions: { "org.zeros": {
    cssName: `--${name}`,
    section,
    ...(utility ? { utility: `--color-${name}`, utilitySection: "utilities", utilityOrder: 0 } : {}),
  } },
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zeros-tokens-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "styles/tokens"), { recursive: true });
  mkdirSync(join(root, "apps/marketing/src"), { recursive: true });
  writeFileSync(join(root, "styles/zeros-tokens.css"), fixtureCss);
  writeFileSync(join(root, "apps/marketing/src/index.css"), fixtureMarketingCss);
  const base = { tokens: {
    bg: token("color", { colorSpace: "hsl", components: [0, 0, 7] }, "bg", "base", true),
    pane: token("color", "{tokens.bg}", "pane"),
    scrim: token("color", { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 }, "scrim"),
    weight: token("fontWeight", 450, "weight"),
    size: token("dimension", { value: 0.9375, unit: "rem" }, "size"),
    shadow: token("shadow", {
      color: { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.35 },
      offsetX: { value: 0, unit: "px" }, offsetY: { value: 8, unit: "px" },
      blur: { value: 24, unit: "px" }, spread: { value: 0, unit: "px" },
    }, "shadow"),
  } };
  const light = { tokens: {
    bg: token("color", { colorSpace: "hsl", components: [0, 0, 100] }, "bg", "light", true),
  } };
  const resolver = {
    version: "2025.10",
    sets: { base: { sources: [{ $ref: "base.tokens.json" }] } },
    modifiers: { appearance: { contexts: {
      dark: [], light: [{ $ref: "light.tokens.json" }],
    }, default: "dark" } },
    resolutionOrder: [{ $ref: "#/sets/base" }, { $ref: "#/modifiers/appearance" }],
    $extensions: { "org.zeros": { marketing: { groups: {
      surfaces: ["tokens.bg", "tokens.pane"],
    } } } },
  };
  const save = (file: string, value: unknown) =>
    writeFileSync(join(root, `styles/tokens/${file}`), JSON.stringify(value));
  save("base.tokens.json", base);
  save("light.tokens.json", light);
  save("zeros.resolver.json", resolver);
  return { root, base, light, resolver, save };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DTCG token generation", () => {
  it("emits typed values and aliases, replacing only marked declarations", () => {
    const { root } = fixture();
    const css = renderTokenCss(root);
    expect(css).toContain("--bg: hsl(0 0% 7%); /* #121212 — bg description */");
    expect(css).toContain("--pane: var(--bg); /* #121212 — pane description */");
    expect(css).toContain("--scrim: rgba(0, 0, 0, 0.5); /* #00000080 — scrim description */");
    expect(css).toContain("--weight: 450;");
    expect(css).toContain("--size: 0.9375rem;");
    expect(css).toContain("--shadow: 0 8px 24px rgba(0, 0, 0, 0.35);");
    expect(css).toContain("--color-bg: var(--bg); /* #121212 — bg description */");
    const outsideRegions = (value: string) => value.replace(
      /(\/\* @generated tokens:[a-z0-9-]+:start \*\/)[\s\S]*?( {2}\/\* @generated tokens:[a-z0-9-]+:end \*\/)/g,
      "$1\n$2",
    );
    expect(outsideRegions(css)).toBe(outsideRegions(fixtureCss));
  });

  it("round-trips idempotently and flags stale output without writing", () => {
    const { root, base, save } = fixture();
    expect(checkGeneratedTokens(root).map((finding: { file: string }) => finding.file)).toEqual([
      "styles/zeros-tokens.css", "apps/marketing/src/index.css",
    ]);
    buildTokens(root);
    const built = readFileSync(join(root, "styles/zeros-tokens.css"), "utf8");
    expect(checkGeneratedTokens(root)).toEqual([]);
    expect(renderTokenCss(root)).toBe(built);
    buildTokens(root);
    expect(readFileSync(join(root, "styles/zeros-tokens.css"), "utf8")).toBe(built);
    base.tokens.bg.$value = { colorSpace: "hsl", components: [0, 0, 8] };
    save("base.tokens.json", base);
    expect(checkGeneratedTokens(root)[0].message).toMatch(/stale.*pnpm design:docs/);
    expect(readFileSync(join(root, "styles/zeros-tokens.css"), "utf8")).toBe(built);
  });

  it("resolves inherited aliases after applying the appearance modifier", () => {
    const { root } = fixture();
    const sources = readTokenSources(root);
    expect(sources.base.size).toBe(6);
    expect(sources.lightOverrides.size).toBe(1);
    const themes = readThemes(root, renderTokenCss(root));
    expect(resolveRgb(themes.dark, "pane")).toEqual(resolveRgb(themes.dark, "bg"));
    expect(resolveRgb(themes.light, "pane")).toEqual([1, 1, 1]);
    expect(extractBlock(renderTokenCss(root), '[data-theme="light"]')).not.toContain("--pane:");
  });

  it("rejects dangling and cyclic aliases before writing", () => {
    const { root, base, save } = fixture();
    base.tokens.pane.$value = "{tokens.missing}";
    save("base.tokens.json", base);
    expect(() => buildTokens(root)).toThrow(/tokens\.missing/);
    base.tokens.pane.$value = "{tokens.bg}";
    base.tokens.bg.$value = "{tokens.pane}";
    save("base.tokens.json", base);
    expect(() => buildTokens(root)).toThrow(/cycle/i);
    expect(readFileSync(join(root, "styles/zeros-tokens.css"), "utf8")).toBe(fixtureCss);
  });

  it("rejects an alias whose target has a different type", () => {
    const { root, base, save } = fixture();
    base.tokens.pane.$value = "{tokens.weight}";
    save("base.tokens.json", base);
    expect(() => renderTokenCss(root)).toThrow(/type.*tokens\.pane/i);
  });

  it("keeps typed shadow-field aliases live in CSS", () => {
    const { root, base, save } = fixture();
    base.tokens.shadow.$value = {
      color: "{tokens.scrim}",
      offsetX: { value: 0, unit: "px" }, offsetY: "{tokens.size}",
      blur: { value: 24, unit: "px" }, spread: { value: 0, unit: "px" },
    };
    save("base.tokens.json", base);
    expect(renderTokenCss(root)).toContain("--shadow: 0 var(--size) 24px var(--scrim);");
  });

  it("rejects a numeric component alias to a non-number token", () => {
    const { root, base, save } = fixture();
    base.tokens.weight.$value = 42;
    base.tokens.bg.$value = { colorSpace: "hsl", components: [0, 0, "{tokens.weight}"] };
    save("base.tokens.json", base);
    expect(() => renderTokenCss(root)).toThrow(/type.*tokens\.bg/i);
  });

  it("reports malformed JSON with the source filename", () => {
    const { root } = fixture();
    writeFileSync(join(root, "styles/tokens/base.tokens.json"), "{ broken");
    expect(() => renderTokenCss(root)).toThrow(/base\.tokens\.json.*JSON/i);
    expect(checkGeneratedTokens(root)[0].message).toMatch(/base\.tokens\.json/);
  });

  it.each([
    ["color components", "bg", { colorSpace: "hsl", components: [0, 0, 101] }],
    ["color alpha", "scrim", { colorSpace: "srgb", components: [0, 0, 0], alpha: 2 }],
    ["dimension unit", "size", { value: 15, unit: "em" }],
    ["font weight", "weight", 1001],
    ["shadow fields", "shadow", { color: { colorSpace: "srgb", components: [0, 0, 0] } }],
  ])("rejects malformed %s", (_description, name, value) => {
    const { root, base, save } = fixture();
    base.tokens[name as keyof typeof base.tokens].$value = value;
    save("base.tokens.json", base);
    expect(() => renderTokenCss(root)).toThrow(/tokens\./);
  });

  it("rejects CSS name collisions and unknown Light tokens", () => {
    const { root, base, light, save } = fixture();
    base.tokens.pane.$extensions["org.zeros"].cssName = "--bg";
    save("base.tokens.json", base);
    expect(() => renderTokenCss(root)).toThrow(/Duplicate.*--bg/);
    base.tokens.pane.$extensions["org.zeros"].cssName = "--pane";
    save("base.tokens.json", base);
    light.tokens.bg.$extensions["org.zeros"].cssName = "--renamed";
    save("light.tokens.json", light);
    expect(() => renderTokenCss(root)).toThrow(/Light.*CSS name/);
    save("light.tokens.json", { tokens: {
      missing: token("color", { colorSpace: "hsl", components: [0, 0, 100] }, "missing", "light"),
    } });
    expect(() => renderTokenCss(root)).toThrow(/Light.*unknown token/);
  });

  it("rejects unsupported resolver inputs instead of silently changing the cascade", () => {
    const { root, resolver, save } = fixture();
    resolver.version = "draft";
    save("zeros.resolver.json", resolver);
    expect(() => renderTokenCss(root)).toThrow(/2025\.10/);
    resolver.version = "2025.10";
    resolver.resolutionOrder.reverse();
    save("zeros.resolver.json", resolver);
    expect(() => renderTokenCss(root)).toThrow(/resolutionOrder/);
  });

  it("rejects missing, duplicate, unknown and misplaced generation markers", () => {
    const { root } = fixture();
    for (const badCss of [
      fixtureCss.replace("/* @generated tokens:base:start */", "/* removed */"),
      fixtureCss.replace("  color-scheme: dark;", "  /* @generated tokens:base:start */\n  /* @generated tokens:base:end */"),
      fixtureCss.replaceAll("tokens:base:", "tokens:unknown:"),
      fixtureCss.replace("  color-scheme: dark;", "}").replace("@layer base", ":root {\n@layer base"),
      fixtureCss.replace("  color-scheme: dark;", "  color-scheme: dark;\n  --bg: hsl(0 0% 8%);"),
    ]) {
      expect(() => renderTokenCss(root, badCss)).toThrow(/marker|region|block/i);
    }
  });

  it("rejects source/section ordering that would silently reorder declarations", () => {
    const { root, base, save } = fixture();
    base.tokens.size.$extensions["org.zeros"].section = "size";
    save("base.tokens.json", base);
    const movedSection = fixtureCss.replace("  color-scheme: dark;", `  color-scheme: dark;
  /* @generated tokens:size:start */
  /* @generated tokens:size:end */`);
    expect(() => renderTokenCss(root, movedSection)).toThrow(/declaration order/i);
  });

  it.each(["a lone {", "a lone }", ":root {", '[data-theme="light"] {'])(
    "round-trips descriptions containing %s without changing block boundaries",
    (text) => {
      const { root, base, light, save } = fixture();
      base.tokens.bg.$description = `Dark description with ${text}`;
      light.tokens.bg.$description = `Light description with ${text}`;
      save("base.tokens.json", base);
      save("light.tokens.json", light);
      writeFileSync(join(root, "apps/marketing/src/index.css"), `/* Authored marketing text with ${text} */\n${fixtureMarketingCss}`);
      const desktop = renderTokenCss(root);
      const marketing = renderMarketingTokenCss(root);
      buildTokens(root);
      expect(readFileSync(join(root, "styles/zeros-tokens.css"), "utf8")).toBe(desktop);
      expect(readFileSync(join(root, "apps/marketing/src/index.css"), "utf8")).toBe(marketing);
      expect(desktop).toContain(`Dark description with ${text} */`);
      expect(desktop).toContain(`Light description with ${text} */`);
      expect(marketing).toContain(`Authored marketing text with ${text} */`);
      buildTokens(root);
      expect(renderTokenCss(root)).toBe(desktop);
      expect(renderMarketingTokenCss(root)).toBe(marketing);
      expect(checkGeneratedTokens(root)).toEqual([]);
    },
  );
});

describe("marketing token generation", () => {
  it.each(["base", "light"])("rejects a %s alias to an unexported dependency before rendering or writing", (source) => {
    const { root, base, light, save } = fixture();
    const tokens = source === "base" ? base : light;
    tokens.tokens.bg.$value = "{tokens.scrim}";
    save(`${source}.tokens.json`, tokens);
    const appearance = source === "base" ? "dark" : "light";
    const message = `Marketing export tokens.bg (${appearance}) depends on unexported tokens.scrim`;
    for (const render of [renderTokenCss, renderMarketingTokenCss]) {
      expect(() => render(root)).toThrow(message);
    }
    expect(() => buildTokens(root)).toThrow(message);
    expect(readFileSync(join(root, "styles/zeros-tokens.css"), "utf8")).toBe(fixtureCss);
    expect(readFileSync(join(root, "apps/marketing/src/index.css"), "utf8")).toBe(fixtureMarketingCss);
    expect(checkGeneratedTokens(root)).toEqual([expect.objectContaining({
      file: `styles/tokens/${source}.tokens.json`, message: expect.stringContaining(message),
    })]);
  });

  it("names the original export when a transitive dependency is missing", () => {
    const { root, base, save } = fixture();
    base.tokens.bg.$value = "{tokens.pane}";
    base.tokens.pane.$value = "{tokens.scrim}";
    save("base.tokens.json", base);
    expect(() => renderMarketingTokenCss(root)).toThrow(
      "Marketing export tokens.bg (dark) depends on unexported tokens.scrim",
    );
  });

  it("accepts an exported dependency chain in both themes and keeps every alias live", () => {
    const { root, base, light, resolver, save } = fixture();
    base.tokens.bg.$value = "{tokens.pane}";
    base.tokens.pane.$value = "{tokens.scrim}";
    light.tokens.bg.$value = "{tokens.pane}";
    resolver.$extensions["org.zeros"].marketing.groups.surfaces.push("tokens.scrim");
    save("base.tokens.json", base);
    save("light.tokens.json", light);
    save("zeros.resolver.json", resolver);
    buildTokens(root);
    const desktop = renderTokenCss(root);
    const marketing = renderMarketingTokenCss(root);
    for (const block of [extractBlock(desktop, ":root"), extractBlock(marketing, ":root"),
      extractBlock(extractBlock(marketing, "@media (prefers-color-scheme: light)"), ":root")]) {
      expect(declarations(block).get("bg")).toBe("var(--pane)");
      expect(declarations(block).get("pane")).toBe("var(--scrim)");
      expect(resolveRgb(declarations(block), "bg")).toEqual([0, 0, 0]);
    }
    expect(extractBlock(desktop, '[data-theme="light"]')).toContain("--bg: var(--pane);");
    expect(checkGeneratedTokens(root)).toEqual([]);
  });

  it("emits compact typed values and live aliases in both appearance scopes", () => {
    const { root, base, save } = fixture();
    base.tokens.bg.$extensions["org.zeros"].cssFormat = "multiline";
    save("base.tokens.json", base);
    const css = renderMarketingTokenCss(root);
    const dark = extractBlock(css, ":root");
    const light = extractBlock(extractBlock(css, "@media (prefers-color-scheme: light)"), ":root");
    expect(dark).toContain("--bg: hsl(0 0% 7%); /* #121212 */");
    expect(light).toContain("--bg: hsl(0 0% 100%); /* #FFFFFF */");
    expect(dark).toContain("--pane: var(--bg);");
    expect(light).toContain("--pane: var(--bg);");
    const outsideRegions = (source: string) => source.replace(
      /^[ \t]*\/\* @generated tokens:marketing-[a-z0-9-]+:start \*\/[\s\S]*?^[ \t]*\/\* @generated tokens:marketing-[a-z0-9-]+:end \*\//gm,
      "",
    );
    expect(outsideRegions(css)).toBe(outsideRegions(fixtureMarketingCss));
  });

  it("keeps full desktop descriptions while marketing emits only swatches, including alpha", () => {
    const { root, base, resolver, save } = fixture();
    base.tokens.bg.$description = "A deliberately long description ".repeat(8).trim();
    resolver.$extensions["org.zeros"].marketing.groups.surfaces.push("tokens.scrim");
    save("base.tokens.json", base);
    save("zeros.resolver.json", resolver);
    const desktop = renderTokenCss(root);
    const marketing = renderMarketingTokenCss(root);
    expect(desktop).toContain(`/* #121212 — ${base.tokens.bg.$description} */`);
    expect(marketing).toContain("--bg: hsl(0 0% 7%); /* #121212 */");
    expect(marketing).toContain("--scrim: rgba(0, 0, 0, 0.5); /* #00000080 */");
    expect(marketing).not.toContain(base.tokens.bg.$description);
  });

  it("keeps all 52 generated marketing declarations within CSS print width with hex-only comments", () => {
    const css = renderMarketingTokenCss(ROOT);
    const lines = [...css.matchAll(/\/\* @generated tokens:marketing-[a-z0-9-]+:start \*\/([\s\S]*?)\/\* @generated tokens:marketing-[a-z0-9-]+:end \*\//g)]
      .flatMap((match) => match[1].split("\n").filter((line) => line.trim()));
    expect(lines).toHaveLength(52);
    for (const line of lines) {
      expect(line.length, "Generated marketing declarations must fit Prettier's 80-column CSS width").toBeLessThanOrEqual(80);
      expect(line).toMatch(/; \/\* #[0-9A-F]{6}(?:[0-9A-F]{2})? \*\/$/);
    }
  });

  it("checks stale Dark and Light marketing regions without writing", () => {
    const { root } = fixture();
    buildTokens(root);
    const file = join(root, "apps/marketing/src/index.css");
    const generated = readFileSync(file, "utf8");
    for (const original of ["hsl(0 0% 7%)", "hsl(0 0% 100%)"]) {
      const stale = generated.replace(original, "hsl(0 0% 8%)");
      writeFileSync(file, stale);
      expect(checkGeneratedTokens(root)).toEqual([expect.objectContaining({
        file: "apps/marketing/src/index.css", message: expect.stringMatching(/stale.*pnpm design:docs/),
      })]);
      expect(readFileSync(file, "utf8")).toBe(stale);
    }
    buildTokens(root);
    expect(readFileSync(file, "utf8")).toBe(generated);
    expect(checkGeneratedTokens(root)).toEqual([]);
  });

  it("builds both token outputs only after validating both templates", () => {
    const { root } = fixture();
    const file = join(root, "apps/marketing/src/index.css");
    writeFileSync(file, fixtureMarketingCss.replace("tokens:marketing-light-surfaces:start", "tokens:missing:start"));
    expect(() => buildTokens(root)).toThrow(/marker/);
    expect(readFileSync(join(root, "styles/zeros-tokens.css"), "utf8")).toBe(fixtureCss);
  });

  it("rejects unknown exports, duplicates, and a missing export configuration", () => {
    const { root, resolver, save } = fixture();
    for (const groups of [
      { surfaces: ["tokens.missing"] },
      { surfaces: ["tokens.bg", "tokens.bg"] },
      { surfaces: ["tokens.weight"] },
      {},
    ]) {
      resolver.$extensions["org.zeros"].marketing.groups = groups;
      save("zeros.resolver.json", resolver);
      expect(() => renderMarketingTokenCss(root)).toThrow(/marketing/i);
    }
  });

  it("rejects misplaced, duplicated, missing and unmarked clone declarations", () => {
    const { root } = fixture();
    for (const source of [
      fixtureMarketingCss.replaceAll("tokens:marketing-light-surfaces:", "tokens:marketing-dark-surfaces:"),
      fixtureMarketingCss.replace("    color-scheme: light;", "    color-scheme: light;\n    --bg: hsl(0 0% 100%);"),
      fixtureMarketingCss.replace("  color-scheme: dark;", "  color-scheme: dark;\n  --bg: hsl(0 0% 7%);"),
      fixtureMarketingCss.replace("  /* @generated tokens:marketing-dark-surfaces:start */", "  /* missing */"),
    ]) expect(() => renderMarketingTokenCss(root, source)).toThrow(/marker|unmarked/i);
  });

  it("keeps the repository marketing regions fresh and exports only the intended subset", () => {
    const css = readFileSync(join(ROOT, "apps/marketing/src/index.css"), "utf8");
    expect(renderMarketingTokenCss(ROOT) === css, "Marketing token regions must be fresh").toBe(true);
  });
});

describe("CSS block discovery", () => {
  it("ignores selectors and braces in comments and escaped quoted strings while preserving the exact body", () => {
    const body = String.raw`
  --bg: hsl(0 0% 7%);
  --opening: "{";
  --closing: '}';
  --double-quote: "escaped \" quote } and :root {";
  --single-quote: 'escaped \' quote { and :root {';
  /* an unmatched { and :root { in a comment */
  .nested { content: "}"; }
`;
    const css = `/* :root { phantom block } */
.before { content: ":root {"; }
:root {${body}}
.after { content: "}"; }`;
    expect(extractBlock(css, ":root")).toBe(body);
    expect(extractBlock(css, ".after")).toBe(' content: "}"; ');
  });
});

describe("repository token value identity", () => {
  it("resolves sRGB literals and scrim aliases for the value-identity proof", () => {
    const theme = new Map([
      ["scrim", "rgba(0, 0, 0, 0.5)"],
      ["overlay", "var(--scrim)"],
      ["color", "rgb(255, 128, 0)"],
    ]);
    expect(resolveRgb(theme, "overlay")).toEqual([0, 0, 0]);
    expect(resolveRgb(theme, "color")).toEqual([1, 128 / 255, 0]);
  });

  it("keeps every source value, declaration order and generated region in sync", () => {
    const css = readFileSync(join(ROOT, "styles/zeros-tokens.css"), "utf8");
    expect(renderTokenCss(ROOT) === css, "Generated token regions must be fresh").toBe(true);
    expect(checkGeneratedTokens(ROOT)).toEqual([]);
    const sources = readTokenSources(ROOT);
    const themes = readThemes(ROOT, css);
    const base = [...sources.base.values()];
    const overrides = [...sources.lightOverrides.values()];
    expect([...declarations(extractBlock(css, ":root")).keys()]).toEqual(base.map((entry: { cssName: string }) => entry.cssName.slice(2)));
    expect([...declarations(extractBlock(css, '[data-theme="light"]')).keys()]).toEqual(overrides.map((entry: { cssName: string }) => entry.cssName.slice(2)));

    // Independent checks read DTCG values directly, so a serializer bug cannot
    // pass merely because its own output agrees with itself.
    for (const [name, entries] of Object.entries(sources.themes)) {
      const theme = themes[name as keyof typeof themes];
      for (const entry of entries.values()) {
        const source = entry.token.$value;
        const cssName = entry.cssName.slice(2);
        if (typeof source === "string") {
          const target = entries.get(source.slice(1, -1));
          expect(theme.get(cssName)?.replace(/\s+/g, "")).toBe(`var(${target.cssName})`);
        } else if (entry.token.$type === "color") {
          const expected = source.colorSpace === "hsl"
            ? hslToRgb(...source.components).map((channel: number) => Math.round(channel * 255) / 255)
            : source.components;
          if (source.colorSpace === "hsl") {
            expect(resolveRgb(theme, cssName), `${name} ${cssName}`).toEqual(expected);
            const triple = resolveValue(theme, cssName).match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/);
            expect(triple?.slice(1).map(Number)).toEqual(source.components);
          } else {
            const rgba = resolveValue(theme, cssName).match(/rgba\(([^)]+)\)/)?.[1].split(",").map(Number);
            expect(rgba).toEqual([...expected.map((channel: number) => channel * 255), source.alpha]);
            expect(resolveRgb(theme, cssName)).toEqual(expected);
          }
          expect(css).toContain(toHex(expected));
        } else if (entry.token.$type === "fontWeight") {
          expect(theme.get(cssName)).toBe(String(source));
        } else if (entry.token.$type === "dimension") {
          expect(theme.get(cssName)).toBe(`${source.value}${source.unit}`);
        } else if (entry.token.$type === "shadow") {
          const dimension = (value: { value: number; unit: string }) => value.value === 0 ? "0" : `${value.value}${value.unit}`;
          expect(theme.get(cssName)).toBe(
            `${dimension(source.offsetX)} ${dimension(source.offsetY)} ${dimension(source.blur)} rgba(${source.color.components.map((channel: number) => channel * 255).join(", ")}, ${source.color.alpha})`,
          );
        }
      }
    }
  });
});
