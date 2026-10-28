import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureDeferredFocus } from "../../deferred-focus";

const input = vi.hoisted(() => ({ version: 0 }));
vi.mock("../../focus-navigation", () => ({ getFocusInteractionVersion: () => input.version }));

function fixture() {
  const origin = { isConnected: true, getAttribute: () => "false" };
  const body = { isConnected: true, getAttribute: () => null };
  const doc = {
    activeElement: origin as object,
    body,
    visibilityState: "visible",
    hasFocus: () => true,
    getSelection: () => ({ isCollapsed: true }),
    querySelectorAll: () => [] as { contains: (target: unknown) => boolean }[],
  };
  const target = {
    ownerDocument: doc,
    isConnected: true,
    closest: () => null as object | null,
    getClientRects: () => [{}],
    contains: (element: unknown) => element === target,
  };
  return { doc, origin, target, capture: () => captureDeferredFocus(target as unknown as HTMLElement) };
}

beforeEach(() => { input.version = 0; });

describe("deferred focus intent", () => {
  it("permits an unchanged visible destination", () => {
    expect(fixture().capture()()).toBe(true);
  });

  it("lets a selected menu hand off after its focused origin unmounts", () => {
    const { origin, doc, capture } = fixture();
    const mayFocus = capture();
    origin.isConnected = false;
    doc.activeElement = doc.body;
    expect(mayFocus()).toBe(true);
    input.version++;
    expect(mayFocus()).toBe(false);
  });

  it("allows a saving control in the same scope to release focus to body", () => {
    const { origin, doc, target, capture } = fixture();
    target.contains = (element) => element === origin || element === target;
    const mayFocus = capture();
    // Disabling a saving input blurs it; reenabling it does not restore focus.
    doc.activeElement = doc.body;
    expect(mayFocus()).toBe(true);
    input.version++;
    expect(mayFocus()).toBe(false);
  });

  it("does not reclaim a still-mounted origin outside the destination scope", () => {
    const { doc, capture } = fixture();
    const mayFocus = capture();
    doc.activeElement = doc.body;
    expect(mayFocus()).toBe(false);
  });

  it("preserves newer focus, including a user round trip to the same origin", () => {
    const { doc, origin, capture } = fixture();
    const mayFocus = capture();
    doc.activeElement = {};
    expect(mayFocus()).toBe(false);
    input.version++;
    doc.activeElement = origin;
    expect(mayFocus()).toBe(false);
  });

  it("retires the request after newer typing or a click on nonfocusable space", () => {
    const mayFocus = fixture().capture();
    input.version++;
    expect(mayFocus()).toBe(false);
  });

  it("does not pull focus away from an existing keyboard destination", () => {
    const { origin, capture } = fixture();
    origin.getAttribute = () => "true";
    expect(capture()()).toBe(false);
  });

  it.each(["disconnected", "inert", "unlaid-out", "background", "hidden-document"])(
    "refuses a %s target at completion", (condition) => {
      const { doc, target, capture } = fixture();
      const mayFocus = capture();
      if (condition === "disconnected") target.isConnected = false;
      if (condition === "inert") target.closest = () => ({});
      if (condition === "unlaid-out") target.getClientRects = () => [];
      if (condition === "background") doc.hasFocus = () => false;
      if (condition === "hidden-document") doc.visibilityState = "hidden";
      expect(mayFocus()).toBe(false);
    },
  );

  it("respects a new overlay before its autofocus runs, but permits its own content", () => {
    const { doc, target, capture } = fixture();
    const mayFocus = capture();
    doc.querySelectorAll = () => [{ contains: () => false }];
    expect(mayFocus()).toBe(false);
    doc.querySelectorAll = () => [{ contains: (element) => element === target }];
    expect(mayFocus()).toBe(true);
  });

  it("preserves selected reading content", () => {
    const { doc, capture } = fixture();
    const mayFocus = capture();
    doc.getSelection = () => ({ isCollapsed: false });
    expect(mayFocus()).toBe(false);
  });
});
