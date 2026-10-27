import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "@playwright/test";
import { defaultTabs } from "../../apps/desktop/src/renderer/shell/workbench/tab-model";
import { nativeWorkbenchTabId } from "../design-native-workbench.mjs";

// Execute the driver as Node does on the Mac. Vite's SSR transform rewrites
// dynamic imports inside callbacks that the driver serializes into Chromium.
const { prepareNativeWorkspaceCatalog } = createRequire(import.meta.url)("../design-native-workbench.mjs") as {
  prepareNativeWorkspaceCatalog(page: Page, workspaces: Array<{ folder: string; workspaceId: string }>, timeout?: number): Promise<void>;
};

describe("native qualification workbench navigation", () => {
  it("activates generated Files and Design IDs across two workspaces", () => {
    const first = defaultTabs();
    const second = defaultTabs();
    for (const type of ["files", "design"]) {
      const a = nativeWorkbenchTabId(first, type);
      const b = nativeWorkbenchTabId(second, type);
      expect(first.tabs.find(tab => tab.id === a)?.type).toBe(type);
      expect(second.tabs.find(tab => tab.id === b)?.type).toBe(type);
      expect(a).not.toBe(b);
      expect(nativeWorkbenchTabId(first, type)).toBe(a);
    }
  });

  it("uses the fixed Files home when another file tab is open", () => {
    const scope = defaultTabs();
    const home = scope.tabs.find(tab => tab.type === "files")!;
    scope.tabs.unshift({ id: "other-file", type: "files", title: "Other file" });
    expect(nativeWorkbenchTabId(scope, "files")).toBe(home.id);
  });

  it("refuses missing or ambiguous destinations instead of inventing tabs", () => {
    expect(() => nativeWorkbenchTabId({ tabs: [] }, "design")).toThrow();
    expect(() => nativeWorkbenchTabId({ tabs: [
      { id: "a", type: "design" }, { id: "b", type: "design" },
    ] }, "design")).toThrow();
  });
});

describe("native restart workspace catalog readiness", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function fixture(page: Page, row = { id: "saved-id", path: "/fixture" }, held = false, latePublication = false) {
    await page.route("http://native-qualification.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const project = pathname.endsWith("projects-store.ts");
      const workspace = pathname.endsWith("use-projects.ts");
      const body = project ? `
        export async function syncProjectsToEngine() {
          document.body.dataset.sync = 'started';
          ${held ? "await new Promise(resolve => document.addEventListener('release-projects', resolve, {once:true}));" : ""}
          document.body.dataset.sync = 'complete';
        }
        export function loadProjects() { return document.body.dataset.sync === 'complete'
          ? [{repoRoot:'/fixture', repoSlug:'saved-slug'}] : []; }
      ` : workspace ? `
        export async function reloadWorkspacesFor(slug) {
          if (document.body.dataset.sync !== 'complete') throw new Error('Project identity was not ready');
          document.body.dataset.reading = slug;
          ${held ? "await new Promise(resolve => document.addEventListener('release-rows', resolve, {once:true}));" : ""}
          ${latePublication ? "setTimeout(() => { document.body.dataset.rows = 'ready'; }, 120);" : "document.body.dataset.rows = 'ready';"}
        }
        export function peekWorkspacesFor(slug) { return document.body.dataset.rows === 'ready'
          && slug === 'saved-slug' ? [${JSON.stringify(row)}] : []; }
      ` : "<!doctype html><body>Connected bridge</body>";
      await route.fulfill({ status: 200, contentType: project || workspace ? "text/javascript" : "text/html", body });
    });
    await page.goto("http://native-qualification.test/");
  }

  it("waits for project recovery and exact workspace rows before allowing navigation", async () => {
    const page = await browser.newPage();
    try {
      await fixture(page, undefined, true);
      let finished = false;
      const pending = prepareNativeWorkspaceCatalog(page, [{ folder: "/fixture", workspaceId: "saved-id" }])
        .then(() => { finished = true; }, (error: Error) => error.message);
      await page.evaluate(() => document.body.innerText);
      expect(finished).toBe(false);
      await expect.poll(() => page.locator("body").getAttribute("data-sync")).toBe("started");
      await page.evaluate(() => document.dispatchEvent(new Event("release-projects")));
      await expect.poll(() => page.locator("body").getAttribute("data-reading")).toBe("saved-slug");
      expect(finished).toBe(false);
      await page.evaluate(() => document.dispatchEvent(new Event("release-rows")));
      expect(await pending).toBeUndefined();
      expect(finished).toBe(true);
    } finally { await page.close(); }
  });

  it("waits for a newer catalog generation when the boot refresh supersedes the requested read", async () => {
    const page = await browser.newPage();
    try {
      await fixture(page, undefined, false, true);
      await prepareNativeWorkspaceCatalog(page, [{ folder: "/fixture", workspaceId: "saved-id" }], 2_000);
      expect(await page.locator("body").getAttribute("data-rows")).toBe("ready");
    } finally { await page.close(); }
  });

  it.each([
    { id: "replacement-id", path: "/fixture" },
    { id: "saved-id", path: "/other-fixture" },
  ])("rejects a wrong saved workspace instead of creating a replacement: %j", async row => {
    const page = await browser.newPage();
    try {
      await fixture(page, row);
      await expect(prepareNativeWorkspaceCatalog(page, [{ folder: "/fixture", workspaceId: "saved-id" }], 150))
        .rejects.toThrow("Exact native fixture workspace did not hydrate");
    } finally { await page.close(); }
  });
});
