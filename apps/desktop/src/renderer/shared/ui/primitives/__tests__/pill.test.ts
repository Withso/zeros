import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge } from "../badge";
import { Pill } from "../pill";

function classes(markup: string) {
  return new Set(markup.match(/class="([^"]*)"/)![1]!.replaceAll("&amp;", "&").split(/\s+/));
}

describe("Pill", () => {
  it("is a native button with visible keyboard focus", () => {
    const markup = renderToStaticMarkup(createElement(Pill, { "aria-label": "App resources" }, "1.24 GB"));
    expect(markup).toContain("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("focus-visible:ring-[3px]");
    expect(markup).toContain("1.24 GB");
  });

  it("comes in two sizes: 20px inline and 24px control", () => {
    const inline = classes(renderToStaticMarkup(createElement(Pill, null, "a.ts")));
    for (const cls of ["h-5", "rounded-sm", "text-3xxs", "leading-4"]) expect(inline, cls).toContain(cls);
    const control = classes(renderToStaticMarkup(createElement(Pill, { size: "control" }, "a.ts")));
    for (const cls of ["h-6", "rounded-md", "text-xs", "leading-4.5"]) expect(control, cls).toContain(cls);
  });

  it("has one neutral look, tints only where they mean something", () => {
    const neutral = classes(renderToStaticMarkup(createElement(Pill, null, "a.ts")));
    for (const cls of ["border-border2", "bg-bg2", "hover:border-border3", "hover:bg-bg2-highlight", "aria-pressed:border-border4"]) {
      expect(neutral, cls).toContain(cls);
    }
    expect(classes(renderToStaticMarkup(createElement(Pill, { tone: "failed" }, "x")))).toContain("bg-red-bg");
    expect(classes(renderToStaticMarkup(createElement(Pill, { tone: "mode" }, "x")))).toContain("bg-brown-bg");
    expect(classes(renderToStaticMarkup(createElement(Pill, { tone: "gone" }, "x")))).toContain("border-dashed");
  });
});

describe("Badge", () => {
  it("is one 20px size with 12px medium text and no stock shadow", () => {
    const set = classes(renderToStaticMarkup(createElement(Badge, null, "Admin")));
    for (const cls of ["h-5", "px-1.5", "rounded-sm", "text-3xxs", "font-medium", "bg-bg2", "text-fg2"]) {
      expect(set, cls).toContain(cls);
    }
    expect([...set].some((cls) => /^shadow(-|$)/.test(cls))).toBe(false);
  });

  it("draws status as a tinted pair, Info in blue", () => {
    expect(classes(renderToStaticMarkup(createElement(Badge, { variant: "success" }, "Passed")))).toContain("text-green-fg");
    expect(classes(renderToStaticMarkup(createElement(Badge, { variant: "info" }, "Draft")))).toContain("bg-blue-bg");
  });
});
