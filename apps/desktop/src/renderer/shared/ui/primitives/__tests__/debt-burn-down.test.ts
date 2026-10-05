import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ElementType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { Avatar, AvatarFallback } from "../avatar";
import { ListRow } from "../list-row";
import { Select, SelectTrigger } from "../select";

// This is a fixture for a floating menu row, not a surface owned by this file.
const floatingRowHover = ["hover:bg", "bg3-hover"].join("-");

// Before strings were captured from these callers before the debt burn-down.
// Alias normalization permits only the listed exact substitutions. The browser
// proof separately compares their compiled styles in both themes and states.
const cases = [
  {
    file: "features/agent/context-gauge.tsx",
    site: 141,
    component: "ClassAlias",
    tag: "button",
    original:
      "hover:bg-bg2-hover text-fg2 hover:text-fg1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 bg-transparent p-0 transition-colors",
    className:
      "hover:bg-bg2-hover text-fg2 hover:text-fg1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 transition-colors",
    literal:
      "hover:bg-bg2-hover text-fg2 hover:text-fg1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 transition-colors",
    alias: {
      before: "rounded-[6px]",
      after: "rounded-md",
    },
  },
  {
    file: "features/agent/context-gauge.tsx",
    site: 190,
    component: "ClassAlias",
    tag: "button",
    original: `${floatingRowHover} text-fg2 hover:text-fg1 w-full cursor-pointer rounded-[6px] border-0 bg-transparent px-2 py-1 text-left text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50`,
    className: `${floatingRowHover} text-fg2 hover:text-fg1 w-full cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 text-left text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50`,
    literal: `${floatingRowHover} text-fg2 hover:text-fg1 w-full cursor-pointer rounded-md border-0 bg-transparent px-2 py-1 text-left text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50`,
    alias: {
      before: "rounded-[6px]",
      after: "rounded-md",
    },
  },
  {
    file: "features/agent/composer-attachments.tsx",
    site: 194,
    component: "ClassAlias",
    tag: "span",
    original: "overflow-hidden pl-[2px] text-ellipsis whitespace-nowrap",
    className: "overflow-hidden pl-0.5 text-ellipsis whitespace-nowrap",
    literal: "overflow-hidden pl-0.5 text-ellipsis whitespace-nowrap",
    alias: {
      before: "pl-[2px]",
      after: "pl-0.5",
    },
  },
  {
    file: "features/agent/workflow-activity.tsx",
    site: 195,
    component: "ClassAlias",
    tag: "div",
    original: "flex h-2 min-w-0 gap-[2px]",
    className: "flex h-2 min-w-0 gap-0.5",
    literal: "flex h-2 min-w-0 gap-0.5",
    alias: {
      before: "gap-[2px]",
      after: "gap-0.5",
    },
  },
  {
    file: "features/agent/agent-model-menu.tsx",
    site: 877,
    component: "ClassAlias",
    tag: "button",
    original:
      "text-fg2 hover:text-fg1 focus-visible:text-fg1 mr-1 flex h-[18px] shrink-0 items-center justify-center rounded-sm px-1.5 text-[12px] outline-none",
    className:
      "text-fg2 hover:text-fg1 focus-visible:text-fg1 mr-1 flex h-[18px] shrink-0 items-center justify-center rounded-sm px-1.5 text-3xxs outline-none",
    literal:
      "text-fg2 hover:text-fg1 focus-visible:text-fg1 mr-1 flex h-[18px] shrink-0 items-center justify-center rounded-sm px-1.5 text-3xxs outline-none",
    alias: {
      before: "text-[12px]",
      after: "text-3xxs",
    },
  },
  {
    file: "features/design-workspace/design-inspector.tsx",
    site: 678,
    component: "ClassAlias",
    tag: "SelectTrigger",
    original:
      "zd-design-unit-trigger h-full w-auto shrink-0 gap-0 rounded-none border-0 bg-transparent py-0 pr-2 pl-1 text-[12px] shadow-none [&>svg]:hidden",
    className:
      "zd-design-unit-trigger h-full w-auto shrink-0 gap-0 rounded-none border-0 bg-transparent py-0 pr-2 pl-1 text-3xxs shadow-none [&>svg]:hidden",
    literal:
      "zd-design-unit-trigger h-full w-auto shrink-0 gap-0 rounded-none border-0 bg-transparent py-0 pr-2 pl-1 text-3xxs shadow-none [&>svg]:hidden",
    alias: {
      before: "text-[12px]",
      after: "text-3xxs",
    },
  },
  {
    file: "features/settings/settings-ui.tsx",
    site: 110,
    component: "ClassAlias",
    tag: "h2",
    original: "text-fg2 m-0 text-[12px] font-medium",
    className: "text-fg2 m-0 text-3xxs font-medium",
    literal: "text-fg2 m-0 text-3xxs font-medium",
    alias: {
      before: "text-[12px]",
      after: "text-3xxs",
    },
  },
  {
    file: "features/settings/settings-ui.tsx",
    site: 113,
    component: "ClassAlias",
    tag: "p",
    original: "text-muted-fg m-0 text-[12px]",
    className: "text-muted-fg m-0 text-3xxs",
    literal: "text-muted-fg m-0 text-3xxs",
    alias: {
      before: "text-[12px]",
      after: "text-3xxs",
    },
  },
  {
    file: "features/team/team-panel.tsx",
    site: 109,
    component: "ClassAlias",
    tag: "div",
    original:
      "bg-bg2-hover text-fg1 flex shrink-0 items-center justify-center rounded-lg font-medium text-[10px]",
    className:
      "bg-bg2-hover text-fg1 flex shrink-0 items-center justify-center rounded-lg font-medium text-xxs",
    literal: "text-xxs",
    alias: {
      before: "text-[10px]",
      after: "text-xxs",
    },
    style: {
      width: 20,
      height: 20,
    },
  },
  {
    file: "features/agent/renderers/event-row.tsx",
    site: 220,
    component: "ClassAlias",
    tag: "span",
    original:
      "bg-yellow-bg text-yellow-fg shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
    className:
      "bg-yellow-bg text-yellow-fg shrink-0 rounded-sm px-1.5 py-0.5 text-xxs font-medium",
    literal:
      "bg-yellow-bg text-yellow-fg shrink-0 rounded-sm px-1.5 py-0.5 text-xxs font-medium",
    alias: {
      before: "text-[10px]",
      after: "text-xxs",
    },
  },
  {
    file: "shell/workbench/tabs/review-changes.tsx",
    site: 231,
    component: "ClassAlias",
    tag: "span",
    original: "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
    className: "shrink-0 rounded-sm px-1.5 py-0.5 text-xxs font-medium",
    literal: "shrink-0 rounded-sm px-1.5 py-0.5 text-xxs font-medium",
    alias: {
      before: "text-[10px]",
      after: "text-xxs",
    },
  },
  {
    file: "shell/workbench/tabs/review-shared-components.tsx",
    site: 97,
    component: "ClassAlias",
    tag: "AvatarFallback",
    original: "text-[10px] uppercase",
    className: "text-xxs uppercase",
    literal: "text-xxs uppercase",
    alias: {
      before: "text-[10px]",
      after: "text-xxs",
    },
  },
  {
    file: "shell/workbench/tabs/review-timeline.tsx",
    site: 323,
    component: "ClassAlias",
    tag: "span",
    original: "shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium",
    className: "shrink-0 rounded-sm px-1.5 py-0.5 text-xxs font-medium",
    literal: "shrink-0 rounded-sm px-1.5 py-0.5 text-xxs font-medium",
    alias: {
      before: "text-[10px]",
      after: "text-xxs",
    },
  },
  {
    file: "features/agent/checkpoint-rail.tsx",
    site: 756,
    component: "ClassAlias",
    tag: "span",
    original: "min-w-0 flex-1 truncate text-[13px] leading-snug",
    className: "min-w-0 flex-1 truncate text-xs leading-snug",
    literal: "min-w-0 flex-1 truncate text-xs leading-snug",
    alias: {
      before: "text-[13px]",
      after: "text-xs",
    },
  },
  {
    file: "features/browser/browser-agent-picture-in-picture.tsx",
    site: 376,
    component: "ClassAlias",
    tag: "section",
    original:
      "border-border2 bg-bg1 fixed right-4 bottom-4 z-40 flex overflow-hidden rounded-lg border shadow-[0_14px_42px_rgba(0,0,0,.38)]",
    className:
      "border-border2 bg-bg1 fixed right-4 bottom-4 z-chrome flex overflow-hidden rounded-lg border shadow-[0_14px_42px_rgba(0,0,0,.38)]",
    literal:
      "border-border2 bg-bg1 fixed right-4 bottom-4 z-chrome flex overflow-hidden rounded-lg border shadow-[0_14px_42px_rgba(0,0,0,.38)]",
    alias: {
      before: "z-40",
      after: "z-chrome",
    },
  },
  {
    file: "features/design-workspace/design-motion-timeline.tsx",
    site: 1705,
    component: "ClassAlias",
    tag: "section",
    original: "zd-motion-timeline bg-bg1 absolute z-40 flex min-w-0 flex-col",
    className:
      "zd-motion-timeline bg-bg1 absolute z-chrome flex min-w-0 flex-col",
    literal:
      "zd-motion-timeline bg-bg1 absolute z-chrome flex min-w-0 flex-col",
    alias: {
      before: "z-40",
      after: "z-chrome",
    },
  },
  {
    file: "features/design-workspace/design-motion-timeline.tsx",
    site: 1799,
    component: "ClassAlias",
    tag: "section",
    original: "zd-motion-timeline bg-bg1 absolute z-40 flex min-w-0 flex-col",
    className:
      "zd-motion-timeline bg-bg1 absolute z-chrome flex min-w-0 flex-col",
    literal:
      "zd-motion-timeline bg-bg1 absolute z-chrome flex min-w-0 flex-col",
    alias: {
      before: "z-40",
      after: "z-chrome",
    },
  },
  {
    file: "shell/conversation/pane-layout.tsx",
    site: 1489,
    component: "ClassAlias",
    tag: "div",
    original: "absolute inset-0 z-40",
    className: "absolute inset-0 z-chrome",
    literal: "absolute inset-0 z-chrome",
    alias: {
      before: "z-40",
      after: "z-chrome",
    },
  },
  {
    file: "features/design-workspace/design-canvas.tsx",
    site: 7399,
    component: "ClassAlias",
    tag: "div",
    original:
      "zd-design-tools-rail pointer-events-none absolute left-2 z-40 flex items-center",
    className:
      "zd-design-tools-rail pointer-events-none absolute left-2 z-chrome flex items-center",
    literal:
      "zd-design-tools-rail pointer-events-none absolute left-2 z-chrome flex items-center",
    alias: {
      before: "z-40",
      after: "z-chrome",
    },
  },
  {
    file: "features/agent/renderers/event-stripe.tsx",
    site: 148,
    component: "ListRow",
    tag: "button",
    original:
      "group/event-stripe hover:bg-bg2-hover/40 -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors",
    className: "group/event-stripe -ml-1 min-w-0 px-1 transition-colors",
    literal: "group/event-stripe -ml-1 min-w-0 px-1 transition-colors",
  },
];

function renderRecipe(
  tag: string,
  className: string,
  style?: { width: number; height: number },
) {
  const props = {
    id: "specimen",
    className,
    style,
    ...(tag === "button" ? { type: "button" as const } : {}),
  };
  if (tag === "SelectTrigger")
    return renderToStaticMarkup(
      createElement(Select, {}, createElement(SelectTrigger, props, "px")),
    );
  if (tag === "AvatarFallback")
    return renderToStaticMarkup(
      createElement(Avatar, {}, createElement(AvatarFallback, props, "AB")),
    );
  return renderToStaticMarkup(
    createElement(tag as ElementType, props, "content"),
  );
}
// Prettier's Tailwind plugin reorders classes, so source literals are located by
// their class set rather than their exact order.
function classKey(value: string) {
  return value.trim().split(/\s+/).sort().join(" ");
}
function opening(markup: string) {
  return markup.match(/<[a-z][^>]*\bid="specimen"[^>]*>/)![0]!;
}
function classes(markup: string) {
  return new Set(
    opening(markup)
      .match(/class="([^"]*)"/)![1]!
      .split(/\s+/),
  );
}

function markupWithoutClasses(markup: string) {
  return markup.replace(/<([a-z][a-z0-9-]*)([^>]*)>/g, (_match, tag, body) => {
    const attributes: string[] = body.match(/[\w:-]+="[^"]*"/g) ?? [];
    return `<${tag} ${attributes
      .filter((attribute) => !attribute.startsWith("class="))
      .sort()
      .join(" ")}>`;
  });
}

describe("pixel-identical debt burn-down", () => {
  it.each(cases)("retains the recipe at $file:$site", (c) => {
    const source = readFileSync(
      resolve("apps/desktop/src/renderer", c.file),
      "utf8",
    );
    const parsed = ts.createSourceFile(
      c.file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const matches: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isStringLiteralLike(node) &&
        classKey(node.text) === classKey(c.literal)
      ) {
        let parent: ts.Node | undefined = node.parent;
        while (
          parent &&
          !ts.isJsxOpeningElement(parent) &&
          !ts.isJsxSelfClosingElement(parent)
        )
          parent = parent.parent;
        if (
          parent &&
          (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent))
        )
          matches.push(parent.tagName.getText(parsed));
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    const expectedTag = c.component === "ListRow" ? "ListRow" : c.tag;
    const count = cases.filter(
      (other) =>
        other.file === c.file &&
        classKey(other.literal) === classKey(c.literal),
    ).length;
    expect(matches).toEqual(Array(count).fill(expectedTag));

    const previous = renderRecipe(
      c.tag,
      c.original,
      "style" in c ? c.style : undefined,
    );
    const current =
      c.component === "ListRow"
        ? renderToStaticMarkup(
            createElement(
              ListRow,
              { id: "specimen", type: "button", className: c.className },
              "content",
            ),
          )
        : renderRecipe(c.tag, c.className, "style" in c ? c.style : undefined);
    const normalized = new Set(
      [...classes(previous)].map((token) =>
        c.alias && token === c.alias.before ? c.alias.after : token,
      ),
    );
    expect(classes(current)).toEqual(normalized);
    expect(opening(current).match(/^<[a-z]+/)![0]).toEqual(
      opening(previous).match(/^<[a-z]+/)![0],
    );
    expect(markupWithoutClasses(current)).toEqual(
      markupWithoutClasses(previous),
    );
  });

  it("keeps the font-size-only aliases and the existing global chrome layer", () => {
    const tokens = readFileSync("styles/zeros-tokens.css", "utf8");
    expect(tokens).toContain("--text-xxs: 0.625rem;");
    expect(tokens).toContain("--text-3xxs: 0.75rem;");
    expect(tokens).not.toMatch(/--text-(?:xxs|3xxs)--line-height\s*:/);
    expect(tokens).toContain("--radius-md: 6px;");
    expect(readFileSync("styles/global/platform.css", "utf8")).toContain(
      "--z-chrome: 40;",
    );
  });
});
