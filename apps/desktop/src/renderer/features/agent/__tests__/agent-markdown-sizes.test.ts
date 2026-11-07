import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

// Agent markdown takes its size from where it sits, through one custom
// property and rule order (runtime-content.css). Measure the cascade in a real
// browser: the chat, a tool detail, the plan inside its detail, and the
// review panels outside the chat.
const CSS = readFileSync(resolve(process.cwd(), "styles/global/runtime-content.css"), "utf8");

const PAGE = `
<style>:root { --reading-text-size: 15px; --font-mono: monospace; --font-sans: sans-serif; }</style>
<style>${CSS}</style>
<div data-zeros-root="">
  <div class="zeros-agent-md" id="chat"><p>Answer</p><p><code>code</code></p><table><tr><td>cell</td></tr></table><pre>block</pre></div>
  <div data-tool-detail="">
    <div class="zeros-agent-md" id="detail"><p>Detail</p><ul><li>item</li></ul></div>
    <div class="zeros-agent-md zeros-agent-md--document" id="plan"><p>Plan</p></div>
  </div>
  <div class="zeros-agent-md zeros-agent-md--panel" id="panel"><p>Review</p></div>
</div>`;

describe("agent markdown sizes", () => {
  it("reads at 15px in the chat, 13px in a tool detail, 15px for the plan and 14px in review panels", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(PAGE);
      const size = (selector: string) =>
        page.$eval(selector, (element) => getComputedStyle(element).fontSize);
      expect(await size("#chat p")).toBe("15px");
      expect(await size("#chat code")).toBe("13px");
      expect(await size("#chat table")).toBe("13px");
      expect(await size("#chat pre")).toBe("13px");
      expect(await size("#detail p")).toBe("13px");
      expect(await size("#detail li")).toBe("13px");
      expect(await size("#plan p")).toBe("15px");
      expect(await size("#panel p")).toBe("14px");
    } finally {
      await browser.close();
    }
  });
});
