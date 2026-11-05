import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHELL_TOKENS } from "../../apps/web/lib/page";

// apps/web/lib/page.ts carries the app palette inline (its pages render under
// policies that admit no stylesheet file, and the control plane keeps a copy of
// the same shell). This pins every value to styles/zeros-tokens.css, so a token
// change fails here instead of leaving the centred web pages on old colours.
const app = readFileSync(join(process.cwd(), "styles/zeros-tokens.css"), "utf8");

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

describe("web shell palette", () => {
  it("defines the same tokens in both themes", () => {
    expect(Object.keys(SHELL_TOKENS.dark).length).toBeGreaterThan(0);
    expect(Object.keys(SHELL_TOKENS.light)).toEqual(Object.keys(SHELL_TOKENS.dark));
  });

  // A real colour on both sides, so a lookup miss cannot pass as undefined.
  it.each(Object.entries(SHELL_TOKENS.dark))("%s matches the app in Dark", (name, value) => {
    expect(resolve(appDark, name)).toMatch(/^hsl\(/);
    expect(value).toBe(resolve(appDark, name));
  });

  it.each(Object.entries(SHELL_TOKENS.light))("%s matches the app in Light", (name, value) => {
    expect(resolve(appLight, name)).toMatch(/^hsl\(/);
    expect(value).toBe(resolve(appLight, name));
  });
});
