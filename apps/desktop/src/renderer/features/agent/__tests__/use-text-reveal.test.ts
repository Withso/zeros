// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTextReveal } from "../renderers/use-text-reveal";

// jsdom has no layout: give the message a height and lines a place.
const HEIGHT = 120;
let host: HTMLElement;
let root: Root;

function Probe({ html, source, live = true, phase }: { html: string; source: string; live?: boolean; phase?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useTextReveal(ref, { source, live, turnLive: live, active: true, createdAt: Date.now(), phase });
  return createElement("div", { ref, className: "zeros-agent-md", dangerouslySetInnerHTML: { __html: html } });
}

const render = (props: Parameters<typeof Probe>[0]) => act(() => root.render(createElement(Probe, props)));
const prose = () => host.querySelector<HTMLElement>(".zeros-agent-md")!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(HEIGHT);
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useTextReveal", () => {
  it("shows an authoritative correction of a held draft at once", () => {
    render({ html: "<p>A one-line draft</p>", source: "A one-line draft" });
    expect(prose().dataset.revealHeld).toBe("");
    render({ html: "<p>A different answer</p>", source: "A different answer" });
    expect(prose().dataset.revealHeld).toBeUndefined();
  });

  it("keeps unreleased units out of reach of assistive technology and the keyboard", () => {
    // Paragraphs at 0-20 and 30-50px; the first is complete, the second still
    // growing, so only the first is released.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const bottom = Number(this.getAttribute("data-bottom") ?? HEIGHT);
      return new DOMRect(0, this.hasAttribute("data-bottom") ? bottom - 20 : 0, 100, this.hasAttribute("data-bottom") ? 20 : HEIGHT);
    });
    render({ html: "<p data-bottom=\"20\">First paragraph.</p><p data-bottom=\"50\">Second, still <a href=\"#\">growing</a></p>",
      source: "First paragraph.\n\nSecond, still [growing](#) and", phase: "final_answer" });
    const [first, second] = prose().querySelectorAll("p");
    expect(prose().style.maxHeight).toBe("20.0px");
    expect(first.inert).toBeFalsy();
    expect(second.inert).toBe(true);
    expect(second.dataset.revealInert).toBe("");
  });

  it("keeps a released unit whole when an image in it loads and grows it", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const bottom = Number(this.getAttribute("data-bottom") ?? HEIGHT);
      return new DOMRect(0, this.hasAttribute("data-bottom") ? bottom - 20 : 0, 100, this.hasAttribute("data-bottom") ? 20 : HEIGHT);
    });
    render({ html: "<p data-bottom=\"20\"><img src=\"x.png\"> First.</p><p data-bottom=\"50\">Second, still</p>",
      source: "![x](x.png) First.\n\nSecond, still", phase: "final_answer" });
    expect(prose().style.maxHeight).toBe("20.0px");
    const [first, second] = prose().querySelectorAll("p");
    first.setAttribute("data-bottom", "60");
    second.setAttribute("data-bottom", "90");
    act(() => { prose().querySelector("img")!.dispatchEvent(new Event("load")); });
    expect(prose().style.maxHeight).toBe("60.0px");
  });

  it("does not observe or measure a settled message", () => {
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect() {} unobserve() {} });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    render({ html: "<p>Settled answer.</p>", source: "Settled answer.", live: false });
    expect(observe).not.toHaveBeenCalled();
    expect(rect).not.toHaveBeenCalled();
  });
});
