import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { cn } from "../../cn";
import { Button, buttonVariants } from "../button";

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

describe("Button states", () => {
  it("draws Primary and Destructive flat, without a stock shadow", () => {
    for (const variant of ["primary", "default", "destructive"] as const) {
      const classes = classesFor({ variant });
      expect(classes.some((cls) => /^shadow(-|$)/.test(cls)), variant).toBe(false);
    }
  });

  it("names Primary for what it is and keeps the old name as an alias", () => {
    expect(classesFor({ variant: "primary" })).toEqual(classesFor({ variant: "default" }));
    expect(classesFor({ variant: "primary" })).toContain("bg-primary-button-bg");
  });

  it("holds the hover look while a Ghost button's menu is open", () => {
    const ghost = classesFor({ variant: "ghost" });
    expect(ghost).toEqual(
      expect.arrayContaining(["data-[state=open]:bg-bg2-highlight", "data-[state=open]:text-fg1"]),
    );
  });

  it("presses Secondary and Ghost through aria-pressed with fill and border", () => {
    for (const variant of ["secondary", "ghost"] as const) {
      expect(classesFor({ variant }), variant).toEqual(
        expect.arrayContaining(["aria-pressed:border-border4", "aria-pressed:bg-bg2-highlight"]),
      );
    }
  });

  it("dims aria-disabled without dropping hover, so a reason tooltip can show", () => {
    const base = classesFor({});
    expect(base).toEqual(expect.arrayContaining(["aria-disabled:opacity-50", "aria-disabled:cursor-not-allowed"]));
    expect(base.some((cls) => cls.startsWith("aria-disabled:pointer-events"))).toBe(false);
  });

  it("lets a loading spinner take the leading icon's place", () => {
    expect(classesFor({})).toContain("[&>[data-zeros-loader]+svg]:hidden");
  });

  it("disables and reports busy while loading, whatever the caller passed", () => {
    const markup = renderToStaticMarkup(
      createElement(Button, { variant: "primary", loading: true, "aria-busy": false }, "Save"),
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/<button[^>]*><span[^>]*data-zeros-loader="orbit"/);
    expect(markup).toContain("Save</button>");
  });
});
