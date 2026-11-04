import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { IconButton } from "../icon-button";
import { Toolbar, ToolbarSeparator } from "../toolbar";

function classes(markup: string) {
  const attribute = markup.match(/class="([^"]*)"/)![1]!.replaceAll("&amp;", "&");
  return new Set(attribute.split(/\s+/));
}

describe("Toolbar chrome", () => {
  it("draws one 36px bar: 3px inset, border2 edge, 10px corners, bg2", () => {
    const set = classes(
      renderToStaticMarkup(createElement(Toolbar, { "aria-label": "Canvas tools" }, "tools")),
    );
    expect(set).toContain("border");
    expect(set).toContain("border-border2");
    expect(set).toContain("bg-bg2");
    expect(set).toContain("gap-0.5");
    expect(set).toContain("p-[calc(var(--spacing)*0.75)]");
    expect(set).toContain("rounded-[calc(var(--radius-md)+var(--spacing))]");
  });

  it("lifts with the dropdown shadow when floating and none when docked", () => {
    const floating = classes(renderToStaticMarkup(createElement(Toolbar, { "aria-label": "Tools" })));
    expect([...floating].filter((cls) => cls.startsWith("shadow"))).toEqual([
      "shadow-[var(--shadow-dropdown)]",
    ]);
    const docked = renderToStaticMarkup(
      createElement(Toolbar, { "aria-label": "Tools", elevation: "docked" }),
    );
    expect(docked).not.toContain("shadow-[");
  });

  it("owns toolbar semantics and its orientation", () => {
    const markup = renderToStaticMarkup(
      createElement(Toolbar, { "aria-label": "Canvas tools", orientation: "vertical" }),
    );
    expect(markup).toContain('role="toolbar"');
    expect(markup).toContain('aria-label="Canvas tools"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(classes(markup)).toContain("flex-col");
  });

  it("sizes its icon buttons as 28px tools unless a caller says otherwise", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Toolbar,
        { "aria-label": "Tools" },
        createElement(IconButton, { label: "Back" }, "icon"),
        createElement(IconButton, { label: "Close", size: "compact" }, "icon"),
      ),
    );
    const [back, close] = markup.split("<button").slice(1);
    expect(back).toContain("size-7");
    expect(close).toContain("size-6");
    expect(renderToStaticMarkup(createElement(IconButton, { label: "Row" }, "i"))).toContain("size-5");
  });

  it("separates groups with a 1 × 16 border2 rule", () => {
    const set = classes(renderToStaticMarkup(createElement(ToolbarSeparator)));
    expect(set).toContain("bg-border2");
    expect(set).toContain("in-data-[orientation=horizontal]:h-4");
    expect(set).toContain("in-data-[orientation=horizontal]:w-px");
  });
});

const script = buildSync({
  stdin: {
    resolveDir: path.resolve("apps/desktop/src/renderer"),
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { Toolbar } from "./shared/ui/primitives/toolbar";
      import { IconButton } from "./shared/ui/primitives/icon-button";
      const root = createRoot(document.querySelector("#app"));
      window.toolbar = {
        render(disabled) {
          flushSync(() => root.render(
            <>
              <button id="before">Before</button>
              <Toolbar aria-label="Tools">
                <IconButton id="move" label="Move">M</IconButton>
                <IconButton id="frame" label="Frame" aria-pressed>F</IconButton>
                <IconButton id="text" label="Text" disabled={disabled}>T</IconButton>
                <IconButton id="pen" label="Pen">P</IconButton>
              </Toolbar>
              <button id="after">After</button>
            </>,
          ));
        },
      };
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  tsconfig: path.resolve("tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  logLevel: "silent",
}).outputFiles[0]!.text;

describe("Toolbar keyboard", () => {
  it("is one Tab stop with arrow keys, Home and End between enabled tools", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="app"></div>');
      await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as any).toolbar.render(true));
      const focused = () => page.evaluate(() => document.activeElement?.id);

      await page.focus("#before");
      await page.keyboard.press("Tab");
      // The pressed tool is where Tab lands first.
      expect(await focused()).toBe("frame");
      await page.keyboard.press("Tab");
      expect(await focused()).toBe("after");

      await page.keyboard.press("Shift+Tab");
      expect(await focused()).toBe("frame");
      await page.keyboard.press("ArrowRight");
      // Disabled tools are skipped.
      expect(await focused()).toBe("pen");
      await page.keyboard.press("ArrowRight");
      expect(await focused()).toBe("move");
      await page.keyboard.press("ArrowLeft");
      expect(await focused()).toBe("pen");
      await page.keyboard.press("Home");
      expect(await focused()).toBe("move");
      await page.keyboard.press("End");
      expect(await focused()).toBe("pen");

      // Leaving and coming back returns to the tool used last.
      await page.keyboard.press("Tab");
      expect(await focused()).toBe("after");
      await page.keyboard.press("Shift+Tab");
      expect(await focused()).toBe("pen");
      const stops = await page.evaluate(() =>
        [...document.querySelectorAll('[role="toolbar"] button')].map((b) => (b as HTMLElement).tabIndex),
      );
      expect(stops.filter((value) => value === 0)).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  it("joins a tool to the arrow order once it is enabled", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="app"></div>');
      await page.addScriptTag({ content: script });
      await page.evaluate(() => (window as any).toolbar.render(true));
      await page.evaluate(() => (window as any).toolbar.render(false));
      await page.focus("#frame");
      await page.keyboard.press("ArrowRight");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("text");
      expect(await page.evaluate(() => (document.querySelector("#text") as HTMLElement).tabIndex)).toBe(0);
    } finally {
      await browser.close();
    }
  });
});
