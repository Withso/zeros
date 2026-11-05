import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SHELL_CSS, SHELL_TOKENS, shell } from "./page.ts";

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

const ORBIT = [
  "@property --orb-turn { syntax: \"<angle>\"; inherits: false; initial-value: 0deg; }",
  ".orb { position: relative; display: inline-block; width: 16px; height: 16px; flex-shrink: 0; color: var(--fg2); }",
  ".orb::before, .orb::after { content: \"\"; position: absolute; inset: 2px; box-sizing: border-box; }",
  ".orb::before { border: 3px solid var(--muted-fg); opacity: 0.4; }",
  ".orb::after { padding: 3px; background: conic-gradient(from calc(var(--orb-turn) - 80deg), transparent 0deg, currentColor 80deg 188deg, transparent 188deg 360deg);" +
    " -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;" +
    " mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); animation: orb-lap 1200ms linear infinite; }",
  "@keyframes orb-lap { to { --orb-turn: 360deg; } }",
  "@media (prefers-reduced-motion: reduce) { .orb::after { animation: none; } }",
].join(" ");

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

  it("draws the 16px loader that stands in for an action while a page checks", () => {
    const css = SHELL_CSS.replace(/\s+/g, " ");
    assert.match(css, /\.spin \{ display: flex; height: 18px; align-items: center; justify-content: center; margin-top: 24px; \}/);
    assert.ok(css.includes(ORBIT), "the shell draws the app's Orbit");
  });

  // The app's Orbit (shared/ui/loading/zeros-spinner.tsx): a square ring whose
  // snake laps it every 1200ms over a muted-fg track at 40%, resting under
  // reduced motion. The dashboard and the shell draw the same one.
  it("draws the same square Orbit on the dashboard", async () => {
    const dashboard = (await readFile(new URL("../public/dashboard.css", import.meta.url), "utf8")).replace(/\s+/g, " ");
    assert.ok(dashboard.includes(ORBIT), "the dashboard draws the app's Orbit");
    assert.doesNotMatch(ORBIT, /border-radius|rotate\(/);
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
