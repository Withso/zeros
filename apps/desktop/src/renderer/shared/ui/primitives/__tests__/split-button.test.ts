import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SplitButton } from "../split-button";

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
    const markup = render({ disabled: true, menuDisabled: false });
    const [action, menu] = markup.split("<button").slice(1);
    expect(action).toContain("disabled");
    expect(menu).not.toContain("disabled=");
  });
});
