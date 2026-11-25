import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");
const shell = "apps/desktop/src/renderer/shell/";

describe("native window header wiring", () => {
  it.each([
    ["app-sidebar.tsx", /<div\s[^>]*className="flex h-10 shrink-0 items-center gap-1 pr-3"[^>]*>/],
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

// Native hit-testing reads the computed app-region of the app's own Chromium.
// Playwright's Chromium is a different, usually older, build: Electron 45
// (Chromium 156) computed `-webkit-app-region: var(…)` as `none`, so the window
// could not be moved, while Playwright's Chromium 147 still passed. Every case
// therefore also runs in a real BrowserWindow of the installed Electron.
async function openChromium() {
  const browser = await chromium.launch();
  return { page: await browser.newPage(), close: () => browser.close() };
}

async function openElectron() {
  const root = mkdtempSync(join(tmpdir(), "zeros-window-chrome-"));
  const main = join(root, "main.cjs");
  writeFileSync(main, `
    const { app, BrowserWindow } = require("electron");
    app.setPath("userData", ${JSON.stringify(join(root, "user-data"))});
    app.whenReady().then(() => {
      new BrowserWindow({ show: false, titleBarStyle: "hiddenInset",
        webPreferences: { sandbox: true, contextIsolation: true } }).loadURL("about:blank");
    });
  `);
  const env = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined));
  const app = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as unknown as string,
    // Headless ozone needs no display server; the CI runner has none.
    args: [...(process.platform === "linux" ? ["--no-sandbox", "--ozone-platform=headless"] : []), main],
    env,
    timeout: 30_000,
  });
  return {
    page: await app.firstWindow(),
    close: async () => { await app.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

describe("app-region declarations", () => {
  it("never take var(), which Chromium 151+ computes as none", () => {
    const files = ["styles", "apps/desktop/src"].flatMap(dir =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter(file => file.endsWith(".css")).map(file => join(dir, file)));
    const declarations = files.flatMap(file => [...source(file).replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/(?:-webkit-)?app-region\s*:\s*[^;}]*/g)].map(match => `${file}: ${match[0]}`));
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) expect(declaration).not.toMatch(/var\(/);
  });
});

describe.each([
  ["Playwright Chromium", openChromium],
  ["the app's Electron", openElectron],
])("native window hit regions in %s", (_engine, open) => {
  let page: Page;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ page, close } = await open());
  }, 40_000);
  afterAll(async () => { await close?.(); });

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

  it("anchors each global :has() rule on the element it styles, so a change elsewhere restyles one element", () => {
    // `body:has(<overlay>) [data-tauri-drag-region]` styled body's descendants:
    // its argument cannot be narrowed (it looks under closed or hidden
    // surfaces), so every DOM change anywhere restyled the whole document. A
    // picture swap on a 1,000-frame Design page cost ~45 ms instead of ~3 ms.
    const css = source("styles/global/platform.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/([^{}]*:has\([^{}]*)\{/g)].map(match => match[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector.endsWith(")"), selector).toBe(true);
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
