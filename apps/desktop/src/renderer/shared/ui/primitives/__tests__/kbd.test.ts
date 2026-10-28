import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Kbd } from "../kbd";

describe("shortcut symbol chips", () => {
  it.each(["Esc", "Space", "constructor", "toString"])("preserves ordinary text %s", key => {
    const markup = renderToStaticMarkup(createElement(Kbd, null, key));
    expect(markup).toContain(`>${key}</span>`);
    expect(markup).not.toContain("<svg");
  });

  it.each([
    ["←", "arrow-left"], ["→", "arrow-right"], ["↑", "arrow-up"],
    ["↓", "arrow-down"], ["↖", "arrow-up-left"], ["↘", "arrow-down-right"],
    ["⌘", "command"], ["⌥", "option"], ["⇧", "arrow-big-up"],
    ["⌃", "chevron-up"], ["↵", "corner-down-left"],
  ])("renders %s as an aligned icon with its readable key preserved", (key, icon) => {
    const markup = renderToStaticMarkup(createElement(Kbd, null, `⌥⌘${key}`));
    expect(markup).toContain(`lucide-${icon}`);
    expect(markup).toContain("size-3 shrink-0");
    expect(markup).toContain(`class="sr-only">${key}</span>`);
    expect(markup).toContain("⌥");
    expect(markup).toContain("⌘");
  });
});
