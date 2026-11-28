// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eventInsideOwnDom } from "../sidebar-workspace-row";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let portal: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  portal = document.createElement("div");
  document.body.append(host, portal);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  portal.remove();
});

const click = (target: Element) =>
  act(() => { target.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

describe("a sidebar workspace row's click", () => {
  // The project logo's context menu and its Change icon dialog render in
  // portals, so React bubbles their clicks to the row through the component
  // tree even though the DOM target sits outside it.
  it("ignores clicks from a portalled menu or dialog", () => {
    const onSelect = vi.fn();
    act(() => root.render(createElement(
      "div",
      {
        "data-row": "",
        onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
          if (!eventInsideOwnDom(event)) return;
          onSelect();
        },
      },
      createElement("button", { type: "button", "data-open": "" }, "Open"),
      createPortal(createElement("button", { type: "button", "data-menu-item": "" }, "Repository Settings"), portal),
    )));
    click(portal.querySelector("[data-menu-item]")!);
    expect(onSelect).not.toHaveBeenCalled();
    click(host.querySelector("[data-open]")!);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("is guarded in the row itself", () => {
    const row = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx"),
      "utf8",
    );
    expect(row).toMatch(/onClick=\{\(event\) => \{\s*if \(!eventInsideOwnDom\(event\)\) return;/);
  });

  // Moving over or focusing the logo menu's items reached the row through the
  // portal and scheduled its hover card, which then opened after the menu had
  // closed, over whatever the pointer went to next.
  it("does not schedule the hover card from a portalled menu", () => {
    const row = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx"),
      "utf8",
    );
    for (const handler of ["onPointerEnter", "onFocus"]) {
      expect(row, handler).toMatch(
        new RegExp(`${handler}=\\{\\(event\\) => \\{\\s*if \\(!surfaceActive \\|\\| !eventInsideOwnDom\\(event\\)\\) return;`),
      );
    }
  });
});
