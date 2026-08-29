import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const APP_TOKENS = join(ROOT, "styles/zeros-tokens.css");
const MARKETING_TOKENS = join(ROOT, "apps/marketing/src/index.css");
const MARKETING_HTML = join(ROOT, "apps/marketing/index.html");
const HOME_PAGE = join(ROOT, "apps/marketing/src/pages/HomePage.tsx");

/** Tokens the homepage actually consumes — must stay cloned from the app. */
const DARK_TOKENS = [
  "--bg0",
  "--bg1",
  "--bg1-hover",
  "--bg1-highlight",
  "--bg2",
  "--bg2-hover",
  "--bg3",
  "--bg4",
  "--bg5",
  "--fg1",
  "--fg2",
  "--fg3",
  "--muted-fg",
  "--sidebar-bg",
  "--sidebar-bg-hover",
  "--border1",
  "--border2",
  "--border3",
  "--border4",
  "--highlighted-bg",
  "--highlighted-bright",
  "--inverted-bg",
  "--inverted-fg",
  "--primary-button-hover",
  "--green-fg",
  "--yellow-primary",
] as const;

const LIGHT_TOKENS = DARK_TOKENS;

function cssBlockAfter(source: string, header: string): string {
  const idx = source.indexOf(header);
  if (idx < 0) {
    throw new Error(`missing CSS header: ${header}`);
  }
  const start = source.indexOf("{", idx + header.length - 1);
  if (start < 0) {
    throw new Error(`missing CSS opening brace after: ${header}`);
  }
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  throw new Error(`unclosed CSS block after: ${header}`);
}

function tokenMap(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of block.matchAll(re)) {
    const name = match[1];
    const value = match[2]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .trim();
    out.set(name, value);
  }
  return out;
}

describe("marketing appearance tokens", () => {
  const app = readFileSync(APP_TOKENS, "utf8");
  const marketing = readFileSync(MARKETING_TOKENS, "utf8");

  it("clones Neutral Dark primitives from the app :root", () => {
    const appDark = tokenMap(cssBlockAfter(app, ":root {"));
    const marketingDark = tokenMap(cssBlockAfter(marketing, ":root {"));
    for (const token of DARK_TOKENS) {
      expect(marketingDark.get(token), token).toBe(appDark.get(token));
    }
  });

  it("clones Light primitives into prefers-color-scheme: light", () => {
    const appLight = tokenMap(cssBlockAfter(app, '[data-theme="light"] {'));
    const lightMedia = cssBlockAfter(
      marketing,
      "@media (prefers-color-scheme: light) {",
    );
    const marketingLight = tokenMap(cssBlockAfter(lightMedia, ":root {"));
    for (const token of LIGHT_TOKENS) {
      expect(marketingLight.get(token), token).toBe(appLight.get(token));
    }
  });

  it("follows the browser color-scheme with no in-page theme switcher", () => {
    const html = readFileSync(MARKETING_HTML, "utf8");
    const home = readFileSync(HOME_PAGE, "utf8");
    expect(html).not.toMatch(/data-theme="dark"/);
    expect(html).toMatch(/prefers-color-scheme: dark/);
    expect(html).toMatch(/prefers-color-scheme: light/);
    expect(marketing).toMatch(/@media \(prefers-color-scheme: light\)/);
    expect(marketing).toMatch(
      /@custom-variant dark \(@media \(prefers-color-scheme: dark\)\);/,
    );
    expect(`${html}\n${home}`).not.toMatch(
      /theme[- ]toggle|setTheme|data-theme-palette/i,
    );
  });
});
