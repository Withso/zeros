import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalCommandsSetting } from "../local-commands-setting";

describe("Always allow local commands", () => {
  it("renders one labelled switch under Advanced, off by default state, and disabled while saving", () => {
    const off = renderToStaticMarkup(createElement(LocalCommandsSetting, { checked: false, onCheckedChange: () => {} }));
    expect(off).toContain("Advanced");
    expect(off).toContain("Always allow local commands");
    expect(off).toContain('aria-checked="false"');
    const saving = renderToStaticMarkup(createElement(LocalCommandsSetting, { checked: true, disabled: true, onCheckedChange: () => {} }));
    expect(saving).toContain('aria-checked="true"');
    expect(saving).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
  });
});
