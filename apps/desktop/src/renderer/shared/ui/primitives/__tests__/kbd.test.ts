import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ButtonShortcut, Kbd } from "../kbd";

describe("shortcut symbol chips", () => {
  it.each(["Esc", "Space", "constructor", "toString"])("preserves ordinary text %s", key => {
    const markup = renderToStaticMarkup(createElement(Kbd, null, key));
    expect(markup).toContain(`>${key}</span>`);
    expect(markup).not.toContain("<svg");
  });

  it.each([
    ["←", "arrow-left"], ["→", "arrow-right"], ["↑", "arrow-up"],
    ["↓", "arrow-down"], ["↖", "arrow-up-left"], ["↘", "arrow-down-right"],
    ["⌘", "command"], ["⌥", "option"], ["⇧", "arrow-fat-up"],
    ["⌃", "control"], ["↵", "arrow-elbow-down-left"], ["⌫", "backspace"],
  ])("renders %s as an 11px Phosphor Bold glyph with its readable key preserved", (key) => {
    const markup = renderToStaticMarkup(createElement(Kbd, null, `⌥⌘${key}`));
    expect(markup).toContain(`data-key-glyph="${key}"`);
    expect(markup).toContain('viewBox="0 0 256 256"');
    expect(markup).toContain("size-2.75 shrink-0");
    expect(markup).not.toContain("lucide-");
    expect(markup).toContain(`class="sr-only">${key}</span>`);
    expect(markup).toContain("⌥");
    expect(markup).toContain("⌘");
  });
});

describe("ButtonShortcut", () => {
  it("draws its symbols with the same glyphs as Kbd", () => {
    const markup = renderToStaticMarkup(createElement(ButtonShortcut, { keys: "⌘⇧↵" }));
    for (const key of ["⌘", "⇧", "↵"]) expect(markup).toContain(`data-key-glyph="${key}"`);
    expect(markup).toContain('aria-hidden="true"');
  });
});
