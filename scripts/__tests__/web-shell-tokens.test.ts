import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// apps/web/lib/page.ts carries a hand-written copy of the app palette (the web
// functions ship no CSS pipeline). This pins every value to
// styles/zeros-tokens.css, so a token change fails here instead of leaving the
// centred web pages on the old colours.
const root = process.cwd();
const app = readFileSync(join(root, "styles/zeros-tokens.css"), "utf8");
const page = readFileSync(join(root, "apps/web/lib/page.ts"), "utf8");

/** The web name and the app token it copies. */
const COPIES: Record<string, string> = {
  "--bg1": "--bg1",
  "--fg1": "--fg1",
  "--fg2": "--fg2",
  "--fg3": "--fg3",
  "--border3": "--border3",
  "--bg2-highlight": "--bg2-highlight",
  "--primary-bg": "--primary-button-bg",
  "--primary-fg": "--primary-button-fg",
  "--primary-hover": "--primary-button-hover",
  "--red-fg": "--red-fg",
};

function block(source: string, header: string): string {
  const at = source.indexOf(header);
  if (at < 0) throw new Error(`missing block: ${header}`);
  const start = source.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start + 1, i);
  }
  throw new Error(`unclosed block: ${header}`);
}

function tokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(match[1]!, match[2]!.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim());
  }
  return out;
}

function resolve(map: Map<string, string>, name: string, depth = 0): string | undefined {
  const value = map.get(name);
  const reference = value?.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (!reference || depth > 8) return value;
  return resolve(map, reference[1]!, depth + 1);
}

const appDark = tokens(block(app, ":root {"));
const appLight = new Map([...appDark, ...tokens(block(app, '[data-theme="light"] {'))]);
const webDark = tokens(block(page, ":root {"));
const webLight = tokens(block(block(page, "@media (prefers-color-scheme: light) {"), ":root {"));

describe("web shell palette", () => {
  // A real colour on both sides, so a parse miss cannot pass as undefined.
  it.each(Object.entries(COPIES))("%s copies %s in Dark", (web, token) => {
    expect(resolve(appDark, token)).toMatch(/^hsl\(/);
    expect(webDark.get(web)).toBe(resolve(appDark, token));
  });

  it.each(Object.entries(COPIES))("%s copies %s in Light", (web, token) => {
    expect(resolve(appLight, token)).toMatch(/^hsl\(/);
    expect(webLight.get(web)).toBe(resolve(appLight, token));
  });
});
