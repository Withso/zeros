import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const renderer = (path: string) => read(`apps/desktop/src/renderer/${path}`);

/** The declarations inside one generated token section. */
function section(css: string, name: string): string {
  const start = css.indexOf(`/* @generated tokens:${name}:start */`);
  const end = css.indexOf(`/* @generated tokens:${name}:end */`);
  if (start < 0 || end < start) throw new Error(`token section ${name} is missing`);
  return css.slice(start, end);
}

/** Top-level rules of a flat stylesheet, keyed by their selector. */
function rules(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.set(match[1].replace(/\s+/g, " ").trim(), match[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

function rule(css: string, selector: string): string {
  const body = rules(css).get(selector);
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body;
}

/** A color token's sRGB value as hex digits, from its DTCG hsl components. */
function hexDigits(file: string, name: string): string {
  const { tokens } = JSON.parse(read(file)) as {
    tokens: Record<string, { $value: { colorSpace: string; components: number[] } }>;
  };
  const { colorSpace, components } = tokens[name].$value;
  expect(colorSpace).toBe("hsl");
  const [h, s, l] = [components[0], components[1] / 100, components[2] / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [channel(0), channel(8), channel(4)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// 2026-11-09 direction: every scrollbar in the app is one thumb, hex 222 in
// Dark and hex EAEAEA in Light. It is 4px wide at rest inside a 6px slot that
// never changes width, takes the full 6px under the pointer, and never changes
// color.
describe("scrollbar tokens", () => {
  it("declares the thumb color for both themes and the slot geometry once", () => {
    expect(hexDigits("styles/tokens/base.tokens.json", "scrollbar-thumb")).toBe("222222");
    expect(hexDigits("styles/tokens/light.tokens.json", "scrollbar-thumb")).toBe("EAEAEA");
    const css = read("styles/zeros-tokens.css");
    const base = section(css, "base-scrollbar-thumb");
    expect(base).toContain("--scrollbar-thumb: ");
    expect(base).toContain("--scrollbar-size: 6px;");
    expect(base).toContain("--scrollbar-thumb-inset: 1px;");
    expect(section(css, "light-scrollbar-thumb")).toContain("--scrollbar-thumb: ");
  });

  it("records the faint thumb as a reviewed exemption rather than a pairing", () => {
    const contract = JSON.parse(read("styles/policy/contrast-contract.json")) as {
      exempt: { tokens: string[] }[];
    };
    expect(contract.exempt.flatMap((entry) => entry.tokens)).toContain("scrollbar-thumb");
  });
});

describe("the native scrollbar", () => {
  const css = () => read("styles/global/scrollbars.css");

  it("styles every scroller in the document, portaled menus and Home included", () => {
    expect(css()).not.toMatch(/\[data-Zeros-root\] (:hover)?::-webkit-scrollbar/);
    expect(rule(css(), "::-webkit-scrollbar")).toContain("width: var(--scrollbar-size); height: var(--scrollbar-size);");
    expect(rule(css(), "::-webkit-scrollbar-track, ::-webkit-scrollbar-corner")).toContain("background: transparent;");
  });

  it("draws the 4px thumb inside the slot and grows it to 6px under the pointer with no color change", () => {
    const thumb = rule(css(), "::-webkit-scrollbar-thumb");
    expect(thumb).toContain("border: var(--scrollbar-thumb-inset) solid transparent;");
    expect(thumb).toContain("background-clip: padding-box;");
    expect(thumb).toContain("background-color: transparent;");
    expect(rule(css(), ":hover::-webkit-scrollbar-thumb")).toBe("background-color: var(--scrollbar-thumb);");
    expect(rule(css(), "::-webkit-scrollbar-thumb:hover, ::-webkit-scrollbar-thumb:active")).toBe("border-width: 0;");
    // One color for every state, and no `background` shorthand that would reset
    // the clip and paint the thumb under its inset.
    expect(css()).not.toMatch(/--border[234]/);
    expect(css()).not.toMatch(/scrollbar-thumb[^{]*\{[^}]*\bbackground:/);
  });

  it("gives the Dashboard's always-on bar the same 4px thumb and 6px hover in its 10px track", () => {
    expect(rule(css(), ".zeros-hscroll::-webkit-scrollbar-thumb")).toContain("background-color: var(--scrollbar-thumb);");
    expect(rule(css(), ".zeros-hscroll::-webkit-scrollbar-thumb")).toContain(
      "border: calc((10px - var(--scrollbar-size)) / 2 + var(--scrollbar-thumb-inset)) solid transparent;",
    );
    expect(rule(css(), ".zeros-hscroll::-webkit-scrollbar-thumb:hover, .zeros-hscroll::-webkit-scrollbar-thumb:active")).toBe(
      "border-width: calc((10px - var(--scrollbar-size)) / 2);",
    );
  });

  it("narrows the terminal's slider to the same thumb at its track's right edge", () => {
    expect(rule(css(), ".xterm .xterm-scrollable-element:hover > .scrollbar > .slider")).toBe(
      "background-color: var(--scrollbar-thumb) !important;",
    );
    const slider = rule(css(), ".xterm .xterm-scrollable-element > .scrollbar.vertical > .slider");
    expect(slider).toContain("left: auto !important;");
    expect(slider).toContain("right: var(--scrollbar-thumb-inset) !important;");
    expect(slider).toContain("width: calc(var(--scrollbar-size) - 2 * var(--scrollbar-thumb-inset)) !important;");
    const grown = rule(
      css(),
      ".xterm .xterm-scrollable-element > .scrollbar.vertical > .slider:hover, .xterm .xterm-scrollable-element > .scrollbar.vertical > .slider.active",
    );
    expect(grown).toContain("right: 0 !important;");
    expect(grown).toContain("width: var(--scrollbar-size) !important;");
    const view = renderer("shell/terminal/terminal-session-view.tsx");
    expect(view).toContain('scrollbarSliderHoverBackground: resolveTokenValue("--scrollbar-thumb") ?? undefined,');
    expect(view).toContain('scrollbarSliderActiveBackground: resolveTokenValue("--scrollbar-thumb") ?? undefined,');
    // xterm's own track stays: setting the overview ruler's width would also
    // draw that ruler, whose outline defaults to white.
    expect(view).not.toContain("overviewRuler");
  });
});

describe("scrollbars the global rules cannot reach", () => {
  it("styles the ScrollArea primitive's thumb from the same tokens", () => {
    const area = renderer("shared/ui/primitives/scroll-area.tsx");
    expect(area).toContain('"h-full w-(--scrollbar-size)"');
    expect(area).toContain('"h-(--scrollbar-size) flex-col"');
    expect(area).toContain(
      '"relative flex-1 rounded-full bg-(--scrollbar-thumb) m-(--scrollbar-thumb-inset) hover:m-0 active:m-0"',
    );
    expect(area).not.toMatch(/hover:bg-|w-2\.5|h-2\.5/);
  });

  it("gives the diff viewer's code rows the same thumb inside its shadow root", () => {
    const theme = renderer("shared/theme/diff-theme.ts");
    expect(theme).toContain("[data-file]:hover [data-code]::-webkit-scrollbar-thumb {");
    expect(theme).toContain("background-color: var(--scrollbar-thumb);");
    expect(theme).toContain("[data-code]::-webkit-scrollbar-thumb:active { border-width: 0; }");
  });

  it("drops the browser-drawn thin bars so the composer and folded prompts take the app's thumb", () => {
    expect(renderer("features/agent/composer-editor/use-composer-editor.tsx")).not.toMatch(/\[scrollbar-width:/);
    expect(renderer("features/agent/composer-editor/composer-editor.css")).not.toMatch(/scrollbar-(color|width)\s*:/);
    expect(renderer("features/agent/prompt-fold.tsx")).not.toMatch(/\[scrollbar-width:/);
  });
});
