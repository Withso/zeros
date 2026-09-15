import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMenuAnchor, isMenuAnchorAvailable } from "../../menu-anchor";

class Rect {
  constructor(
    public x = 0,
    public y = 0,
    public width = 0,
    public height = 0,
  ) {}
  get left() {
    return this.x;
  }
  get top() {
    return this.y;
  }
}

function source(initial = new Rect(100, 200, 300, 24)) {
  let rect = initial;
  const element = {
    getBoundingClientRect: () => rect,
    isConnected: true,
    checkVisibility: () => true,
    closest: () => null,
    getRootNode: () => ({}),
  };
  return {
    element: element as unknown as HTMLElement,
    move: (next: Rect) => {
      rect = next;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("DOMRect", Rect);
  vi.stubGlobal("ShadowRoot", class {});
});
afterEach(() => vi.unstubAllGlobals());

describe("live menu anchors", () => {
  it("keeps the clicked offset while its owning row moves and scrolls", () => {
    const row = source();
    const anchor = createMenuAnchor(row.element, { x: 170, y: 212 });
    expect(anchor.contextElement).toBe(row.element);
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 170, y: 212 });
    row.move(new Rect(250, 150, 300, 24));
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 320, y: 162 });
  });

  it("clamps the click inside a narrowed row and restores it when space returns", () => {
    const row = source();
    const anchor = createMenuAnchor(row.element, { x: 370, y: 212 });
    row.move(new Rect(100, 200, 120, 24));
    expect(anchor.getBoundingClientRect().x).toBe(220);
    row.move(new Rect(100, 200, 300, 24));
    expect(anchor.getBoundingClientRect().x).toBe(370);
  });

  it("tracks the live bottom edge for keyboard and below-trigger placement", () => {
    const row = source();
    const anchor = createMenuAnchor(row.element);
    row.move(new Rect(15, 30, 250, 48));
    expect(anchor.getBoundingClientRect()).toMatchObject({ x: 15, y: 78 });
  });

  it("tracks the same canvas point through zoom and fractional translations", () => {
    const row = source(new Rect(10.5, 20.25, 200, 100));
    const anchor = createMenuAnchor(
      row.element,
      { x: 60.5, y: 45.25 },
      { scaleWithElement: true },
    );
    row.move(new Rect(30.25, 50.5, 400, 200));
    expect(anchor.getBoundingClientRect()).toMatchObject({
      x: 130.25,
      y: 100.5,
    });
  });

  it("keeps separate owners and successive click locations isolated", () => {
    const first = source();
    const second = source();
    const a = createMenuAnchor(first.element, { x: 120, y: 205 });
    const b = createMenuAnchor(second.element, { x: 300, y: 219 });
    const reopened = createMenuAnchor(first.element, { x: 160, y: 210 });
    second.move(new Rect(400, 400, 300, 24));
    expect(a.getBoundingClientRect()).toMatchObject({ x: 120, y: 205 });
    expect(b.getBoundingClientRect()).toMatchObject({ x: 600, y: 419 });
    expect(reopened.getBoundingClientRect()).toMatchObject({ x: 160, y: 210 });
  });

  it("rejects detached, hidden and inert owners, including shadow hosts", () => {
    const row = source().element;
    expect(isMenuAnchorAvailable(row)).toBe(true);
    Object.assign(row, { isConnected: false });
    expect(isMenuAnchorAvailable(row)).toBe(false);
    Object.assign(row, { isConnected: true, checkVisibility: () => false });
    expect(isMenuAnchorAvailable(row)).toBe(false);
    const shadow = new ShadowRoot();
    Object.assign(shadow, { host: { closest: () => ({ inert: true }) } });
    Object.assign(row, {
      checkVisibility: () => true,
      getRootNode: () => shadow,
    });
    expect(isMenuAnchorAvailable(row)).toBe(false);
  });
});
