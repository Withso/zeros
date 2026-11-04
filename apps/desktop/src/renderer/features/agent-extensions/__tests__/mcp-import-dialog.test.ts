import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const component = readFileSync(new URL("../mcp-import-dialog.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("mcp-import-dialog.tsx", component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const boundaries = new Set([
  "../../platform/bridge/use-bridge", "../../state/use-projects", "../../platform/bridge/workspace-bridge",
  "../settings/use-settings", "../../shared/ui/primitives/elements",
]);
const source = ast.statements.filter(node => !ts.isImportDeclaration(node) ||
  !boundaries.has((node.moduleSpecifier as ts.StringLiteral).text)).map(node => node.getText(ast)).join("\n");
const script = buildSync({
  stdin: { resolveDir: path.resolve("apps/desktop/src/renderer/features/agent-extensions"), loader: "tsx", contents: `
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { TooltipProvider } from "../../shared/ui/primitives/tooltip";
    const f = window.fixture = {
      open: true, doc: {}, sources: [], attempts: [], errors: [], successes: [], closed: 0,
      failName: null, hold: false, release: null,
    };
    const bridge = { status: "connected", executionIdentity: { kind: "local" } };
    const useBridge = () => bridge;
    const useBridgeStatus = () => bridge.status;
    const useProjects = () => ({ projects: [{ repoRoot: "/personal/repo" }, { repoRoot: "/organization/repo" }] });
    const useSettingsLayer = () => ({ layer: { doc: f.doc }, loading: false, error: null, readError: null, refresh: () => f.render() });
    const bridgeMcpScanNative = async () => structuredClone(f.sources);
    const bridgeMcpResolveComposed = async () => structuredClone(f.doc.mcp?.servers ?? []);
    const bridgeSettingsRead = async () => ({ path: "/fixture/settings.toml", doc: structuredClone(f.doc) });
    const primeSettingsLayer = (_layer, _root, result) => { f.doc = result.doc; f.render(); };
    const workspaceOp = async (_bridge, op, params) => {
      if (op !== "mcp.saveServer" || params.layer !== "user" || params.repoRoot) throw new Error("Unexpected save target");
      f.attempts.push({ name: params.server.name, id: params.server.credential_id });
      if (f.hold) await new Promise(resolve => f.release = resolve);
      if (params.server.name === f.failName) throw new Error("Fixture vault unavailable");
      const servers = f.doc.mcp?.servers ?? [];
      const next = params.previous ? servers.map(row => row.credential_id === params.previous.credential_id ? params.server : row)
        : [...servers, params.server];
      f.doc = { mcp: { servers: next } };
      return { path: "/fixture/settings.toml", doc: structuredClone(f.doc) };
    };
    const toast = { error: message => { f.errors.push(message); }, success: message => { f.successes.push(message); } };
    ${source}
    const root = createRoot(document.querySelector("#app"));
    f.render = () => flushSync(() => root.render(<TooltipProvider><McpImportDialog open={f.open}
      onClose={() => { f.closed++; f.open = false; f.render(); }} /></TooltipProvider>));
  ` },
  alias: { "@": path.resolve("apps/desktop/src") },
  bundle: true, write: false, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent",
}).outputFiles[0].text;

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage();
  await page.route("http://127.0.0.1:6217/", route => route.fulfill({ contentType: "text/html", body: '<div id="app"></div>' }));
  await page.goto("http://127.0.0.1:6217/");
  await page.addScriptTag({ content: script });
});
afterEach(async () => { await page?.close(); });

it("labels duplicate project declarations and requires an explicit distinct import name", async () => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.sources = ["/personal/repo", "/organization/repo"].map((root, index) => ({
      source: "claude-project:" + root, label: "Claude Code (project) · " + root, path: "/fixture/.claude.json", exists: true,
      servers: [{ name: "database", transport: "stdio", command: "fixture-" + index }],
    }));
    f.render();
  });
  const submit = page.getByRole("button", { name: "Import 2", exact: true });
  await submit.waitFor();
  expect(await submit.isDisabled()).toBe(true);
  expect(await page.getByRole("heading", { name: "Claude Code (project) · /personal/repo", exact: true }).count()).toBe(1);
  expect(await page.getByRole("heading", { name: "Claude Code (project) · /organization/repo", exact: true }).count()).toBe(1);
  const rename = page.getByRole("textbox", { name: "Import name for database from Claude Code (project) · /organization/repo" });
  await rename.fill("organization-database");
  expect(await submit.isEnabled()).toBe(true);
  await submit.click();
  await page.waitForFunction(() => (window as any).fixture.closed === 1);
  expect(await page.evaluate(() => (window as any).fixture.doc.mcp.servers.map((server: any) => server.name))).toEqual(["database", "organization-database"]);
});

it("allows a discovered name already used in Zeros to be imported under a different name", async () => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.doc = { mcp: { servers: [{ name: "database", transport: "stdio", command: "saved" }] } };
    f.sources = [{ source: "cursor", label: "Cursor", exists: true, path: "/fixture/mcp.json", servers: [{ name: "database", transport: "stdio", command: "discovered" }] }];
    f.render();
  });
  const row = page.getByRole("checkbox", { name: /database.*discovered/ });
  await row.click();
  const submit = page.getByRole("button", { name: "Import 1", exact: true });
  expect(await submit.isDisabled()).toBe(true);
  await page.getByRole("textbox", { name: "Import name for database from Cursor" }).fill("discovered-database");
  await submit.click();
  await page.waitForFunction(() => (window as any).fixture.closed === 1);
  expect(await page.evaluate(() => (window as any).fixture.doc.mcp.servers.map((server: any) => server.command))).toEqual(["saved", "discovered"]);
});

it("keeps failed rows selected and retries only those rows with their original credential identity", async () => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.failName = "two";
    f.sources = [{ source: "cursor", label: "Cursor", exists: true, path: "/fixture/mcp.json", servers: ["one", "two"].map(name => ({ name, transport: "stdio", command: name, env: { API_KEY: "fixture-" + name } })) }];
    f.render();
  });
  await page.getByRole("button", { name: "Import 2", exact: true }).click();
  await page.waitForFunction(() => (window as any).fixture.errors.length === 1);
  expect(await page.getByRole("dialog").isVisible()).toBe(true);
  expect(await page.getByRole("checkbox", { name: /one.*Imported/ }).isDisabled()).toBe(true);
  expect(await page.getByRole("checkbox", { name: /stdio.*two/ }).isChecked()).toBe(true);
  expect(await page.evaluate(() => (window as any).fixture.successes)).toEqual([]);
  await page.evaluate(() => { (window as any).fixture.failName = null; });
  await page.getByRole("button", { name: "Import 1", exact: true }).click();
  await page.waitForFunction(() => (window as any).fixture.closed === 1);
  const attempts = await page.evaluate(() => (window as any).fixture.attempts);
  expect(attempts.map((attempt: { name: string }) => attempt.name)).toEqual(["one", "two", "two"]);
  expect(attempts[1].id).toBe(attempts[2].id);
});

it("does not continue a held batch or close a newly opened dialog after its owner retires", async () => {
  await page.evaluate(() => {
    const f = (window as any).fixture;
    f.hold = true;
    f.sources = [{ source: "cursor", label: "Cursor", exists: true, path: "/fixture/mcp.json", servers: ["one", "two"].map(name => ({ name, transport: "stdio", command: name })) }];
    f.render();
  });
  await page.getByRole("button", { name: "Import 2", exact: true }).click();
  await page.waitForFunction(() => (window as any).fixture.release !== null);
  await page.evaluate(() => { const f = (window as any).fixture; f.open = false; f.render(); });
  await page.evaluate(() => { const f = (window as any).fixture; f.open = true; f.render(); });
  await page.evaluate(() => { const f = (window as any).fixture; f.hold = false; f.release(); });
  await page.waitForFunction(() => (window as any).fixture.doc.mcp?.servers.length === 1);
  expect(await page.evaluate(() => (window as any).fixture.attempts.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).fixture.closed)).toBe(0);
  expect(await page.evaluate(() => (window as any).fixture.successes)).toEqual([]);
  expect(await page.getByRole("dialog").isVisible()).toBe(true);
});
