import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";
import { chromium, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { TurnPromptHeader } from "../turn-container";
import {
  PROMPT_FOLD_COLLAPSED_CLS,
  PROMPT_FOLD_COLLAPSED_PX,
  PROMPT_FOLD_EXPANDED_CLS,
  PROMPT_FOLD_EXPANDED_PX,
  PROMPT_FOLD_TOGGLE_ROW_PX,
  promptFolds,
} from "../prompt-fold";

/** The class list of the first tag that carries `marker`, an attribute or a
 *  class name. */
function classesOf(markup: string, marker: string): Set<string> {
  const tag = markup.split("<").find((chunk) => chunk.slice(0, chunk.indexOf(">")).includes(marker));
  expect(tag, marker).toBeDefined();
  const value = tag!.match(/class="([^"]*)"/)?.[1] ?? "";
  return new Set(value.replaceAll("&amp;", "&").split(/\s+/));
}

describe("sent message width", () => {
  it("spans the lane at any length, like the composer", () => {
    for (const props of [{}, { autoAction: "create-pr" }]) {
      const markup = renderToStaticMarkup(h(TurnPromptHeader, { originalText: "hi", ...props, children: "hi" }));
      const prompt = classesOf(markup, "zeros-agent-turn-prompt group/usermsg");
      expect(prompt).toContain("w-full");
      expect(prompt).toContain("max-w-[800px]");
      expect(prompt).not.toContain("items-end");
      const bubble = classesOf(markup, 'data-user-bubble=""');
      expect(bubble).toContain("w-full");
      expect(bubble).not.toContain("w-fit");
    }
  });

  it("renders a short message without a fold toggle", () => {
    const markup = renderToStaticMarkup(h(TurnPromptHeader, { originalText: "hi", children: "hi" }));
    expect(markup).not.toContain("Show more");
    expect(markup).not.toContain("data-prompt-fold=");
  });
});

describe("sent message fold", () => {
  it("folds only when the folded view and its toggle are shorter than the message", () => {
    // Five 20px lines folded, fifteen unfolded, a 28px toggle row (4px gap and
    // the 24px compact Ghost button).
    expect(PROMPT_FOLD_COLLAPSED_PX).toBe(5 * 20);
    expect(PROMPT_FOLD_EXPANDED_PX).toBe(15 * 20);
    expect(PROMPT_FOLD_TOGGLE_ROW_PX).toBe(28);
    expect(promptFolds(0)).toBe(false);
    expect(promptFolds(6 * 20)).toBe(false);
    expect(promptFolds(PROMPT_FOLD_COLLAPSED_PX + PROMPT_FOLD_TOGGLE_ROW_PX)).toBe(false);
    expect(promptFolds(PROMPT_FOLD_COLLAPSED_PX + PROMPT_FOLD_TOGGLE_ROW_PX + 1)).toBe(true);
    expect(promptFolds(7 * 20)).toBe(true);
  });

  it("clips the folded text and dissolves its last 32px; unfolded, scrolls and fades only the edges text runs past", () => {
    // The fold's box reaches 4px past the text on every side, so its heights
    // carry those 8px.
    const collapsed = PROMPT_FOLD_COLLAPSED_CLS.split(" ");
    expect(collapsed).toEqual(expect.arrayContaining([
      `max-h-[${PROMPT_FOLD_COLLAPSED_PX + 8}px]`, "overflow-clip", "mask-b-from-[calc(100%-2rem)]",
    ]));
    const expanded = PROMPT_FOLD_EXPANDED_CLS.split(" ");
    expect(expanded).toEqual(expect.arrayContaining([
      `max-h-[${PROMPT_FOLD_EXPANDED_PX + 8}px]`, "overflow-y-auto",
      "data-more-above:mask-t-from-[calc(100%-2rem)]", "data-more-below:mask-b-from-[calc(100%-2rem)]",
    ]));
    // Reaching its end hands the wheel back to the transcript.
    expect(expanded).not.toContain("overscroll-contain");
    expect(expanded.some((cls) => cls.startsWith("mask-"))).toBe(false);
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
      import { PromptFold } from "./features/agent/prompt-fold";
      const root = createRoot(document.querySelector("#app"));
      window.fold = {
        render(height, surfaceActive = true, controls = false) {
          flushSync(() => root.render(
            <PromptFold surfaceActive={surfaceActive}>
              <div id="content" style={{ height, position: "relative" }}>
                {controls ? (
                  <>
                    <button id="near" type="button">near</button>
                    <button id="far" type="button" style={{ position: "absolute", bottom: 0 }}>far</button>
                  </>
                ) : null}
              </div>
            </PromptFold>,
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

// Stands in for the utilities: the fold's own heights and scrolling, so the
// edge tracking has something to scroll.
const FOLD_CSS = `
  [data-prompt-fold="collapsed"] { max-height: 108px; overflow: clip; }
  [data-prompt-fold="expanded"] { max-height: 308px; overflow-y: auto; }
`;

async function withPage(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${FOLD_CSS}</style><div id="app"></div>`);
    await page.addScriptTag({ content: script });
    await run(page);
  } finally {
    await browser.close();
  }
}

const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

const state = (page: Page) =>
  page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>("#content")!.parentElement!.parentElement!;
    const toggle = document.querySelector<HTMLButtonElement>("[data-prompt-fold-toggle]");
    return {
      fold: viewport.getAttribute("data-prompt-fold"),
      above: viewport.hasAttribute("data-more-above"),
      below: viewport.hasAttribute("data-more-below"),
      scrollTop: viewport.scrollTop,
      toggle: toggle?.textContent ?? null,
      expanded: toggle?.getAttribute("aria-expanded") ?? null,
      controls: toggle ? document.getElementById(toggle.getAttribute("aria-controls") ?? "") === viewport : null,
    };
  });

describe("sent message fold in a browser", () => {
  it("folds a tall message in the frame it first lays out, before it paints", async () => {
    await withPage(async (page) => {
      // A ResizeObserver created after the fold's runs after it in the same
      // rendering update, so it sees what the frame paints.
      const firstFrame = await page.evaluate(() => new Promise<{ fold: string | null; toggle: string | null }>((resolve) => {
        (window as any).fold.render(400);
        const probe = new ResizeObserver(() => {
          probe.disconnect();
          resolve({
            fold: document.querySelector("#content")!.parentElement!.parentElement!.getAttribute("data-prompt-fold"),
            toggle: document.querySelector("[data-prompt-fold-toggle]")?.textContent ?? null,
          });
        });
        probe.observe(document.querySelector("#content")!);
      }));
      expect(firstFrame).toEqual({ fold: "collapsed", toggle: "Show more" });
    });
  });

  it("leaves a message that folding would not shorten as it is", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(128));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: null, toggle: null });
      await page.evaluate(() => (window as any).fold.render(129));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed", toggle: "Show more", expanded: "false", controls: true });
    });
  });

  it("toggles between Show more and Show less", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(400));
      await frames(page);
      await page.click("[data-prompt-fold-toggle]");
      expect(await state(page)).toMatchObject({ fold: "expanded", toggle: "Show less", expanded: "true", controls: true });
      await page.click("[data-prompt-fold-toggle]");
      expect(await state(page)).toMatchObject({ fold: "collapsed", toggle: "Show more", expanded: "false" });
    });
  });

  it("marks only the edges the unfolded text runs past, and folds back to the top", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(900));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed", above: false, below: false });
      await page.click("[data-prompt-fold-toggle]");
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "expanded", above: false, below: true, scrollTop: 0 });
      const scrollTo = (top: number) => page.evaluate((value) => {
        document.querySelector("#content")!.parentElement!.parentElement!.scrollTop = value;
      }, top);
      await scrollTo(200);
      await frames(page);
      expect(await state(page)).toMatchObject({ above: true, below: true });
      await scrollTo(10_000);
      await frames(page);
      expect(await state(page)).toMatchObject({ above: true, below: false });
      await page.click("[data-prompt-fold-toggle]");
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed", above: false, below: false, scrollTop: 0 });
      await page.click("[data-prompt-fold-toggle]");
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "expanded", above: false, below: true, scrollTop: 0 });
    });
  });

  it("folds back in a hidden chat and does not measure until it is shown", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(400));
      await frames(page);
      await page.click("[data-prompt-fold-toggle]");
      await page.evaluate(() => (window as any).fold.render(400, false));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed", toggle: "Show more" });
      // Hidden, a new size goes unmeasured.
      await page.evaluate(() => (window as any).fold.render(50, false));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed" });
      await page.evaluate(() => (window as any).fold.render(50, true));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: null, toggle: null });
    });
  });

  // Folded, the box clips rather than scrolls, so nothing would bring a
  // focused link or attachment below the fold into view.
  it("unfolds to show a control that keyboard focus reaches below the fold", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(400, true, true));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed" });
      await page.focus("#far");
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "expanded", toggle: "Show less" });
      expect(await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>("#content")!.parentElement!.parentElement!.getBoundingClientRect();
        const far = document.querySelector<HTMLElement>("#far")!.getBoundingClientRect();
        return {
          focused: document.activeElement?.id,
          inView: far.top >= viewport.top - 0.5 && far.bottom <= viewport.bottom + 0.5,
        };
      })).toEqual({ focused: "far", inView: true });
    });
  });

  it("keeps the fold when focus lands on a control already in view", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(400, true, true));
      await frames(page);
      await page.focus("#near");
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed", toggle: "Show more" });
    });
  });

  it("forgets it was unfolded when the message no longer folds", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).fold.render(400));
      await frames(page);
      await page.click("[data-prompt-fold-toggle]");
      await page.evaluate(() => (window as any).fold.render(100));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: null, toggle: null });
      await page.evaluate(() => (window as any).fold.render(400));
      await frames(page);
      expect(await state(page)).toMatchObject({ fold: "collapsed", toggle: "Show more" });
    });
  });
});
