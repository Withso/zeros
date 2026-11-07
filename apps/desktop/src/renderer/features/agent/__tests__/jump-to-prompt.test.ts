import path from "node:path";
import { buildSync } from "esbuild";
import { chromium, type Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

// The jump control appears once the active prompt has scrolled above the
// transcript. A folded prompt's bubble clips its text, so the text's own box
// runs on below what is on screen: the control must measure the bubble.
const script = buildSync({
  stdin: {
    resolveDir: path.resolve("apps/desktop/src/renderer"),
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { TooltipProvider } from "./shared/ui/primitives";
      import { JumpToPromptPill } from "./features/agent/jump-pills";
      import { PromptFold } from "./features/agent/prompt-fold";
      const stage = createRoot(document.querySelector("#stage"));
      const pill = createRoot(document.querySelector("#pill"));
      window.jump = {
        render() {
          flushSync(() => stage.render(
            <div id="scroller" style={{ height: 300, overflowY: "auto" }}>
              <div style={{ height: 50 }} />
              <div data-user-bubble="">
                <PromptFold><div id="prompt" style={{ height: 400 }} /></PromptFold>
              </div>
              <div style={{ height: 2000 }} />
            </div>,
          ));
          const scrollEl = document.querySelector("#scroller");
          const promptEl = document.querySelector("#prompt");
          flushSync(() => pill.render(
            <TooltipProvider><JumpToPromptPill scrollEl={scrollEl} promptEl={promptEl} /></TooltipProvider>,
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

// The fold's own clip, standing in for its utilities.
const FOLD_CSS = `[data-prompt-fold="collapsed"] { max-height: 118px; overflow: clip; }`;

async function withPage(run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${FOLD_CSS}</style><div id="stage"></div><div id="pill"></div>`);
    await page.addScriptTag({ content: script });
    await run(page);
  } finally {
    await browser.close();
  }
}

const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

describe("jump to prompt", () => {
  it("shows once a folded prompt's visible bubble scrolls above the transcript", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => (window as any).jump.render());
      await frames(page);
      expect(await page.locator('button[aria-label="Jump to your prompt"]').count()).toBe(0);
      await page.evaluate(() => {
        document.querySelector<HTMLElement>("#scroller")!.scrollTop = 250;
      });
      await frames(page);
      // The bubble is out of view while the clipped text's box still reaches
      // into the transcript.
      expect(await page.evaluate(() => {
        const top = document.querySelector("#scroller")!.getBoundingClientRect().top;
        return {
          fold: document.querySelector("[data-prompt-fold]")?.getAttribute("data-prompt-fold"),
          bubbleAbove: document.querySelector("[data-user-bubble]")!.getBoundingClientRect().bottom < top,
          textReachesIn: document.querySelector("#prompt")!.getBoundingClientRect().bottom > top,
        };
      })).toEqual({ fold: "collapsed", bubbleAbove: true, textReachesIn: true });
      expect(await page.locator('button[aria-label="Jump to your prompt"]').count()).toBe(1);
    });
  });
});
