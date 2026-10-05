import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";

import { Button } from "../button";
import { IconButton, type IconButtonProps } from "../icon-button";

function classes(markup: string) {
  return new Set(markup.match(/class="([^"]*)"/)![1]!.split(/\s+/));
}

describe("IconButton markup equivalence", () => {
  const inlineCases: Array<{
    site: string;
    original: string;
    props: Omit<IconButtonProps, "label">;
  }> = [
    // Each original recipe is retained verbatim from its migrated caller.
    {
      site: "chat-tabs close",
      original:
        "pointer-events-auto size-5 inline-flex items-center justify-center rounded-sm shrink-0 text-fg2 hover:text-fg1 hover:bg-bg2-hover transition-[background-color,color] duration-120 ease-out",
      props: { className: "pointer-events-auto shrink-0" },
    },
    {
      site: "sidebar-workspace-row Archive/settings",
      original:
        "pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-[background-color,color] duration-120 ease-out hover:bg-bg2-hover hover:text-fg1",
      props: { className: "pointer-events-auto shrink-0" },
    },
    {
      site: "tab-strip stop",
      original:
        "text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm transition-[background-color,color] duration-120 ease-out disabled:opacity-50",
      props: { className: "pointer-events-auto shrink-0 disabled:opacity-50" },
    },
    {
      site: "tab-strip close",
      original:
        "text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 shrink-0 items-center justify-center rounded-sm transition-[background-color,color] duration-120 ease-out",
      props: { className: "pointer-events-auto shrink-0" },
    },
    ...["stop", "hide", "restore"].map((action) => ({
      site: `browser-agent-picture-in-picture ${action}`,
      original:
        "text-fg2 hover:bg-bg2-hover hover:text-fg1 pointer-events-auto inline-flex size-5 items-center justify-center rounded-sm",
      props: { motion: "none" as const, className: "pointer-events-auto" },
    })),
    ...["copy", "actions"].map((action) => ({
      site: `turn-footer ${action}`,
      original:
        "flex size-5 shrink-0 items-center justify-center rounded-sm text-fg2 transition-colors hover:bg-bg2-hover hover:text-fg1",
      props: { motion: "colors" as const, className: "flex shrink-0" },
    })),
    {
      site: "changes-tab row action",
      original:
        "text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-5 items-center justify-center rounded-sm transition-colors disabled:opacity-30",
      props: { motion: "colors", className: "flex disabled:opacity-30" },
    },
    {
      site: "review-checks logs anchor",
      original:
        "text-fg2 hover:bg-bg2-hover hover:text-fg1 flex size-5 shrink-0 items-center justify-center rounded-sm transition-colors duration-120 ease-out",
      props: {
        asChild: true,
        motion: "colors-hover",
        className: "flex shrink-0",
      },
    },
  ];

  it.each(inlineCases)("preserves $site", ({ original, props }) => {
    const markup = renderToStaticMarkup(
      createElement(
        IconButton,
        { ...props, label: "Action" },
        props.asChild ? createElement("a", { href: "/logs" }, "icon") : "icon",
      ),
    );
    expect(markup).toMatch(props.asChild ? /^<a\b/ : /^<button\b/);
    expect(classes(markup)).toEqual(new Set(original.split(/\s+/)));
    if (props.asChild) expect(markup).not.toContain('type="button"');
    else expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Action"');
  });

  it.each([
    // Button-backed callers must retain Button's complete rendered recipe.
    [
      "chat-tabs pane menu",
      "size-7 shrink-0 rounded-sm text-fg2 hover:bg-bg2-hover/40 hover:text-fg1 transition-[background-color,color] duration-120 ease-out",
    ],
    [
      "conversation-header Open in",
      "size-7 shrink-0 rounded-sm text-fg2 hover:text-fg1 hover:bg-bg2-hover/40 transition-[background-color,color] duration-120 ease-out",
    ],
    [
      "new-chat-menu +",
      "size-7 shrink-0 rounded-sm text-fg2 hover:bg-bg2-hover/40 hover:text-fg1 transition-[background-color,color] duration-120 ease-out",
    ],
  ])("retains Button's full class set for %s", (_site, original) => {
    const previous = renderToStaticMarkup(
      createElement(
        Button,
        {
          variant: "ghost",
          size: "icon-sm",
          className: original,
          "aria-label": "Action",
        },
        "icon",
      ),
    );
    const current = renderToStaticMarkup(
      createElement(
        IconButton,
        {
          size: "standard",
          hover: "subtle",
          className: "shrink-0",
          label: "Action",
        },
        "icon",
      ),
    );
    expect(current).toMatch(/^<button\b/);
    expect(classes(current)).toEqual(classes(previous));
    expect(current).toContain('aria-label="Action"');
  });

  it("preserves the logs link's native semantics and attributes", () => {
    const markup = renderToStaticMarkup(
      createElement(
        IconButton,
        {
          asChild: true,
          label: "Open logs",
          motion: "colors-hover",
          className: "flex shrink-0",
        },
        createElement(
          "a",
          { href: "/logs", target: "_blank", rel: "noreferrer" },
          "icon",
        ),
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
