import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { PLACEMENTS, buildEditableDiffFixture, lineBox, mountEditableDiff } from "./editable-diff-browser-fixture";

const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1};`);
const draft = [...lines.slice(0, 4), "line 5 changed;", ...lines.slice(5)].join("\n") + "\n";
const patch = [
  "diff --git a/file.ts b/file.ts",
  "--- a/file.ts",
  "+++ b/file.ts",
  "@@ -1,12 +1,12 @@",
  ...lines.slice(0, 4).map((line) => ` ${line}`),
  "-line 5;",
  "+line 5 changed;",
  ...lines.slice(5).map((line) => ` ${line}`),
  "",
].join("\n");

declare global { interface Window { diffFixture: { value: string } } }

let browser: Browser;
let source: string;
beforeAll(async () => {
  source = await buildEditableDiffFixture(patch, draft);
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); });

describe.each(PLACEMENTS)("editable diff selection (%s)", (_placement, cwd) => {
  it("paints a dragged selection over context and changed rows", async () => {
    const page = await browser.newPage();
    try {
      await mountEditableDiff(page, source, cwd);
      const from = await lineBox(page, 2), to = await lineBox(page, 7);
      await page.mouse.move(from.x + 40, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
      await page.mouse.up();
      const painted = await page.evaluate(() => {
        const root = [...document.querySelectorAll("*")].find((element) => element.shadowRoot)!.shadowRoot!;
        const row = getComputedStyle(root.querySelector('[data-line="3"]')!).backgroundColor;
        const ranges = [...root.querySelectorAll("[data-selection-range]")].map((range) => getComputedStyle(range).backgroundColor);
        return { row, ranges };
      });
      expect(painted.ranges.length).toBeGreaterThan(0);
      for (const color of painted.ranges) {
        expect(color).not.toMatch(/, 0\)$/);
        expect(color).not.toBe(painted.row);
      }
    } finally { await page.close(); }
  });

  it("keeps whole lines selected while dragging down the line numbers", async () => {
    const page = await browser.newPage();
    try {
      await mountEditableDiff(page, source, cwd);
      const number = (line: number) => page.evaluate((line) => {
        const root = [...document.querySelectorAll("*")].find((element) => element.shadowRoot)!.shadowRoot!;
        const cell = [...root.querySelectorAll<HTMLElement>(`[data-column-number="${line}"]`)].find((element) => element.dataset.lineType !== "change-deletion")!;
        const { x, y, width, height } = cell.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      }, line);
      const from = await number(2), to = await number(7);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      const rows = () => page.evaluate(() => {
        const root = [...document.querySelectorAll("*")].find((element) => element.shadowRoot)!.shadowRoot!;
        return root.querySelectorAll("[data-selection-range]").length;
      });
      await expect.poll(rows).toBeGreaterThanOrEqual(6);
      await page.mouse.up();
      await expect.poll(rows).toBeGreaterThanOrEqual(6);
      await page.keyboard.type("x");
      expect(await page.evaluate(() => window.diffFixture.value)).toBe(`line 1;\nx${lines.slice(7).map((line) => `\n${line}`).join("")}\n`);
    } finally { await page.close(); }
  });

  it("copies text selected inside a removed line, and leaves removed lines out of a drag across them", async () => {
    const page = await browser.newPage();
    try {
      await mountEditableDiff(page, source, cwd);
      const removed = await page.evaluate(() => {
        const root = [...document.querySelectorAll("*")].find((element) => element.shadowRoot)!.shadowRoot!;
        const { x, y, height } = root.querySelector('[data-line-type="change-deletion"][data-line]')!.getBoundingClientRect();
        return { x, y: y + height / 2 };
      });
      const copy = () => page.evaluate(() => {
        const root = [...document.querySelectorAll("*")].find((element) => element.shadowRoot)!.shadowRoot!;
        const data = new DataTransfer();
        (root.activeElement ?? root.querySelector("[contenteditable]"))!.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
        return data.getData("text/plain");
      });
      const selectRemoved = async () => {
        await page.mouse.move(removed.x + 4, removed.y);
        await page.mouse.down();
        await page.mouse.move(removed.x + 300, removed.y, { steps: 6 });
        await page.mouse.up();
      };
      await selectRemoved();
      expect(await copy()).toBe("line 5;");

      const from = await lineBox(page, 4), to = await lineBox(page, 6);
      await page.mouse.move(from.x + 4, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + 300, to.y + to.height / 2, { steps: 6 });
      await page.mouse.up();
      expect(await copy()).toBe("line 4;\nline 5 changed;\nline 6;");

      // A new selection inside the removed line replaces the one before it.
      await selectRemoved();
      expect(await copy()).toBe("line 5;");
    } finally { await page.close(); }
  });

  it("cuts the lines a line-number drag selects after removed text was selected", async () => {
    const page = await browser.newPage();
    try {
      await mountEditableDiff(page, source, cwd);
      await selectRemovedText(page);
      const from = await lineNumber(page, 2), to = await lineNumber(page, 4);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await page.mouse.up();
      expect(await clipboard(page, "cut")).toBe("line 2;\nline 3;\nline 4;");
      expect(await page.evaluate(() => window.diffFixture.value)).toBe(`line 1;\n\nline 5 changed;${lines.slice(5).map((line) => `\n${line}`).join("")}\n`);
    } finally { await page.close(); }
  });

  it("keeps a removed-text selection when it is right-clicked for Copy", async () => {
    const page = await browser.newPage();
    try {
      await mountEditableDiff(page, source, cwd);
      const removed = await selectRemovedText(page);
      await page.mouse.click(removed.x + 20, removed.y, { button: "right" });
      expect(await clipboard(page, "copy")).toBe("line 5;");
    } finally { await page.close(); }
  });
});

async function lineNumber(page: Page, line: number) {
  return page.evaluate((line) => {
    const root = document.querySelector("diffs-container")!.shadowRoot!;
    const cell = [...root.querySelectorAll<HTMLElement>(`[data-column-number="${line}"]`)].find((element) => element.dataset.lineType !== "change-deletion")!;
    const { x, y, width, height } = cell.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  }, line);
}

async function selectRemovedText(page: Page) {
  const removed = await page.evaluate(() => {
    const root = document.querySelector("diffs-container")!.shadowRoot!;
    const { x, y, height } = root.querySelector('[data-line-type="change-deletion"][data-line]')!.getBoundingClientRect();
    return { x, y: y + height / 2 };
  });
  await page.mouse.move(removed.x + 4, removed.y);
  await page.mouse.down();
  await page.mouse.move(removed.x + 300, removed.y, { steps: 6 });
  await page.mouse.up();
  return removed;
}

/** What the editor itself puts on the clipboard for a copy or cut. */
function clipboard(page: Page, type: "copy" | "cut") {
  return page.evaluate((type) => {
    const root = document.querySelector("diffs-container")!.shadowRoot!;
    const data = new DataTransfer();
    (root.activeElement ?? root.querySelector("[contenteditable]"))!.dispatchEvent(new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true, composed: true }));
    return data.getData("text/plain");
  }, type);
}
