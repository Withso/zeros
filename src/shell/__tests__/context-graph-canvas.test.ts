// Layout contract for the Context canvas: deterministic slots (same input →
// same positions), attachments band above docs, headers only when both bands
// exist, and non-overlapping slot origins despite the aesthetic jitter.

import { describe, expect, it } from "vitest";

import { computeContextGraphLayout } from "../column3-tabs/context-graph-canvas";
import type { ContextGraphItemWire } from "@/native/context-graph";

function item(over: Partial<ContextGraphItemWire>): ContextGraphItemWire {
  return {
    relPath: ".context-graph/local/attachments/att-1/a.png",
    name: "a.png",
    scope: "local",
    category: "attachment",
    kind: "image",
    bytes: 10,
    mtimeMs: 1,
    attachmentId: "att-1",
    ...over,
  };
}

describe("computeContextGraphLayout", () => {
  it("is deterministic for the same input", () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item({ relPath: `p/${i}`, name: `${i}.png` }),
    );
    const a = computeContextGraphLayout(items);
    const b = computeContextGraphLayout(items);
    expect(a.placed.map((p) => [p.x, p.y])).toEqual(
      b.placed.map((p) => [p.x, p.y]),
    );
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
  });

  it("keeps every attachment above every doc and labels both bands", () => {
    const layout = computeContextGraphLayout([
      item({ relPath: "a/1", category: "attachment" }),
      item({
        relPath: "d/1",
        category: "doc",
        attachmentId: undefined,
        kind: "markdown",
      }),
      item({ relPath: "a/2", category: "attachment" }),
    ]);
    const attachmentYs = layout.placed
      .filter((p) => p.item.category === "attachment")
      .map((p) => p.y);
    const docYs = layout.placed
      .filter((p) => p.item.category === "doc")
      .map((p) => p.y);
    expect(Math.max(...attachmentYs)).toBeLessThan(Math.min(...docYs));
    expect(layout.sections.map((s) => s.label)).toEqual([
      "Attachments",
      "Docs",
    ]);
  });

  it("omits band headers when only one category exists", () => {
    const layout = computeContextGraphLayout([
      item({ relPath: "a/1" }),
      item({ relPath: "a/2" }),
    ]);
    expect(layout.sections).toEqual([]);
  });

  it("gives every card a distinct slot with room for the jitter", () => {
    const items = Array.from({ length: 24 }, (_, i) =>
      item({ relPath: `a/${i}`, name: `${i}.png` }),
    );
    const layout = computeContextGraphLayout(items);
    const seen = new Set<string>();
    for (const p of layout.placed) {
      // Cards are 224 wide in ~312×296 slots with ≤±26/±34 jitter, so two
      // distinct slots can never collide; assert slot uniqueness.
      const slot = `${Math.round(p.x / 312)}:${Math.round(p.y / 296)}`;
      expect(seen.has(slot)).toBe(false);
      seen.add(slot);
    }
    // Everything stays inside the reported canvas bounds.
    expect(Math.max(...layout.placed.map((p) => p.x)) + 224).toBeLessThanOrEqual(
      layout.width,
    );
    expect(Math.max(...layout.placed.map((p) => p.y))).toBeLessThan(
      layout.height,
    );
  });

  it("reports a non-degenerate size for an empty graph", () => {
    const layout = computeContextGraphLayout([]);
    expect(layout.placed).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
