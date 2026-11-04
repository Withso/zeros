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

describe("RadioGroup states", () => {
  it("shares Checkbox's box and keeps the focus border over the checked fill", () => {
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
    expect(markup).toContain("group-data-[state=checked]:bg-inverted-bg");
    expect(markup).toContain("bg-inverted-fg");
    // The standard halo, and a compound rule so the checked border cannot win.
    expect(markup).toContain("group-focus-visible:ring-[3px]");
    expect(markup).toContain("group-data-[state=checked]:group-focus-visible:border-highlighted-bright");
    expect(markup).not.toContain("outline-offset-2");
    expect(markup).toContain("text-xs leading-4.5");
  });
});
