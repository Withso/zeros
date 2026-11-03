import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

let browser: Browser;
let server: ViteDevServer;
let origin: string;
let cache: string;
const organizationId = "11111111-1111-4111-8111-111111111111";
const cloud = `cloud://${organizationId}/22222222-2222-4222-8222-222222222222`;

beforeAll(async () => {
  const directory = path.resolve("node_modules/.cache");
  await mkdir(directory, { recursive: true });
  cache = await mkdtemp(path.join(directory, "cloud-capacity-boot-"));
  server = await createServer({
    mode: "ui-smoke", cacheDir: cache, logLevel: "error",
    define: { "import.meta.env.VITE_CONTROL_PLANE_URL": JSON.stringify("https://api.example.test") },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing browser fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

async function seedNavigation(page: Page, folder: string, organization: string | null) {
  await page.addInitScript(({ folder, organization }) => {
    if (window.top !== window) return;
    localStorage.setItem("zeros:ui-state:v1", JSON.stringify({
      activePage: "workspace", lastWorkspaceFolder: folder, newAgentFolder: folder,
    }));
    localStorage.setItem("zeros-team:active-id", JSON.stringify(organization));
  }, { folder, organization });
}

async function blankPage() {
  const page = await browser.newPage();
  const html = await server.transformIndexHtml("/boot-fixture.html", "<!doctype html><html><head></head><body></body></html>");
  await page.route(`${origin}/boot-fixture.html`, route => route.fulfill({ contentType: "text/html", body: html }));
  return page;
}

describe("BridgeProvider cold imports", () => {
  it.each([
    ["Local", "/fixture/personal/worktree", null],
    ["organization-local", "/fixture/organization/worktree", organizationId],
    ["cloud", cloud, organizationId],
  ])("loads the real composer entry with stored %s navigation", async (_placement, folder, organization) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await seedNavigation(page, folder!, organization);
      await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-mode.html`, { waitUntil: "networkidle" });
      expect(errors).toEqual([]);
      expect(await page.getByRole("button", { name: "Add attachment or link a workspace", exact: true }).count()).toBe(1);
    } finally { await page.close(); }
  }, 60_000);

  it("restores the sidebar's persisted legacy filter on a cold load", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-app-sidebar.html?filter=active`, { waitUntil: "networkidle" });
      expect(await page.evaluate("window.appSidebarState().filter")).toBe("ungrouped");
    } finally { await page.close(); }
  }, 60_000);

  it("loads the production app entry with stored navigation", async () => {
    const page = await blankPage();
    try {
      await seedNavigation(page, cloud, organizationId);
      await page.goto(`${origin}/boot-fixture.html`);
      // Keep native browser imports out of Vitest's SSR transform.
      const result = await page.evaluate(`(async () => {
        const { AppShell } = await import("/apps/desktop/src/renderer/app-shell.tsx");
        const { selectActiveFolder, useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
        return { component: typeof AppShell, folder: selectActiveFolder(useWorkspaceStore.getState()) };
      })()`);
      expect(result).toEqual({ component: "function", folder: cloud });
    } finally { await page.close(); }
  }, 60_000);

  it("imports the selection accessor alone and reads the current store through A → B → A", async () => {
    const page = await blankPage();
    const other = cloud.replace(organizationId, "33333333-3333-4333-8333-333333333333");
    try {
      await seedNavigation(page, cloud, organizationId);
      await page.goto(`${origin}/boot-fixture.html`, { waitUntil: "networkidle" });
      const scripts: string[] = [];
      page.on("request", request => {
        if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
      });
      expect(await page.evaluate(`(async () => {
        const { getActiveWorkspaceFolder } = await import("/apps/desktop/src/renderer/state/active-workspace-folder.ts");
        return getActiveWorkspaceFolder();
      })()`)).toBeNull();
      expect(scripts).toEqual(["/apps/desktop/src/renderer/state/active-workspace-folder.ts"]);
      const selections = await page.evaluate(`(async () => {
        const { getActiveWorkspaceFolder } = await import("/apps/desktop/src/renderer/state/active-workspace-folder.ts");
        const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
        const first = getActiveWorkspaceFolder();
        const other = first.replace("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333");
        const results = [first];
        for (const folder of [other, first, "/fixture/personal", "/fixture/organization", null]) {
          useWorkspaceStore.setState({ activeChatId: null, newAgentFolder: folder, lastWorkspaceFolder: folder });
          results.push(getActiveWorkspaceFolder());
        }
        return results;
      })()`);
      expect(selections).toEqual([cloud, other, cloud, "/fixture/personal", "/fixture/organization", null]);
    } finally { await page.close(); }
  }, 60_000);
});
