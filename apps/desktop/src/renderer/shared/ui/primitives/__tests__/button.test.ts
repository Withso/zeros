import { describe, expect, it } from "vitest";

import { cn } from "../../cn";
import { buttonVariants } from "../button";

// Same merge the Button component applies to its recipe.
const classesFor = (props: Parameters<typeof buttonVariants>[0]) =>
  cn(buttonVariants(props)).split(/\s+/);

describe("Button control sizes", () => {
  it("keeps sm / default / lg as one standard 28px control", () => {
    const standard = classesFor({ size: "default" });
    expect(classesFor({ size: "sm" })).toEqual(standard);
    expect(classesFor({ size: "lg" })).toEqual(standard);
    // 13px text on an 18px line + 4px vertical padding + 1px border = 28px.
    expect(standard).toEqual(expect.arrayContaining(["text-xs", "leading-4.5", "py-1"]));
  });

  it("offers a real 24px compact control on the same line box", () => {
    const compact = classesFor({ size: "compact" });
    expect(compact).toEqual(expect.arrayContaining(["py-0.5", "leading-4.5"]));
    expect(compact).not.toContain("py-1");
    // Unsized icons in a compact TEXT button drop to 12px too.
    expect(compact).toContain("[&_:where(svg:not([class*='size-']))]:size-3");
    expect(compact).not.toContain("[&_:where(svg:not([class*='size-']))]:size-3.5");
  });

  it("pairs each icon square with its glyph size", () => {
    const standardIcon = classesFor({ size: "icon" });
    expect(standardIcon).toEqual(expect.arrayContaining(["size-7", "p-0"]));
    expect(standardIcon).toContain("[&_:where(svg:not([class*='size-']))]:size-3.5");

    const compactIcon = classesFor({ size: "icon-compact" });
    expect(compactIcon).toEqual(expect.arrayContaining(["size-6", "p-0"]));
    expect(compactIcon).toContain("[&_:where(svg:not([class*='size-']))]:size-3");
    expect(compactIcon).not.toContain("[&_:where(svg:not([class*='size-']))]:size-3.5");
  });

  it("hovers destructive fills with a solid token, never an alpha wash", () => {
    const destructive = classesFor({ variant: "destructive" }).join(" ");
    expect(destructive).toContain("hover:bg-red-secondary-hover");
    expect(destructive).not.toMatch(/bg-red-secondary\/\d+/);
  });
});
