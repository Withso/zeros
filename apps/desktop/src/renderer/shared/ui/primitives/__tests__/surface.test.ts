import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Surface, type SurfaceProps } from "../../layout/surface";
import { Button } from "../button";

function classes(markup: string) {
  return new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/));
}

function currentRecipe(file: string, name: string) {
  const source = readFileSync(`apps/desktop/src/renderer/${file}`, "utf8");
  return source.match(new RegExp(`const ${name}\\s*=\\s*"([^"]*)"`))![1]!;
}

// Each contextual class is equivalent only under the sidebar Surface binding.
function sidebarClasses(markup: string) {
  return classes(
    markup.replaceAll("bg-(--surface-hover)", "bg-sidebar-bg-hover"),
  );
}

describe("Surface markup equivalence", () => {
  it("preserves the sidebar nav's tag and painted classes, with context only", () => {
    // shell/app-sidebar.tsx original navigation recipe.
    const original =
      "bg-sidebar-bg flex min-w-0 flex-1 flex-col overflow-hidden";
    const markup = renderToStaticMarkup(
      createElement(
        Surface,
        {
          as: "nav",
          kind: "sidebar",
          className: "flex min-w-0 flex-1 flex-col overflow-hidden",
          "aria-label": "Workspace navigation",
        },
        "rows",
      ),
    );
    expect(markup).toMatch(/^<nav\b/);
    expect(classes(markup)).toEqual(
      new Set([
        ...original.split(/\s+/),
        "[--surface-hover:var(--sidebar-bg-hover)]",
        "[--surface-border:var(--border2)]",
      ]),
    );
    expect(markup).toContain('data-surface="sidebar"');
    expect(markup).toContain('aria-label="Workspace navigation"');
  });

  it("preserves the standalone draft harness's sidebar container", () => {
    // harnesses/harness-draft-indicators.tsx original sidebar-width container.
    const original = "bg-sidebar-bg flex w-[220px] flex-col gap-px p-1";
    const markup = renderToStaticMarkup(
      createElement(Surface, {
        kind: "sidebar",
        className: "flex w-[220px] flex-col gap-px p-1",
        "data-testid": "workspace-tabs",
      } as SurfaceProps),
    );
    expect(markup).toMatch(/^<div\b/);
    expect(classes(markup)).toEqual(
      new Set([
        ...original.split(/\s+/),
        "[--surface-hover:var(--sidebar-bg-hover)]",
        "[--surface-border:var(--border2)]",
      ]),
    );
    expect(markup).toContain('data-testid="workspace-tabs"');
  });

  const cases = [
    // shell/app-sidebar.tsx Home
    {
      site: "shell/app-sidebar.tsx Home",
      file: "shell/app-sidebar.tsx",
      constant: "SIDEBAR_ENTRY_CLS",
      tag: "button",
      original:
        "flex h-7.5 w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-0 text-left text-xs font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1",
      icon: false,
    },
    // shell/app-sidebar.tsx Customize
    {
      site: "shell/app-sidebar.tsx Customize",
      file: "shell/app-sidebar.tsx",
      constant: "SIDEBAR_ENTRY_CLS",
      tag: "button",
      original:
        "flex h-7.5 w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-0 text-left text-xs font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1",
      icon: false,
    },
    // shell/app-sidebar.tsx Announcements
    {
      site: "shell/app-sidebar.tsx Announcements",
      file: "shell/app-sidebar.tsx",
      constant: "SIDEBAR_ENTRY_CLS",
      tag: "button",
      original:
        "flex h-7.5 w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-0 text-left text-xs font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1",
      icon: false,
    },
    // shell/app-sidebar.tsx legacy folder
    {
      site: "shell/app-sidebar.tsx legacy folder",
      file: "shell/app-sidebar.tsx",
      constant: "SIDEBAR_ENTRY_CLS",
      tag: "button",
      original:
        "flex h-7.5 w-full min-w-0 items-center justify-start gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-0 text-left text-xs font-normal text-fg2 transition-colors duration-150 ease-out hover:bg-sidebar-bg-hover hover:text-fg2 data-[state=active]:bg-sidebar-bg-hover data-[state=active]:text-fg1 data-[state=active]:hover:text-fg1 [&_svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg2 data-[state=active]:[&>svg]:text-fg1",
      icon: false,
    },
    // shell/app-sidebar.tsx archived workspaces
    {
      site: "shell/app-sidebar.tsx archived workspaces",
      file: "shell/app-sidebar.tsx",
      constant: "TITLE_ICON_BUTTON_CLS",
      tag: "button",
      original:
        "h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1",
      icon: true,
    },
    // shell/app-sidebar.tsx disabled archive
    {
      site: "shell/app-sidebar.tsx disabled archive",
      file: "shell/app-sidebar.tsx",
      constant: "TITLE_ICON_BUTTON_CLS",
      tag: "button",
      original:
        "h-7 w-7 shrink-0 rounded-md text-fg2 hover:bg-sidebar-bg-hover hover:text-fg1 data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1",
      icon: true,
    },
    // shell/sidebar-workspace-row.tsx workspace
    {
      site: "shell/sidebar-workspace-row.tsx workspace",
      file: "shell/sidebar-workspace-row.tsx",
      constant: "SIDEBAR_WORKSPACE_ROW_CLS",
      tag: "div",
      original:
        "group/workspace relative flex h-7.5 w-full min-w-0 shrink-0 select-none items-center overflow-hidden rounded-md pr-2 text-left text-xs font-normal text-fg2 transition-none hover:bg-sidebar-bg-hover focus-within:bg-sidebar-bg-hover data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1",
      icon: false,
    },
    // shell/sidebar-workspace-row.tsx pending workspace
    {
      site: "shell/sidebar-workspace-row.tsx pending workspace",
      file: "shell/sidebar-workspace-row.tsx",
      constant: "SIDEBAR_WORKSPACE_ROW_CLS",
      tag: "div",
      original:
        "group/workspace relative flex h-7.5 w-full min-w-0 shrink-0 select-none items-center overflow-hidden rounded-md pr-2 text-left text-xs font-normal text-fg2 transition-none hover:bg-sidebar-bg-hover focus-within:bg-sidebar-bg-hover data-[active=true]:bg-sidebar-bg-hover data-[active=true]:text-fg1",
      icon: false,
    },
    // shell/sidebar-repository-header.tsx repository header
    {
      site: "shell/sidebar-repository-header.tsx repository header",
      file: "shell/sidebar-repository-header.tsx",
      constant: "REPOSITORY_HEADER_CLS",
      tag: "div",
      original:
        "group/repo relative flex h-7.5 w-full min-w-0 shrink-0 select-none items-center gap-1 rounded-md pr-1 text-fg2 transition-none hover:bg-sidebar-bg-hover data-[active=true]:bg-sidebar-bg-hover",
      icon: false,
    },
  ];
  it.each(cases)(
    "preserves $site under the sidebar binding",
    ({ file, constant, tag, original, icon }) => {
      const current = currentRecipe(file, constant);
      expect(current).toContain("hover:bg-(--surface-hover)");
      const previous = renderToStaticMarkup(
        tag === "button"
          ? createElement(
              Button,
              {
                variant: "ghost",
                ...(icon ? { size: "icon" as const } : {}),
                className: original,
              },
              "row",
            )
          : createElement("div", { className: original }, "row"),
      );
      const markup = renderToStaticMarkup(
        tag === "button"
          ? createElement(
              Button,
              {
                variant: "ghost",
                ...(icon ? { size: "icon" as const } : {}),
                className: current,
              },
              "row",
            )
          : createElement("div", { className: current }, "row"),
      );
      expect(markup).toMatch(new RegExp(`^<${tag}\\b`));
      expect(sidebarClasses(markup)).toEqual(classes(previous));
      const surface = renderToStaticMarkup(
        createElement(Surface, { kind: "sidebar" }),
      );
      expect(surface).toContain("[--surface-hover:var(--sidebar-bg-hover)]");
    },
  );

  it.each([
    ["canvas", "bg1", "bg1-hover", "border1"],
    ["raised", "bg2", "bg2-hover", "border2"],
    ["floating", "bg3", "bg3-hover", "border2"],
    ["sidebar", "sidebar-bg", "sidebar-bg-hover", "border2"],
  ] as const)(
    "binds %s to its own existing theme tokens",
    (kind, fill, hover, border) => {
      const markup = renderToStaticMarkup(createElement(Surface, { kind }));
      expect(classes(markup)).toEqual(
        new Set([
          `bg-${fill}`,
          `[--surface-hover:var(--${hover})]`,
          `[--surface-border:var(--${border})]`,
        ]),
      );
    },
  );
});
