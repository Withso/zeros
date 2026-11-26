import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import {
  readThemes,
  relativeLuminance,
  resolveRgb,
} from "../../../../../../../scripts/design-system/token-palette.mjs";
import { PILL_GROUND, PILL_SHELL } from "../composer-editor/pill-views";
import { TurnPromptHeader } from "../turn-container";

function css(repoPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../../../${repoPath}`, import.meta.url)),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
}

function themeBlock(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  return stylesheet.slice(start, stylesheet.indexOf("\n}", start));
}

// 2026-11-25 (P13): pills are tuned to the ground that holds them. The agent
// chat keeps bg2 on border2; the composer rests them on bg2-hover; a sent
// message rests them on selected-bg with no edge. Each fill stays a visible
// step off its ground in both themes.
describe("pills by ground", () => {
  it("fill and edge from the ground's --pill-* variables", () => {
    expect(PILL_SHELL.split(" ")).toEqual(expect.arrayContaining(["bg-(--pill-bg)", "border-(--pill-border)"]));
    expect(PILL_SHELL.split(" ")).not.toContain("bg-bg2");
  });

  it("take the sent message's pill ground inside its bubble", () => {
    const markup = renderToStaticMarkup(h(TurnPromptHeader, { originalText: "hi", children: "hi" }));
    expect(markup).toMatch(/data-user-bubble=""[^>]*class="[^"]*\[--pill-bg:var\(--selected-bg\)\]/);
    expect(PILL_GROUND.message).toContain("[--pill-border:transparent]");
    expect(PILL_GROUND.composer).toContain("[--pill-bg:var(--bg2-hover)]");
  });

  it("keeps every pill fill a visible step off its ground in both themes", () => {
    const semantic = css("styles/semantic-tokens.css");
    expect(/--pill-bg:\s*var\(--bg2\);/.test(themeBlock(semantic, ":root"))).toBe(true);
    const themes = readThemes();
    const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    for (const theme of [themes.dark, themes.light]) {
      for (const [ground, fill] of [["bg1", "bg2"], ["bg1-raised", "bg2-hover"], ["bg2", "selected-bg"]]) {
        const step = ratio(
          relativeLuminance(resolveRgb(theme, ground)),
          relativeLuminance(resolveRgb(theme, fill)),
        );
        expect(step, `${fill} on ${ground}`).toBeGreaterThan(1.09);
      }
    }
  });
});
