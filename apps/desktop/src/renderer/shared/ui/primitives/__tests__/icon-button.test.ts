import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import { IconButton, type IconButtonProps } from "../icon-button";

function classes(markup: string) {
  const attribute = markup.match(/class="([^"]*)"/)![1]!.replaceAll("&amp;", "&");
  return new Set(attribute.split(/\s+/));
}

function render(props: Omit<IconButtonProps, "label">) {
  return renderToStaticMarkup(
    createElement(IconButton, { ...props, label: "Action" }, "icon"),
  );
}

describe("IconButton sizes", () => {
  it.each([
    ["inline", "size-5", "rounded-sm", "[&_svg]:size-3"],
    ["compact", "size-6", "rounded-md", "[&_svg]:size-3"],
    ["standard", "size-7", "rounded-md", "[&_svg]:size-3.5"],
  ] as const)("draws %s at %s with its own glyph size", (size, box, radius, glyph) => {
    const set = classes(render({ size }));
    for (const cls of [box, radius, glyph]) expect(set, cls).toContain(cls);
  });

  it("defaults to the inline 20px action", () => {
    expect(classes(render({}))).toContain("size-5");
  });
});

describe("IconButton states", () => {
  it("uses one hover on every surface and every size", () => {
    for (const size of ["inline", "compact", "standard"] as const) {
      const set = classes(render({ size }));
      expect(set, size).toContain("hover:bg-bg2-highlight");
      expect(set, size).toContain("hover:text-fg1");
      expect([...set].some((cls) => cls.startsWith("hover:bg-bg2-hover")), size).toBe(false);
    }
  });

  it("shows the keyboard ring at every size, including inline", () => {
    for (const size of ["inline", "compact", "standard"] as const) {
      const set = classes(render({ size }));
      expect(set, size).toContain("focus-visible:border-highlighted-bright");
      expect(set, size).toContain("focus-visible:ring-[3px]");
    }
  });

  it("presses as a neutral toggle unless it is a toolbar's active tool", () => {
    const toggle = classes(render({}));
    expect(toggle).toContain("aria-pressed:bg-bg2-highlight");
    expect(toggle).toContain("aria-pressed:border-border4");
    const tool = classes(render({ pressedTone: "tool" }));
    expect(tool).toContain("aria-pressed:bg-(--design-selection-label-bg)");
    expect(tool).toContain("aria-pressed:text-(--design-selection-label-fg)");
  });

  it("fills an open side column's toggle without an edge", () => {
    const fill = classes(render({ pressedTone: "fill" }));
    expect(fill).toContain("aria-pressed:bg-bg2-highlight");
    expect([...fill].some((cls) => cls.startsWith("aria-pressed:border"))).toBe(false);
  });

  it("holds the hover look while its menu is open", () => {
    expect(classes(render({}))).toContain("data-[state=open]:bg-bg2-highlight");
  });

  it("dims aria-disabled without dropping hover", () => {
    const set = classes(render({}));
    expect(set).toContain("aria-disabled:opacity-50");
    expect(set).toContain("aria-disabled:cursor-not-allowed");
  });
});

describe("IconButton semantics", () => {
  it("is a button with its accessible name and a default type", () => {
    const markup = render({});
    expect(markup).toMatch(/^<button\b/);
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Action"');
  });

  it("preserves a link's native semantics and attributes", () => {
    const markup = renderToStaticMarkup(
      createElement(
        IconButton,
        { asChild: true, label: "Open logs", className: "flex shrink-0" },
        createElement("a", { href: "/logs", target: "_blank", rel: "noreferrer" }, "icon"),
      ),
    );
    expect(markup).toMatch(/^<a\b/);
    expect(markup).toContain('href="/logs"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('aria-label="Open logs"');
    expect(markup).not.toContain('type="button"');
  });

  it("forwards caller state, focus hooks, and explicit button type", () => {
    const markup = renderToStaticMarkup(
      createElement(IconButton, {
        label: "Save",
        type: "submit",
        disabled: true,
        "aria-expanded": true,
        "aria-controls": "actions",
        "data-state": "open",
        tabIndex: -1,
      } as IconButtonProps),
    );
    for (const attribute of [
      'type="submit"',
      'disabled=""',
      'aria-expanded="true"',
      'aria-controls="actions"',
      'data-state="open"',
      'tabindex="-1"',
    ])
      expect(markup).toContain(attribute);
    expectTypeOf<IconButtonProps>()
      .toHaveProperty("label")
      .toEqualTypeOf<string>();
  });
});
