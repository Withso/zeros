import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");
const shell = "apps/desktop/src/renderer/shell/";

describe("native window header wiring", () => {
  it.each([
    ["app-sidebar.tsx", /<div\s[^>]*className="flex h-10 shrink-0 items-center gap-1 pr-2"[^>]*>/],
    ["sidebar-toggle.tsx", /<div\s[^>]*data-collapsed-sidebar-controls=""[^>]*>/],
    ["workbench/workbench-pane.tsx", /<div\s[^>]*data-testid="workbench-header"[^>]*>/],
    ["conversation/conversation-header.tsx", /<div\s[^>]*className=\{TOPBAR_CLS\}[^>]*>/g],
    ["../features/settings/settings-page.tsx", /<div\s[^>]*className="flex h-10 shrink-0 items-center justify-between pr-3"[^>]*>/],
  ])("uses native regions in %s, including headers mounted after loading", (path, pattern) => {
    const text = source(shell + path);
    const headers = text.match(pattern);
    expect(headers?.length).toBeGreaterThan(0);
    for (const header of headers ?? []) expect(header).toContain("data-tauri-drag-region");
    // An effect over a ref only attaches to the initial DOM node. Native CSS
    // must also own headers revealed after setup or replaced by navigation.
    expect(text).not.toContain("useCustomWindowDrag");
  });
});

describe("native window hit regions", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => { await browser?.close(); });

  async function fixture() {
    await page.setContent(`
      <div id="header" data-tauri-drag-region>
        <span>Workspace</span><button>Toggle</button><button disabled>Disabled</button>
        <a href="#">Open</a><input><textarea></textarea><select></select><label>Label</label>
        <details><summary>Details</summary></details>
        <div role="tab"><svg><path d="M0 0h1" /></svg>Changes</div>
        <div role="button">Action</div><div role="combobox">Picker</div>
        <div contenteditable="true">Rename</div><div data-no-window-drag>Custom control</div>
      </div>
      <div id="portals"></div>
    `);
    await page.addStyleTag({ content: source("styles/global/platform.css") });
  }
  const region = () => page.locator("#header").evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-app-region"));

  it("leaves empty header space native while excluding interactive controls", async () => {
    await fixture();
    expect(await region()).toBe("drag");
    const controls = await page.locator("#header").evaluate(el =>
      Array.from(el.querySelectorAll("button, a, input, textarea, select, label, summary, [role], [contenteditable], [data-no-window-drag]"))
        .map(node => ({ control: node.outerHTML, region: getComputedStyle(node).getPropertyValue("-webkit-app-region") })),
    );
    for (const { control, region: value } of controls) expect(value, control).toBe("no-drag");
  });

  it.each(["dialog", "alertdialog", "menu", "listbox"])(
    "lets an open %s receive outside clicks on chrome and restores native behavior on close",
    async role => {
      await fixture();
      await page.locator("#portals").evaluate((el, role) => {
        const overlay = document.createElement("div");
        overlay.setAttribute("role", role);
        overlay.dataset.state = "open";
        el.append(overlay);
      }, role);
      expect(await region()).toBe("no-drag");
      await page.locator("#portals > div").evaluate(el => { el.dataset.state = "closed"; });
      expect(await region()).toBe("drag");
      await page.locator("#portals").evaluate(el => el.replaceChildren());
      expect(await region()).toBe("drag");
    },
  );

  it("keeps titlebar behavior while a tooltip is visible", async () => {
    await fixture();
    await page.locator("#portals").evaluate(el => {
      el.innerHTML = '<div role="tooltip" data-state="open">Workspace name</div>';
    });
    expect(await region()).toBe("drag");
  });

  it("lets the conditionally mounted composer image preview cover native chrome", async () => {
    await fixture();
    // The image lightbox is a portal with role=dialog, not a Radix root. It has
    // no data-state, and its top-right Close button overlaps the tab header.
    await page.locator("#portals").evaluate(el => {
      el.innerHTML = '<div role="dialog" aria-modal="true"><button>Close preview</button></div>';
    });
    expect(await region()).toBe("no-drag");
    await page.locator("#portals").evaluate(el => el.replaceChildren());
    expect(await region()).toBe("drag");
  });

  it.each(["hidden", "inert", 'aria-hidden="true"', 'data-state="closed"'])(
    "ignores overlays retained under a %s surface",
    async attribute => {
      await fixture();
      await page.locator("#portals").evaluate((el, attribute) => {
        el.innerHTML = `<section ${attribute}><div role="dialog" data-state="open"></div></section>`;
      }, attribute);
      expect(await region()).toBe("drag");
    },
  );
});
