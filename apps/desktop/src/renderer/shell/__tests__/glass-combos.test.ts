import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GLASS_FADE, glassComboLayer } from "../../shared/ui/loading/glass-combos";
import { GLASS_DEFAULT_MOTION, GLASS_MOTIONS, GLASS_TILES } from "../../shared/ui/loading/glass-motion";
import { ZerosSpinner } from "../../shared/ui/loading/zeros-spinner";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

// 2026-11-25: the glass square paints one fg1 → fg3 fade in the app's own
// greys; the fourteen colour combos are gone.
describe("the glass fade", () => {
  it("runs fg1 at the top of the square to fg3 at the bottom, with no literal colour", () => {
    expect(GLASS_FADE).toEqual([[0, "var(--fg1)"], [1, "var(--fg3)"]]);
    expect(source("apps/desktop/src/renderer/shared/ui/loading/glass-combos.ts")).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
  });

  it("counts layer generations up for the motion model", () => {
    expect(glassComboLayer(null)).toEqual({ combo: 1 });
    expect(glassComboLayer(4)).toEqual({ combo: 5 });
  });
});

describe("ZerosSpinner variant=glass", () => {
  const render = (props: Parameters<typeof ZerosSpinner>[0]) =>
    renderToStaticMarkup(createElement(ZerosSpinner, props));

  it("runs the one pinned motion unless a caller names another", () => {
    expect(GLASS_DEFAULT_MOTION).toBe("weave");
    for (let i = 0; i < 20; i++) {
      expect(render({ size: 16, variant: "glass" })).toContain('data-glass-motion="weave"');
    }
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
      // Each layer paints the one fade through its mask.
      const layers = [...markup.matchAll(/<rect mask="url\(#([^)]+)\)"[^>]*style="fill:url\(#([^)]+)\)"/g)];
      expect(layers).toHaveLength(2);
      expect(new Set(layers.map((layer) => layer[2])).size).toBe(1);
      expect(markup).toContain("stop-color:var(--fg1)");
      expect(markup).toContain("stop-color:var(--fg3)");
    }
  });

  it("wears no glow, and never shares ids between loaders", () => {
    const markup = render({ size: 16, variant: "glass" });
    expect(markup).not.toContain("<filter");
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
    for (const variant of ["agent", "stream"] as const) {
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
