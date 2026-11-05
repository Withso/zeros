import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SplitButton, splitButtonClasses } from "../split-button";

function render(props: Partial<Parameters<typeof SplitButton>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(SplitButton, {
      onClick: () => {},
      menuLabel: "Choose a simulator",
      menu: null,
      children: "Attach simulator",
      ...props,
    }),
  );
}

function halves(markup: string) {
  return markup.split("<button").slice(1);
}

function classSet(value: string) {
  return new Set(value.split(/\s+/));
}

describe("SplitButton", () => {
  it("renders an action and a labelled menu trigger in one shell", () => {
    const markup = render({ variant: "primary" });
    expect(markup).toContain('data-slot="split-button"');
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain(">Attach simulator</button>");
    expect(markup).toContain('aria-label="Choose a simulator"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("bg-primary-button-bg");
  });

  it("uses the dropdown trigger chrome by default", () => {
    expect(render()).toContain("border-border3");
  });

  it("can keep the menu usable while the action is unavailable", () => {
    const [action, menu] = halves(render({ disabled: true, menuDisabled: false }));
    expect(action).toContain("disabled");
    expect(menu).not.toContain("disabled=");
  });

  it("waits on the menu while the action is busy", () => {
    const [action, menu] = halves(render({ loading: true }));
    expect(action).toContain('aria-busy="true"');
    expect(action).toContain('data-zeros-loader="orbit"');
    expect(menu).toContain("disabled");
  });
});

describe("splitButtonClasses", () => {
  it.each(["primary", "secondary"] as const)(
    "draws %s at Button's 28px box with a medium label",
    (variant) => {
      const { shell, action, chevron } = splitButtonClasses(variant);
      // No clipping shell: each half owns its border, corners and ring.
      expect(shell).not.toContain("overflow-hidden");
      for (const half of [action, chevron]) {
        const set = classSet(half);
        expect(set).toContain("border");
        expect(set).toContain("leading-4.5");
        expect(set).toContain("font-medium");
        expect(set).toContain("focus-visible:ring-[3px]");
        expect(set).toContain("focus-visible:border-highlighted-bright");
        expect([...set].some((cls) => cls.includes("ring-inset"))).toBe(false);
      }
      expect(classSet(action)).toContain("py-1");
      expect(classSet(action)).toContain("rounded-l-md");
      expect(classSet(chevron)).toContain("rounded-r-md");
    },
  );

  it("draws the secondary chevron in muted-fg, not a faded fg2", () => {
    const set = classSet(splitButtonClasses("secondary").chevron);
    expect(set).toContain("text-muted-fg");
    expect(set).toContain("data-[state=open]:text-fg2");
    expect([...set].some((cls) => cls.includes("opacity-50") && !cls.startsWith("disabled:"))).toBe(false);
  });

  it("never paints a focus fill that reads as hover", () => {
    for (const variant of ["primary", "secondary"] as const) {
      const { action, chevron } = splitButtonClasses(variant);
      expect(`${action} ${chevron}`).not.toMatch(/focus-visible:bg-/);
    }
  });

  it("keeps the compact size on the same line box", () => {
    const { action } = splitButtonClasses("secondary", "compact");
    expect(classSet(action)).toContain("py-0.5");
    expect(classSet(action)).toContain("leading-4.5");
  });
});
