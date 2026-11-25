import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerTray } from "../composer-tray";

const card = createElement("div", { "data-card": "" }, "composer");

describe("composer tray", () => {
  it("renders the composer alone when there is nothing to say", () => {
    expect(renderToStaticMarkup(createElement(ComposerTray, { message: null }, card))).toBe(
      '<div class="relative"><div data-card="">composer</div></div>',
    );
  });

  it("puts one message row under the composer, inside the tray", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerTray, { message: "Connect GitHub to create cloud workspaces." }, card),
    );
    expect(html.indexOf("data-card")).toBeLessThan(html.indexOf("Connect GitHub"));
    expect(html).toContain("data-composer-tray");
    expect(html).toContain('role="status"');
    expect(html).toContain("bg-bg1-raised");
    // The tray paints outside the composer's box, so a centered page does not shift.
    expect(html).toMatch(/class="[^"]*absolute[^"]*top-full[^"]*"[^>]*role="status"/);
    expect(html).toMatch(/aria-hidden="true" class="[^"]*absolute -inset-x-1 -top-1 -bottom-10/);
    expect(html).not.toContain("<button");
  });

  it("offers at most one action", () => {
    const onClick = vi.fn();
    const html = renderToStaticMarkup(
      createElement(
        ComposerTray,
        { message: "Build the Cloud Computer first.", action: { label: "Open Cloud Computer settings", onClick } },
        card,
      ),
    );
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Open Cloud Computer settings");
  });
});
