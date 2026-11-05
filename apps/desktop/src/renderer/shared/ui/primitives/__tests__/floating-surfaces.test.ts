import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MENU_ITEM_BOX,
  MENU_LABEL,
  MENU_SEPARATOR,
  MENU_SURFACE_INSET,
  MENU_SURFACE_RADIUS,
} from "../../menu-surface";
import { DialogBody, DialogFooter, DialogHeader } from "../dialog";
import { Kbd, KbdKeys, shortcutKeys } from "../kbd";

const source = (file: string) =>
  readFileSync(`apps/desktop/src/renderer/shared/ui/${file}`, "utf8");

describe("the floating surface", () => {
  it("is 12px with a 4px inset, so 8px rows sit parallel inside it", () => {
    expect(MENU_SURFACE_RADIUS).toBe("rounded-[calc(var(--radius-lg)*1.5)]");
    expect(MENU_SURFACE_INSET).toBe("p-1");
    expect(MENU_SEPARATOR).toContain("-mx-1");
    expect(MENU_SEPARATOR).toContain("my-1");
  });

  it("draws 28px rows and 12px medium fg3 group labels", () => {
    expect(MENU_ITEM_BOX).toContain("min-h-7");
    expect(MENU_ITEM_BOX).toContain("py-1");
    expect(MENU_LABEL).toContain("text-fg3");
    expect(MENU_LABEL).toContain("text-3xxs");
    expect(MENU_LABEL).toContain("font-medium");
  });

  it.each([
    "primitives/dropdown-menu.tsx",
    "primitives/context-menu.tsx",
    "primitives/command.tsx",
  ])("%s builds its rows and labels from the shared recipe", (file) => {
    const text = source(file);
    expect(text).toContain("MENU_ITEM_BOX");
    expect(text).not.toMatch(/items-center gap-2 px-2 py-1\.5 text-xs/);
  });

  it.each([
    "primitives/hover-card.tsx",
    "primitives/tooltip.tsx",
    "primitives/elements/toast.tsx",
    "primitives/elements/update-toast.tsx",
  ])("%s joins the floating family", (file) => {
    const text = source(file);
    expect(text).toContain("FLOATING_SURFACE");
    expect(text).toContain("border-border2");
    expect(text).toContain("shadow-[var(--shadow-dropdown)]");
    expect(text).not.toContain("backdrop-blur");
  });
});

describe("menu choices", () => {
  const menu = source("primitives/dropdown-menu.tsx");

  it("marks one choice with a check at the row's end", () => {
    const radio = menu.slice(menu.indexOf("const DropdownMenuRadioItem"), menu.indexOf("const DropdownMenuLabel"));
    expect(radio).toContain('"pr-8"');
    expect(radio).toContain("absolute right-2");
    expect(radio).not.toContain("Circle");
  });

  it("keeps a left check column for several choices, with no end box", () => {
    const checkbox = menu.slice(
      menu.indexOf("const DropdownMenuCheckboxItem"),
      menu.indexOf("const DropdownMenuRadioItem"),
    );
    expect(checkbox).toContain('"pl-8"');
    expect(checkbox).toContain("absolute left-2");
    expect(checkbox).not.toContain("indicatorSide");
    expect(checkbox).not.toContain("border-border4");
  });

  it("offers a red destructive row for both menus", () => {
    for (const file of ["primitives/dropdown-menu.tsx", "primitives/context-menu.tsx"]) {
      expect(source(file)).toContain('variant === "destructive" && MENU_ITEM_DESTRUCTIVE');
    }
  });

  it("shows shortcuts as Kbd chips, not faded text", () => {
    expect(menu).toContain("<KbdKeys keys={children}");
    expect(menu).not.toContain("opacity-60");
    expect(source("primitives/command.tsx")).not.toContain("tracking-widest");
  });
});

describe("Kbd", () => {
  it("is an 18px border2 chip on bg2", () => {
    const markup = renderToStaticMarkup(createElement(Kbd, null, "esc"));
    for (const cls of ["h-4.5", "min-w-4.5", "border-border2", "bg-bg2", "text-2xxs", "text-fg2"]) {
      expect(markup).toContain(cls);
    }
    expect(markup).not.toContain("border-border1");
  });

  it("gives each key of a combination its own chip", () => {
    expect(shortcutKeys("⌘⇧T")).toEqual(["⌘", "⇧", "T"]);
    expect(shortcutKeys("⌘\\")).toEqual(["⌘", "\\"]);
    expect(shortcutKeys("F2")).toEqual(["F2"]);
    expect(shortcutKeys("esc")).toEqual(["esc"]);
    const markup = renderToStaticMarkup(createElement(KbdKeys, { keys: "⌥T" }));
    expect(markup.match(/data-slot="kbd"/g)).toHaveLength(2);
  });
});

describe("Tooltip", () => {
  const tooltip = source("primitives/tooltip.tsx");

  it("is a solid 6px chip with 12/16 text and Kbd shortcuts", () => {
    expect(tooltip).toContain("rounded-md");
    expect(tooltip).toContain("text-3xxs leading-4");
    expect(tooltip).toContain("<KbdKeys keys={shortcut} />");
    expect(tooltip).not.toContain("bg-bg2/40");
  });
});

describe("Dialog", () => {
  const dialog = source("primitives/dialog.tsx");

  it("runs one 16px inset through header, body and footer, with no footer rule", () => {
    expect(renderToStaticMarkup(createElement(DialogHeader))).toContain("px-4 pt-4");
    expect(renderToStaticMarkup(createElement(DialogBody))).toContain("p-4");
    const footer = renderToStaticMarkup(createElement(DialogFooter));
    expect(footer).toContain("px-4 pb-4");
    expect(footer).not.toContain("border-t");
  });

  it("offers three widths and the 12px floating corners with a border2 edge", () => {
    expect(dialog).toContain('sm: "max-w-100"');
    expect(dialog).toContain('md: "max-w-130"');
    expect(dialog).toContain('lg: "max-w-160"');
    expect(dialog).toContain("bg-bg1 border-border2");
    expect(dialog).toContain("MENU_SURFACE_RADIUS");
    expect(dialog).not.toContain("sm:rounded-lg");
  });

  it("closes with a 24px IconButton, not a 20px circle", () => {
    expect(dialog).toContain('size="compact"');
    expect(dialog).not.toContain("dialog-close-radius");
  });
});

describe("Toast", () => {
  const toast = source("primitives/elements/toast.tsx");

  it("is 360px with its close inside the top-right corner and info in blue", () => {
    expect(toast).toContain("w-90");
    expect(toast).not.toContain("w-[350px]");
    expect(toast).toContain('info: "text-blue-primary"');
    expect(toast).not.toContain("-left-2 -top-2");
    expect(toast).toContain("<IconButton");
  });
});

describe("Popover", () => {
  const popover = source("primitives/popover.tsx");

  it("has sm 240 · md 320 · lg 400 and 12px padding", () => {
    expect(popover).toContain('sm: "w-60"');
    expect(popover).toContain('md: "w-80"');
    expect(popover).toContain('lg: "w-100"');
    expect(popover).toContain('padding === "default" ? "p-3" : "p-0"');
  });

  // Regression: the @, / and # pickers docked on the composer floated on bg3
  // with a lift while every other card above the composer sat on its surface.
  it("floats on bg3 with the lift, or docks on the composer's own surface", () => {
    expect(popover).toMatch(/floating: "[^"]*shadow-\[var\(--shadow-dropdown\)\]"/);
    expect(popover).toContain('composer: "bg-sidebar-bg"');
    expect(popover).toContain('surface = "floating"');
    const suggestions = source("../../features/agent/composer-editor/suggestion-popup.tsx");
    expect(suggestions).toContain('surface={placement === "composer" ? "composer" : "floating"}');
    expect(suggestions).toContain('<Surface kind={placement === "composer" ? "sidebar" : "floating"}>');
  });
});
