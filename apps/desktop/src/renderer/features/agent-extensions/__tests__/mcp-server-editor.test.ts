import path from "node:path";
import { buildSync } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const script = buildSync({
  stdin: { resolveDir: path.resolve("apps/desktop/src/renderer/features/agent-extensions"), loader: "tsx", contents: `
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { TooltipProvider } from "../../shared/ui/primitives/tooltip";
    import { Toaster } from "../../shared/ui/primitives/elements";
    import { McpServerEditor } from "./mcp-server-editor";
    const f = window.fixture = {
      initial: null, probes: 0, saves: 0, connects: 0, failSave: null, checks: 0,
      result: { status: "connected", stages: [], toolCount: 2, tools: ["search", "fetch"] },
    };
    const probe = async () => { f.probes++; return structuredClone(f.result); };
    const onSave = async () => { f.saves++; if (f.failSave) throw new Error(f.failSave); return structuredClone(f.initial); };
    let checking = false;
    new MutationObserver(() => {
      const next = document.body.textContent.includes("Checking connection…");
      if (next && !checking) f.checks++;
      checking = next;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    const root = createRoot(document.querySelector("#app"));
    f.render = () => flushSync(() => root.render(<TooltipProvider>
      <McpServerEditor initial={f.initial} target={{ identity: "fixture", organization: false, owner: "user", project: "all", projects: [] }}
        onSave={onSave} onBack={() => {}} probe={probe}
        savedConnection={{ status: "needs-connection", onConnect: async () => { f.connects++; } }} />
      <Toaster />
    </TooltipProvider>));
  ` },
  alias: { "@": path.resolve("apps/desktop/src") },
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent",
}).outputFiles[0].text;

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  await page.route("http://127.0.0.1:6217/", route => route.fulfill({ contentType: "text/html", body: '<div id="app"></div>' }));
  await page.goto("http://127.0.0.1:6217/");
  await page.addScriptTag({ content: script });
});
afterEach(async () => { await page?.close(); });

const fixture = (key: string) => page.evaluate(name => (window as any).fixture[name], key);
// Longer than the editor's automatic connection-check debounce.
const settle = () => page.clock.runFor(1_000);
async function open(initial: Record<string, unknown>, result?: Record<string, unknown>) {
  await page.evaluate(([server, probe]) => {
    const f = (window as any).fixture;
    f.initial = server;
    if (probe) f.result = probe;
    f.render();
  }, [initial, result] as const);
  await settle();
  await page.waitForFunction(() => (window as any).fixture.probes === 1 && !document.body.textContent?.includes("Checking connection…"));
}

it("treats an empty variable row as no change to a connected server", async () => {
  await open({ name: "docs", transport: "http", url: "https://mcp.example.test/mcp", credential_id: "docs-id" });
  await page.getByText("2 tools available.").waitFor();
  await page.getByRole("button", { name: "Add variable" }).click();
  await settle();
  expect(await fixture("probes")).toBe(1);
  expect(await page.getByText("2 tools available.").isVisible()).toBe(true);
  expect(await page.getByRole("switch", { name: "Allow search" }).count()).toBe(1);
  expect(await page.getByRole("button", { name: "Check connection" }).count()).toBe(1);
});

it("connects an unchanged sign-in server without saving when only an empty row was added", async () => {
  await open({ name: "flora", transport: "http", url: "https://agents.example.test/mcp", auth: "oauth", oauth_client_mode: "auto", credential_id: "flora-id" },
    { status: "needs-auth", stages: [{ stage: "transport", status: "needs-auth" }] });
  await page.getByRole("button", { name: "Add variable" }).click();
  await settle();
  expect(await page.getByRole("button", { name: "Save & connect" }).count()).toBe(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForFunction(() => (window as any).fixture.connects === 1);
  expect(await fixture("saves")).toBe(0);
  expect(await fixture("probes")).toBe(1);
});

it("keeps the settled connection check and one error toast across failed saves", async () => {
  const message = "This MCP server changed while you were editing. Reopen it to review the latest version.";
  await open({ name: "docs", transport: "http", url: "https://mcp.example.test/mcp", credential_id: "docs-id" });
  await page.evaluate(text => { (window as any).fixture.failSave = text; }, message);
  const checks = await fixture("checks");
  const save = page.getByRole("button", { name: "Save changes" });
  await save.click();
  await page.waitForFunction(() => (window as any).fixture.saves === 1);
  await expect.poll(() => save.isEnabled()).toBe(true);
  await save.click();
  await page.waitForFunction(() => (window as any).fixture.saves === 2);
  await expect.poll(() => save.isEnabled()).toBe(true);
  await settle();
  expect(await fixture("probes")).toBe(1);
  expect(await fixture("checks")).toBe(checks);
  expect(await page.locator('[data-sonner-toast]:not([data-removed="true"])').filter({ hasText: message }).count()).toBe(1);
  expect(await page.getByText("2 tools available.").isVisible()).toBe(true);
});
