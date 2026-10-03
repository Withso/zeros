import { expect } from "@playwright/test";

/** Exercise the real Inspector with a delayed bridge reply. Closing a surface
 * or replacing its directory must revoke an outstanding browser-open intent. */
export async function runDesignPreviewSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`);
  await expect(page.locator("[data-design-inspector]")).toBeVisible();
  await page.evaluate(async () => {
    // Reuse the harness's exact Vite module instances, including its cache key.
    const dependency = async (file) => {
      const url = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname.endsWith(`/${file}.js`))?.name;
      if (!url) throw new Error(`Harness dependency was not loaded: ${file}`);
      return (await import(url)).default;
    };
    const React = await dependency("react");
    const { createRoot } = await dependency("react-dom_client");
    const { DesignInspector } = await import("/apps/desktop/src/renderer/features/design-workspace/design-inspector.tsx");
    const { TooltipProvider } = await import("/apps/desktop/src/renderer/shared/ui/primitives/tooltip.tsx");
    const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    const workspaceId = "preview-race";
    const container = document.createElement("div");
    container.dataset.previewRace = "";
    container.style.cssText = "position:fixed;inset:0 auto 0 0;width:320px;z-index:10;background:white";
    document.body.append(container);
    let root = createRoot(container);
    let settle;
    const opened = [];
    window.open = (url) => { opened.push(url); return null; };
    const bridge = getActiveBridge();
    const request = bridge.request.bind(bridge);
    bridge.request = (message) => message.op === "design.verification.open"
      ? new Promise(resolve => { settle = resolve; }) : request(message);
    const render = () => root.render(React.createElement(React.StrictMode, null,
      React.createElement(TooltipProvider, null, React.createElement(DesignInspector, {
        workspaceId, folder: "/design/preview-race", active: true,
        frame: { file: "phone.html", frameId: "frame-a", title: "Phone", width: 390, height: 844, x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion: "a".repeat(24) },
        frameSelected: true, selectedNodeId: null, selectedNodeIds: [], details: null, lint: null,
        canvasBackground: "white", onCanvasBackgroundChange() {}, motionTimelineOpen: false,
        motionProperties: [], onOpenMotionTimeline() {}, zoomActionsRef: { current: null },
      }))));
    const directory = (id) => useDesignWorkspaceUiStore.getState().bindDirectory(workspaceId, id);
    window.__designPreviewRace = {
      opened, directory,
      pending: () => !!settle,
      unmount: () => root.unmount(),
      mount: () => { root = createRoot(container); render(); },
      resolve: async (overrides = {}) => {
        const complete = settle; settle = undefined;
        complete({ type: "WORKSPACE_RESPONSE", result: {
          reference: { version: 1, workspaceId, directoryId: "directory-a", frame: "phone.html", frameId: "frame-a", revision: "a".repeat(24), ...overrides },
          previewUrl: "http://127.0.0.1:12345/preview/phone.html/",
        } });
        await new Promise(resolve => setTimeout(resolve, 0));
      },
    };
    directory("directory-a"); render();
  });
  const open = page.locator("[data-preview-race]").getByRole("button", { name: "Open preview", exact: true });
  const request = async () => {
    await open.click();
    await expect.poll(() => page.evaluate(() => window.__designPreviewRace.pending())).toBe(true);
  };
  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve());
  await expect.poll(() => page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(1);
  check("Open preview opens the selected frame through the shared bridge", true);

  await request();
  await page.evaluate(() => window.__designPreviewRace.directory("directory-b"));
  await page.evaluate(() => window.__designPreviewRace.resolve());
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(1);
  check("replacing a Design directory cancels a pending preview open", true);

  await page.evaluate(() => window.__designPreviewRace.directory("directory-a"));
  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve({ workspaceId: "different-workspace" }));
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(1);
  check("a mismatched preview response cannot open another workspace", true);

  await request();
  await page.evaluate(() => window.__designPreviewRace.unmount());
  await page.evaluate(() => window.__designPreviewRace.resolve());
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(1);
  await page.evaluate(() => window.__designPreviewRace.mount());
  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve());
  await expect.poll(() => page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(2);
  check("unmount cancels a pending preview and remount can open a new one", true);
}
