import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RadioGroup, RadioGroupItem } from "../radio-group";

const source = (file: string) =>
  readFileSync(`apps/desktop/src/renderer/shared/ui/primitives/${file}`, "utf8");

// Hovered or selected rows step text up one tier, so
// metadata (text-fg3) inside a highlighted menu row reads at fg3 — the
// contrast contract only clears fg3 on REST surfaces, not on bg3-hover.
describe("selected menu rows step metadata up a tier", () => {
  it.each([
    ["command.tsx", "data-[selected=true]:[&_.text-fg3]:text-fg3"],
    ["dropdown-menu.tsx", "focus:[&_.text-fg3]:text-fg3"],
    ["context-menu.tsx", "focus:[&_.text-fg3]:text-fg3"],
    ["select.tsx", "focus:[&_.text-fg3]:text-fg3"],
  ])("%s", (file, tierUp) => {
    expect(source(file)).toContain(tierUp);
  });
});

describe("RadioGroup states", () => {
  it("shares Checkbox's box and accent fill, and keeps the focus line outside the checked fill", () => {
    const markup = renderToStaticMarkup(
      createElement(
        RadioGroup,
        { defaultValue: "a", "aria-label": "Method" },
        createElement(RadioGroupItem, { value: "a", label: "A" }),
      ),
    );
    expect(markup).toContain("size-4");
    expect(markup).toContain("border-border4");
    expect(markup).toContain("group-hover:border-fg3");
    expect(markup).toContain("group-data-[state=checked]:bg-accent");
    expect(markup).toContain("bg-accent-fg");
    // One accent line a pixel off the circle, so it shows around the accent fill.
    expect(markup).toContain("group-focus-visible:outline-1");
    expect(markup).toContain("group-focus-visible:outline-offset-1");
    expect(markup).toContain("group-focus-visible:outline-accent");
    expect(markup).not.toContain("group-focus-visible:ring-[3px]");
    expect(markup).not.toContain("outline-offset-2");
    expect(markup).toContain("text-xs leading-4.5");
  });
});
