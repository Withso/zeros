import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RadioGroup, RadioGroupItem } from "../radio-group";

const source = (file: string) =>
  readFileSync(`apps/desktop/src/renderer/shared/ui/primitives/${file}`, "utf8");

// docs/design-system.md: hovered or selected rows step text up one tier, so
// metadata (text-muted-fg) inside a highlighted menu row reads at fg3 — the
// contrast contract only clears muted-fg on REST surfaces, not on bg3-hover.
describe("selected menu rows step metadata up a tier", () => {
  it.each([
    ["command.tsx", "data-[selected=true]:[&_.text-muted-fg]:text-fg3"],
    ["dropdown-menu.tsx", "focus:[&_.text-muted-fg]:text-fg3"],
    ["context-menu.tsx", "focus:[&_.text-muted-fg]:text-fg3"],
    ["select.tsx", "focus:[&_.text-muted-fg]:text-fg3"],
  ])("%s", (file, tierUp) => {
    expect(source(file)).toContain(tierUp);
  });
});

describe("RadioGroup focus", () => {
  it("draws an opaque focus outline that a checked border cannot override", () => {
    const markup = renderToStaticMarkup(
      createElement(
        RadioGroup,
        { defaultValue: "a", "aria-label": "Method" },
        createElement(RadioGroupItem, { value: "a", label: "A" }),
      ),
    );
    expect(markup).toContain("border-border-control");
    expect(markup).toContain("group-focus-visible:outline-highlighted-bright");
    // The focus cue is an outline, not a border swap the checked state wins.
    expect(markup).not.toContain("group-focus-visible:border-highlighted-bright");
  });
});
