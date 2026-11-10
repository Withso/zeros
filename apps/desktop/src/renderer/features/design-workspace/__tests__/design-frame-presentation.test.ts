import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve("apps/desktop/src/renderer/features/design-workspace/design-workspace-ui.css"), "utf8");
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

it("keeps a frame's last pixels beneath a ready editor until that editor has presented a frame", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div class="zd-design-frame" data-design-frame="card.html">
      <div data-design-frame-render-surface="">
        <div data-design-source-vector-host="" style="display:contents"><img data-design-source-vector="" data-design-source-surface="" data-design-source-ready="" alt="vector"></div>
        <iframe title="source" data-design-source-surface="" data-design-source-buffer="displayed" data-design-source-ready=""></iframe>
        <div data-design-frame-pixel-cover=""></div>
        <div><iframe title="editor" data-design-document-buffer="displayed"></iframe></div>
      </div></div>`);
    await page.addStyleTag({ content: css });
    const underlays = () => page.evaluate(() => [...document.querySelectorAll("img[alt=vector], iframe[title=source], [data-design-frame-pixel-cover]")]
      .map((node) => getComputedStyle(node).visibility));
    const editor = page.locator("iframe[title=editor]");
    expect(await underlays()).toEqual(["visible", "visible", "visible"]);
    // Ready is layout and a protocol handshake, not pixels: a newly shown
    // native document can composite nothing for a frame or more.
    await editor.evaluate((node) => node.setAttribute("data-design-document-ready", ""));
    expect(await underlays()).toEqual(["visible", "visible", "visible"]);
    await editor.evaluate((node) => node.setAttribute("data-design-document-presented", ""));
    expect(await underlays()).toEqual(["hidden", "hidden", "hidden"]);
  } finally { await page.close(); }
});
