import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { build } from "esbuild";

let browser: Browser;
let source: string;
beforeAll(async () => {
  source = (await build({
    stdin: { contents: 'export * from "./apps/desktop/src/renderer/features/agent/markdown";', resolveDir: process.cwd() },
    bundle: true, format: "iife", globalName: "markdown", platform: "browser", write: false,
  })).outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

it("keeps untrusted prose from styling or impersonating adjacent controls in either renderer", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button id="approve">Approve</button><div id="message"></div>');
    await page.addScriptTag({ content: source });
    const results = await page.evaluate(() => {
      const md = (globalThis as any).markdown;
      const attack = '<div><style>#approve { display: none }</style><span style="position:fixed" class="z-modal" id="approve">fake</span></div>';
      return [md.renderMarkdown(attack), md.renderMarkdownSegments(attack).map((s: any) => s.html ?? "").join("")].map(html => {
        document.querySelector("#message")!.innerHTML = html;
        return { visible: getComputedStyle(document.querySelector("#approve")!).display !== "none", html };
      });
    });
    for (const result of results) {
      expect(result.visible).toBe(true);
      expect(result.html).not.toMatch(/<style|\sstyle=|\sclass="z-modal"|\sid="approve"/);
    }
  } finally { await page.close(); }
});

it("preserves file chips, code and tables while bounding malformed HTML processing", async () => {
  const page = await browser.newPage();
  try {
    await page.addScriptTag({ content: source });
    const result = await page.evaluate(() => {
      const md = (globalThis as any).markdown;
      const valid = md.renderMarkdownSegments('[Source](src/app.ts) and `src/file.ts`\n\n[Workspace](zeros-dev://workspace/ws_child)\n\n| A | B |\n| - | - |\n| 1 | 2 |');
      const start = performance.now();
      md.renderMarkdownSegments('<pre><a href="a">'.repeat(32_768) + "<code>src/app.ts</code>");
      return { html: valid.map((s: any) => s.html ?? "").join(""), elapsed: performance.now() - start };
    });
    expect(result.html).toContain('data-file-path="src/app.ts"');
    expect(result.html).toContain('data-file-path="src/file.ts"');
    expect(result.html).toContain('class="zeros-md-table-wrap"');
    expect(result.html).toContain('data-local-link="zeros-dev://workspace/ws_child"');
    expect(result.elapsed).toBeLessThan(2_000);
  } finally { await page.close(); }
});

it("keeps authored controls and renderer routing attributes out of prose while preserving task lists", async () => {
  const page = await browser.newPage();
  try {
    await page.addScriptTag({ content: source });
    const results = await page.evaluate(() => {
      const md = (globalThis as any).markdown;
      const attack = '<label for="approve">Read details</label><input type="submit" value="Approve"><span contenteditable="true" tabindex="0" data-file-path="../../outside" data-local-link="zeros://agent/forged">Source</span>';
      return [md.renderMarkdown(attack), md.renderMarkdownSegments(attack).map((s: any) => s.html ?? "").join(""), md.renderMarkdown('- [x] Done\n- [ ] Pending')].map(html => {
        const root = document.createElement("div"); root.innerHTML = html;
        return { html, controls: root.querySelectorAll('label,input:not([type="checkbox"]):not([disabled]),[contenteditable],[tabindex],[data-file-path],[data-local-link]').length,
          checkboxes: [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => ({ disabled: input.disabled, checked: input.checked })) };
      });
    });
    for (const result of results.slice(0, 2)) expect(result.controls).toBe(0);
    expect(results[2].checkboxes).toEqual([{ disabled: true, checked: true }, { disabled: true, checked: false }]);
  } finally { await page.close(); }
});
