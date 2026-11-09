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
import { PILL_SHELL } from "../composer-editor/pill-views";
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

// 2026-11-09: a pill inside a sent message (a mention, file, attachment or chat
// link) sits a step lighter than the bg2 bubble in both themes, so it reads as
// a chip again; the composer's pills keep bg2.
describe("pills inside a sent message", () => {
  it("fill from the surface that holds them, bg2 unless it says otherwise", () => {
    expect(PILL_SHELL.split(" ")).toContain("bg-[var(--pill-bg,var(--bg2))]");
    expect(PILL_SHELL.split(" ")).not.toContain("bg-bg2");
  });

  it("take the sent message's own pill fill inside its bubble", () => {
    const markup = renderToStaticMarkup(h(TurnPromptHeader, { originalText: "hi", children: "hi" }));
    expect(markup).toMatch(/data-user-bubble=""[^>]*class="[^"]*\[--pill-bg:var\(--prompt-pill-bg\)\]/);
  });

  it("step one lighter than the bg2 bubble in each theme", () => {
    const semantic = css("styles/semantic-tokens.css");
    const dark = /--prompt-pill-bg:\s*var\(--([a-z0-9-]+)\);/.exec(themeBlock(semantic, ":root"))?.[1];
    const light = /--prompt-pill-bg:\s*var\(--([a-z0-9-]+)\);/.exec(
      themeBlock(semantic, '[data-theme="light"]'),
    )?.[1];
    expect([dark, light]).toEqual(["bg2-hover", "sidebar-bg"]);
    const themes = readThemes();
    for (const [theme, step] of [[themes.dark, dark!], [themes.light, light!]] as const) {
      expect(relativeLuminance(resolveRgb(theme, step))).toBeGreaterThan(
        relativeLuminance(resolveRgb(theme, "bg2")),
      );
    }
  });
});
