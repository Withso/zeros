import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PUZZLE_CELLS } from "../../../shared/ui/loading/puzzle-motion";
import { puzzleRowFills } from "../../../shared/ui/loading/puzzle-square";
import { ZerosSpinner } from "../../../shared/ui/loading/zeros-spinner";
import { AgentActivityIndicator } from "../agent-activity-indicator";
import { agentTones } from "../agent-brands";

const TABS = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/shell/conversation/chat-tabs.tsx"),
  "utf8",
);

/** Each tile's row and fill, read from markup. */
function tiles(markup: string) {
  return [...markup.matchAll(/<rect[^>]*style="([^"]*)"/g)].map((m) => ({
    row: Number(/translate\(\d+px, (\d+)px\)/.exec(m[1])?.[1]),
    fill: /(?:^|;)fill:([^;]+)/.exec(m[1])?.[1] ?? null,
  }));
}

describe("agent tones", () => {
  it("give Claude, Codex and Cursor three tones of their own logo", () => {
    expect(agentTones("claude")).toHaveLength(3);
    expect(agentTones("claude")?.[1]).toBe("#D97757"); // check:ui ignore-line (brand colour under test)
    // Codex's mark gradient and Cursor's cube both shift per theme.
    for (const tone of [...agentTones("codex")!, ...agentTones("cursor")!]) {
      expect(tone).toMatch(/^light-dark\(/);
    }
    expect(agentTones("codex")!.join(" ")).toMatch(/#B1A7FF[\s\S]*#7A9DFF[\s\S]*#3941FF|#7A9DFF[\s\S]*#B1A7FF/); // check:ui ignore-line (brand colour under test)
    expect(agentTones("opencode")).toBeNull();
    expect(agentTones(null)).toBeNull();
  });

  it("light the square from the top: the top row lightest, the bottom deepest", () => {
    const [a, , c] = agentTones("codex")!;
    const rows = puzzleRowFills(agentTones("codex")!);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe(a);
    expect(rows[3]).toBe(c);
    expect(rows[1]).toMatch(/^color-mix\(in oklab, /);
    expect(rows[2]).toMatch(/^color-mix\(in oklab, /);
  });

  it("paint each tile of a toned loader by the row it sits in", () => {
    const tones = agentTones("claude")!;
    const rows = puzzleRowFills(tones);
    const markup = renderToStaticMarkup(createElement(ZerosSpinner, { size: 16, variant: "agent", tones }));
    const painted = tiles(markup);
    expect(painted).toHaveLength(PUZZLE_CELLS - 6);
    for (const tile of painted) expect(tile.fill).toBe(rows[tile.row]);
    expect(markup).toMatch(/transition:transform [^;"]*, fill 240ms/);
  });

  it("leaves every other loader in its single colour", () => {
    const plain = renderToStaticMarkup(createElement(ZerosSpinner, { size: 16, variant: "agent" }));
    for (const tile of tiles(plain)) expect(tile.fill).toBeNull();
    // Without an agent the indicator stays neutral too.
    const neutral = renderToStaticMarkup(createElement(AgentActivityIndicator, { activity: "running" }));
    for (const tile of tiles(neutral)) expect(tile.fill).toBeNull();
  });

  it("tone a running chat tab's loader by its agent, and only there", () => {
    const toned = renderToStaticMarkup(
      createElement(AgentActivityIndicator, { activity: "running", agentId: "codex" }),
    );
    expect(tiles(toned).every((tile) => tile.fill?.includes("light-dark("))).toBe(true);
    // Waiting keeps the neutral Orbit.
    const waiting = renderToStaticMarkup(
      createElement(AgentActivityIndicator, { activity: "waiting", agentId: "codex" }),
    );
    expect(waiting).toContain('data-zeros-loader="orbit"');
    expect(waiting).not.toContain("light-dark(");
    expect(TABS).toMatch(/<AgentActivityIndicator\s+activity=\{activity\}\s+agentId=\{chat\.agentId\}/);
  });
});
