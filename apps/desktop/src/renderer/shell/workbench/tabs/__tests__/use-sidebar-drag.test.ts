import { describe, expect, it, vi } from "vitest";

import {
  flushPendingSidebarResize,
  sidebarWidthFromPointer,
} from "../use-sidebar-drag";

describe("sidebarWidthFromPointer", () => {
  it("measures a left sidebar from the container's left edge", () => {
    expect(sidebarWidthFromPointer(340, 100, 800, "left")).toBe(240);
  });

  it("measures a right sidebar from the container's right edge", () => {
    expect(sidebarWidthFromPointer(660, 100, 800, "right")).toBe(240);
  });
});

describe("flushPendingSidebarResize", () => {
  it("cancels and applies a frame that is still queued at pointerup", () => {
    const calls: string[] = [];
    const cancel = vi.fn((id: number) => calls.push(`cancel:${id}`));
    const apply = vi.fn(() => calls.push("apply"));

    expect(flushPendingSidebarResize(42, cancel, apply)).toBe(true);
    expect(calls).toEqual(["cancel:42", "apply"]);
  });

  it("does nothing when the latest frame already painted", () => {
    const cancel = vi.fn();
    const apply = vi.fn();

    expect(flushPendingSidebarResize(null, cancel, apply)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
