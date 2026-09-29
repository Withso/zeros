import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GLASS_COMBOS,
  glassComboStops,
  glassTint,
  pickGlassCombo,
} from "../../shared/ui/loading/glass-combos";
import { GLASS_MOTIONS, GLASS_TILES } from "../../shared/ui/loading/glass-motion";
import { ZerosSpinner } from "../../shared/ui/loading/zeros-spinner";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** Deterministic PRNG. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("glass colour combos", () => {
  it("mix four to six colours, each kept lighter than pastel", () => {
    expect(GLASS_COMBOS.length).toBeGreaterThanOrEqual(12);
    for (const combo of GLASS_COMBOS) {
      expect(combo.colors.length).toBeGreaterThanOrEqual(4);
      expect(combo.colors.length).toBeLessThanOrEqual(6);
      // Every gradient renders the same stops, shorter combos holding their last.
      const stops = glassComboStops(combo);
      expect(stops).toHaveLength(6);
      expect(stops.at(-1)?.color).toBe(glassTint(combo.colors.at(-1) as string));
    }
    // Mostly white on dark, mostly a dark grey on light.
    expect(glassTint("#F27BC4")).toBe("color-mix(in oklab, #F27BC4 30%, light-dark(#3b3b3b, #ffffff))"); // check:ui ignore-line (combo colour under test)
  });

  it("never pick the combo already showing", () => {
    const random = mulberry32(3);
    let combo = pickGlassCombo(null, random);
    for (let i = 0; i < 200; i++) {
      const next = pickGlassCombo(combo, random);
      expect(next).not.toBe(combo);
      combo = next;
    }
  });
});

describe("ZerosSpinner variant=glass", () => {
  const render = (props: Parameters<typeof ZerosSpinner>[0]) =>
    renderToStaticMarkup(createElement(ZerosSpinner, props));

  it("runs one of the three motions, picked at random per mount", () => {
    const picked = new Set(
      Array.from({ length: 60 }, () => /data-glass-motion="(\w+)"/.exec(render({ size: 16, variant: "glass" }))?.[1]),
    );
    expect([...picked].sort()).toEqual([...GLASS_MOTIONS].sort());
    for (const motion of GLASS_MOTIONS) {
      expect(render({ size: 16, variant: "glass", motion })).toContain(`data-glass-motion="${motion}"`);
    }
    expect(render({ size: 16, variant: "agent" })).not.toContain("data-glass-motion");
  });

  it("shows two layers of glass through the tiles, each tile with a twin", () => {
    for (const motion of GLASS_MOTIONS) {
      const markup = render({ size: 16, variant: "glass", motion, label: "Agent working" });
      expect(markup).toContain('data-zeros-loader="glass"');
      expect(markup).toContain('aria-label="Agent working"');
      const masks = [...markup.matchAll(/<mask\b[\s\S]*?<\/mask>/g)].map((m) => m[0]);
      expect(masks).toHaveLength(2);
      // Every tile is in both masks, shown in layer 0 to start; its twin
      // waits a square to the left, outside.
      const shown = (mask: string) => (mask.match(/opacity:1/g) ?? []).length;
      expect(shown(masks[0])).toBe(GLASS_TILES * 2);
      expect(shown(masks[1])).toBe(0);
      for (const mask of masks) {
        expect(mask.match(/<rect x="-4"/g)).toHaveLength(GLASS_TILES);
        expect(mask.match(/<g style="transform:translate\(\dpx, \dpx\)">/g)).toHaveLength(GLASS_TILES);
      }
      // Each layer paints its two crossing gradients, the light, the sheen,
      // and the glint waiting outside the square.
      const layers = [...markup.matchAll(/<g mask="url\(#([^)]+)\)">([\s\S]*?)<\/g>/g)];
      expect(layers).toHaveLength(2);
      for (const [, , body] of layers) {
        expect(body.match(/<rect[^>]*fill:url\(#/g)).toHaveLength(5);
        expect(body).toContain("transform:translateX(-4px)");
      }
      expect(markup).toMatch(/stop-color:color-mix\(in oklab, #[0-9A-F]{6} 30%, light-dark\(/);
    }
  });

  it("wears a faint glow in the square's own units, and never shares ids between loaders", () => {
    const markup = render({ size: 16, variant: "glass" });
    const glow = /class="zeros-glass" filter="url\(#([^)]+)\)"/.exec(markup)?.[1];
    expect(glow).toBeTruthy();
    expect(markup).toMatch(new RegExp(`<filter id="${glow}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse"`));
    const twice = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(ZerosSpinner, { variant: "glass" }),
        createElement(ZerosSpinner, { variant: "glass" }),
      ),
    );
    const ids = [...twice.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves the other loaders plain", () => {
    for (const variant of ["agent", "orbit"] as const) {
      expect(render({ size: 16, variant })).not.toMatch(/<mask|<filter|zeros-glass/);
    }
  });
});

describe("where the glass square shows", () => {
  it("in the turn rail and running tool and subagent rows", () => {
    expect(source("apps/desktop/src/renderer/shared/ui/loading/activity-shimmer.tsx")).toMatch(
      /<ZerosSpinner[^>]*variant="glass"/s,
    );
    expect(source("apps/desktop/src/renderer/shared/ui/primitives/elements/tool.tsx")).toMatch(
      /<ZerosSpinner size=\{12\} variant="glass" label="Running" \/>/,
    );
    expect(source("apps/desktop/src/renderer/features/agent/renderers/tool-subagent.tsx")).toMatch(
      /<ZerosSpinner\s+size=\{14\}\s+variant="glass"/,
    );
  });

  it("and nowhere else: chat tabs, workspace rows and transcript pills keep their colours", () => {
    for (const path of [
      "apps/desktop/src/renderer/shell/conversation/chat-tabs.tsx",
      "apps/desktop/src/renderer/features/agent/agent-activity-indicator.tsx",
      "apps/desktop/src/renderer/features/agent/chat-transcript-pills.tsx",
      "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx",
    ]) {
      expect(source(path), path).not.toMatch(/variant="glass"|\bglass\b/);
    }
  });
});
