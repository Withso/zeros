import { describe, expect, it } from "vitest";

import {
  POPOVER_BOUNDARY_ATTR,
  popoverBoundaryProps,
  resolvePopoverBoundary,
} from "../../popover-boundary";

interface FakeElement {
  attrs: Record<string, string>;
  parent: FakeElement | null;
  closest(selector: string): FakeElement | null;
}

/** Minimal Element stand-in: `closest` walks a parent chain and matches the
 *  boundary attribute selector the resolver builds. */
function node(attrs: Record<string, string>, parent: FakeElement | null) {
  const el: FakeElement = {
    attrs,
    parent,
    closest(selector: string) {
      const attr = selector.slice(1, -1);
      let cur: FakeElement | null = el;
      while (cur) {
        if (attr in cur.attrs) return cur;
        cur = cur.parent;
      }
      return null;
    },
  };
  return el;
}
const asElement = (el: FakeElement | null) => el as unknown as Element;

describe("popover boundary", () => {
  it("stamps the attribute the resolver looks for", () => {
    expect(Object.keys(popoverBoundaryProps)).toEqual([POPOVER_BOUNDARY_ATTR]);
  });

  it("resolves the NEAREST stamped column, not an outer one", () => {
    const outer = node(popoverBoundaryProps, null);
    const inner = node(popoverBoundaryProps, outer);
    const trigger = node({}, node({}, inner));
    expect(resolvePopoverBoundary(asElement(trigger))).toBe(inner);
  });

  it("falls back to the viewport (null) when nothing above is stamped", () => {
    const trigger = node({}, node({}, null));
    expect(resolvePopoverBoundary(asElement(trigger))).toBeNull();
    expect(resolvePopoverBoundary(null)).toBeNull();
    expect(resolvePopoverBoundary(undefined)).toBeNull();
  });
});
