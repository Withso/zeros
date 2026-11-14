import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const organizationId = "11111111-1111-4111-8111-111111111111";
const a = `cloud://${organizationId}/22222222-2222-4222-8222-222222222222`;
const b = `cloud://${organizationId}/33333333-3333-4333-8333-333333333333`;
let browser: Browser, source: string;

beforeAll(async () => {
  const root = path.resolve("apps/desktop/src/renderer");
  const mocks: Record<string, string> = {
    "platform/runtime": `export const isLocalDevelopment = () => true; export const isNativeRuntime = () => false;
      export const isExpectedElectron = () => false; export const isElectron = () => false; export const nativeInvoke = async () => null; export const nativeListen = async () => () => {};`,
    "features/auth/auth-token": `export const getAuthAccessToken = async () => null;`,
    "features/auth/auth-store": `export const getSession = async () => null; export const getStoredAuthUser = () => null;
      export const onAuthStateChange = () => () => {}; export const onStoredIdentityChange = () => () => {};`,
    "features/team/team-store": `export const getTeamStoreState = () => ({ me: null }); export const subscribeOrganizationSnapshots = () => () => {};`,
    "features/team/cloud-workspace-account-access": `export const hasCloudWorkspaceAccountAccess = () => window.cloudWake.access;`,
    "features/team/control-plane": `export class ControlPlaneError extends Error {}`,
    "platform/cloud-capability": `export const cloudWorkspaceCapability = async () => ({ enabled: true });`,
    "state/use-projects": `export const notifyProjectsChanged = () => {}; export const notifyWorkspacesChanged = () => {};
      export const pruneCloudWorkspaceCollections = () => {};`,
    "state/pending-workspaces": `export const clearWorkspaceSettling = () => {};`,
    "features/agent/sessions-store": `export const useSessionsStore = { getState: () => ({ removeSession: () => {} }) };`,
    "state/cloud-workspace-warmup": `export const warmCloudWorkspaceDestination = async () => {};`,
    "state/workbench-availability": `export const clearWorkbenchConnectionFailure = () => {};
      export const recordWorkbenchConnectionFailure = (...args) => window.cloudWake.failures.push(args);`,
    "state/store": `import { useSyncExternalStore } from "react";
      const f = window.cloudWake;
      const subscribe = cb => { f.selections.add(cb); return () => f.selections.delete(cb); };
      export const selectActiveFolder = state => state.folder;
      export const useWorkspaceStore = Object.assign(selector => useSyncExternalStore(subscribe, () => selector(f.state)),
        { getState: () => f.state, subscribe });`,
    "state/cloud-workspace-catalog": `const f = window.cloudWake;
      const key = t => "cloud://" + t.organizationId + "/" + t.workspaceId;
      export const cloudWorkspaceDocument = t => f.docs[key(t)];
      export const cloudCatalogGeneration = () => f.account;
      export const cloudWorkspaceOwnerGeneration = t => f.docs[key(t)]?.owner;
      export const cloudWorkspaceStopVersion = t => f.docs[key(t)]?.stopVersion ?? 0;
      export const cloudWorkspaceLifecycleTask = (t, op) => f.docs[key(t)]?.operation === op ? new Promise(() => {}) : undefined;
      export const canReadCloudWorkspace = d => !!d && !["deleting", "deleted"].includes(d.status);
      export const subscribeCloudWorkspaces = cb => { f.catalog.add(cb); return () => f.catalog.delete(cb); };
      export const subscribeCloudWorkspaceRows = () => () => {};
      export const cloudWorkspaceCatalogConfirmed = () => true;
      export const cloudCatalogNeedsFastRefresh = () => false;
      export const refreshCloudWorkspaceCatalog = async () => {};
      export const isCloudWorkspaceLifecyclePending = d => ["stopping", "waking"].includes(d?.status);
      export const manageCloudWorkspace = async () => {}; export const refreshCloudWorkspace = async () => {};`,
  };
  const result = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React, { useEffect, useRef } from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { EditorView } from "@codemirror/view";
      import { CloudWorkspaceLifecycle } from "./state/cloud-workspace-lifecycle";
      import { requestCloudWorkspaceOpen } from "./state/cloud-workspace-open-intent";
      import { useWorkspaceStore } from "./state/store";
      import { WorkspaceRuntimeClient } from "./platform/bridge/workspace-runtime-client";
      import { setActiveBridge } from "./platform/bridge/active-bridge";
      const f = window.cloudWake;
      const key = t => "cloud://" + t.organizationId + "/" + t.workspaceId;
      const bridge = new WorkspaceRuntimeClient({ workspaces: () => [], canAccess: t => !!f.docs[key(t)],
        identity: t => f.account + ":" + f.docs[key(t)]?.owner,
        canReuseForWork: t => f.docs[key(t)]?.status === "ready",
        open: (target, options) => new Promise(resolve => {
          const call = { key: key(target), options, resolve }; f.opens.push(call);
          call.finish = () => resolve({ scope: { ...target, root: "/workspace/repo", engineWorkspaceId: target.workspaceId },
            release: () => f.released.push(call.key), client: { status: "connected", on: () => () => {}, onStatusChange: () => () => {},
              request: async message => ({ type: "WORKSPACE_RESPONSE", op: message.op, result: { chats: [] } }) } });
        }) });
      setActiveBridge(bridge);
      function Fixture() {
        const state = useWorkspaceStore(s => s), editor = useRef(null);
        useEffect(() => {
          const view = new EditorView({ parent: editor.current });
          view.contentDOM.addEventListener("keydown", event => event.stopPropagation());
          return () => view.destroy();
        }, []);
        return <><CloudWorkspaceLifecycle /><button id="outside">Outside workspace</button>
          <div id="surface" data-cloud-workspace-surface={state.folder} aria-hidden={!state.active}>
            <textarea id="composer" aria-label="Composer" onKeyDown={event => event.stopPropagation()} />
            <div id="files" ref={editor} /><div id="empty" style={{ height: 50 }} />
            <div aria-hidden="true"><button id="retained">Retained hidden surface</button></div>
          </div></>;
      }
      const app = createRoot(document.querySelector("#app"));
      flushSync(() => app.render(<Fixture />));
      f.select = (folder, activePage = "workspace", active = true) => flushSync(() => {
        f.state = { folder, activePage, active }; for (const cb of f.selections) cb();
      });
      f.change = (folder, patch) => { Object.assign(f.docs[folder], patch); for (const cb of f.catalog) cb(); };
      f.navigate = folder => { f.select(folder); requestCloudWorkspaceOpen(folder); };
      f.retireAccount = () => { f.account++; for (const cb of f.catalog) cb(); };
      f.close = () => { flushSync(() => app.unmount()); bridge.dispose(); };
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"VITE_ZEROS_CHANNEL":"alpha"}' },
    plugins: [{ name: "cloud-runtime-boundaries", setup(builder) {
      builder.onResolve({ filter: /^\.\.?\// }, args => {
        const relative = path.relative(root, path.resolve(args.resolveDir, args.path)).replace(/\.tsx?$/, "");
        return mocks[relative] ? { path: relative, namespace: "cloud-runtime-boundaries" } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "cloud-runtime-boundaries" }, args => ({ contents: mocks[args.path], loader: "ts", resolveDir: root }));
    } }], logLevel: "silent",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });

async function fixture(folder = a): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://localhost/cloud-wake", route => route.fulfill({ contentType: "text/html", body: '<div id="app"></div>' }));
  await page.goto("http://localhost/cloud-wake");
  await page.evaluate(({ a, b, folder }) => {
    const doc = (owner: number) => ({ owner, status: "stopped", stopVersion: 0, capabilities: { canWrite: true }, generation: { number: 1 } });
    (window as any).cloudWake = { state: { folder, activePage: "workspace", active: true }, account: 1, access: true,
      docs: { [a]: doc(1), [b]: doc(2) }, selections: new Set(), catalog: new Set(), opens: [], failures: [], released: [] };
  }, { a, b, folder });
  await page.addScriptTag({ content: source });
  return page;
}
const calls = (page: Page) => page.evaluate(() => (window as any).cloudWake.opens.map((call: any) => ({ key: call.key, wake: call.options.wake, reason: call.options.reason, aborted: call.options.signal.aborted })));

it.each(["#composer", ".cm-content", "#empty"])("wakes immediately on a pointer press in %s and joins subsequent input", async selector => {
  const page = await fixture();
  try {
    await page.locator(selector).click();
    expect(await calls(page)).toEqual([{ key: a, wake: true, reason: "interaction", aborted: false }]);
    await page.locator("#composer").press("a");
    await page.locator(".cm-content").press("b");
    expect(await calls(page)).toHaveLength(1);
    expect(await page.locator(".cm-content").innerText()).toContain("b");
  } finally { await page.close(); }
});

it.each(["#composer", ".cm-content"])("captures typing in %s even when the child stops key propagation", async selector => {
  const page = await fixture();
  try {
    await page.locator("#outside").click();
    await page.keyboard.press("Tab");
    if (selector === ".cm-content") await page.keyboard.press("Tab");
    // Start a fresh stopped lifetime after focus entered through the workspace.
    await page.evaluate(() => { const f = (window as any).cloudWake; for (const call of f.opens) call.finish(); f.opens.length = 0; });
    await page.keyboard.press("x");
    expect(await calls(page)).toEqual([{ key: a, wake: true, reason: "interaction", aborted: false }]);
  } finally { await page.close(); }
});

it.each(["/personal/project", "/organization/project"])("leaves Local input alone in %s", async folder => {
  const page = await fixture(folder);
  try { await page.locator("#composer").fill("local draft"); await page.locator("#empty").click(); expect(await calls(page)).toEqual([]); }
  finally { await page.close(); }
});

it("does not wake for hover, synthetic input, outside input, hidden children or a retained workspace", async () => {
  const page = await fixture();
  try {
    await page.locator("#empty").hover();
    await page.locator("#empty").dispatchEvent("pointerdown");
    await page.locator("#composer").dispatchEvent("keydown", { key: "x" });
    await page.locator("#outside").click(); await page.keyboard.press("a");
    await page.locator("#retained").click();
    await page.evaluate(a => (window as any).cloudWake.select(a, "home", false), a);
    await page.locator("#empty").click();
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); }
});

it.each(["stopping", "archiving", "archived", "deleting", "deleted", "failed", "error", "stop", "archive", "delete"])("ignores interaction and navigation while %s owns the lifecycle", async status => {
  const page = await fixture();
  try {
    await page.evaluate(({ a, status }) => {
      const f = (window as any).cloudWake;
      f.change(a, ["stop", "archive", "delete"].includes(status) ? { operation: status } : { status });
    }, { a, status });
    await page.locator("#empty").click();
    await page.evaluate(a => (window as any).cloudWake.navigate(a), a);
    expect(await calls(page)).toEqual([]);
  } finally { await page.close(); }
});

it("retires pending input on A → B → A and account changes before another explicit interaction", async () => {
  const page = await fixture();
  try {
    await page.locator("#empty").click();
    await page.evaluate(({ a, b }) => { const f = (window as any).cloudWake; f.select(b); f.select(a); }, { a, b });
    expect(await calls(page)).toEqual([{ key: a, wake: true, reason: "interaction", aborted: true }]);
    await page.locator("#empty").click();
    await page.evaluate(() => (window as any).cloudWake.retireAccount());
    expect((await calls(page)).every((call: { aborted: boolean }) => call.aborted)).toBe(true);
    await page.locator("#empty").click();
    expect((await calls(page)).at(-1)).toEqual({ key: a, wake: true, reason: "interaction", aborted: false });
    expect(await calls(page)).toHaveLength(3);
  } finally { await page.close(); }
});

it("keeps an explicit workspace open as a single navigation intent", async () => {
  const page = await fixture("/personal/project");
  try {
    await page.evaluate(a => (window as any).cloudWake.navigate(a), a);
    expect(await calls(page)).toEqual([{ key: a, wake: true, reason: undefined, aborted: false }]);
    await page.locator("#empty").click();
    expect(await calls(page)).toHaveLength(1);
  } finally { await page.close(); }
});
