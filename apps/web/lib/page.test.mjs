import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SHELL_TOKENS, shell } from "./page.ts";

/** The value of each custom property in one theme block of styles/zeros-tokens.css,
 * with var() references resolved inside the same block. */
function themeValues(block) {
  const values = new Map();
  const pattern = /(--[a-z0-9-]+):\s*([^;]+);/g;
  for (const [, name, raw] of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(pattern)) {
    if (!values.has(name)) values.set(name, raw.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim());
  }
  const resolve = (value, seen = new Set()) => {
    const reference = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (!reference || seen.has(reference[1]) || !values.has(reference[1])) return value;
    seen.add(reference[1]);
    return resolve(values.get(reference[1]), seen);
  };
  return (name) => (values.has(name) ? resolve(values.get(name)) : undefined);
}

describe("shared hosted-page shell", () => {
  it("keeps hidden controls out of layout even when their component sets display", async () => {
    const source = await readFile(new URL("./page.ts", import.meta.url), "utf8");

    assert.match(source, /\[hidden\], \.hidden\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });

  it("uses the app's token values in both themes", async () => {
    const source = await readFile(new URL("../../../styles/zeros-tokens.css", import.meta.url), "utf8");
    const lightStart = source.indexOf('[data-theme="light"] {');
    const darkStart = source.indexOf("\n:root {");
    assert.ok(darkStart >= 0 && lightStart > darkStart, "zeros-tokens.css keeps its :root and light blocks");
    const dark = themeValues(source.slice(darkStart, lightStart));
    const light = themeValues(source.slice(lightStart, source.indexOf("\n}\n", lightStart)));
    for (const [name, value] of Object.entries(SHELL_TOKENS.dark)) {
      assert.equal(value, dark(name), `dark ${name}`);
    }
    for (const [name, value] of Object.entries(SHELL_TOKENS.light)) {
      assert.equal(value, light(name) ?? dark(name), `light ${name}`);
    }
  });

  it("draws the logo, the mark and a badge inline, under a style nonce", () => {
    const page = shell("Restricted operations", '<div class="title">Restricted operations</div>', {
      nonce: "abcdefgh12",
      badge: "Ops",
    });

    assert.match(page, /<style nonce="abcdefgh12">/);
    assert.match(page, /<a class="brand" href="\/" aria-label="Zeros home"><svg class="brand-mark"/);
    assert.match(page, /<svg class="hero-logo"[^>]*>.*<\/svg><span class="badge">Ops<\/span><div class="title">/);
    assert.doesNotMatch(page, /<img /);
  });
});
