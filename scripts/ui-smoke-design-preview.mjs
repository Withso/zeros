import { expect } from "@playwright/test";

/** Exercise the real Inspector with a delayed bridge reply. Closing a surface
 * or replacing its directory must revoke an outstanding browser-open intent. */
export async function runDesignPreviewSmoke({ page, check }) {
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/apps/desktop/src/renderer/harnesses/harness-design-workspace.html`);
  await expect(page.locator("[data-design-inspector]")).toBeVisible();
  await page.evaluate(async () => {
    // Resource timings are bounded browser metadata, not runtime ownership.
    // Exercise the preview races even when no dependency entries are retained.
    performance.clearResourceTimings();
    // Reuse the module instances published before the harness mounts.
    const { React, createRoot, flushSync } = window.__zerosDesignHarnessRuntime;
    const { DesignInspector } = await import("/apps/desktop/src/renderer/features/design-workspace/design-inspector.tsx");
    const { TooltipProvider } = await import("/apps/desktop/src/renderer/shared/ui/primitives/tooltip.tsx");
    const { getActiveBridge } = await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts");
    const { useDesignWorkspaceUiStore } = await import("/apps/desktop/src/renderer/features/design-workspace/state/design-workspace-ui.ts");
    let workspaceId = "preview-race", folder = "/design/preview-race", active = true;
    const container = document.createElement("div");
    container.dataset.previewRace = "";
    container.style.cssText = "position:fixed;inset:0 auto 0 0;width:320px;z-index:10;background:white";
    document.body.append(container);
    let root = createRoot(container);
    let settle;
    let requestedWorkspace;
    const opened = [];
    window.open = (url) => { opened.push(url); return null; };
    const bridge = getActiveBridge();
    const request = bridge.request.bind(bridge);
    bridge.request = (message) => message.op === "design.verification.open"
      ? new Promise(resolve => { settle = resolve; requestedWorkspace = message.params.workspaceId; }) : request(message);
    // Commit fixture visibility/owner changes before settling a bridge reply.
    const render = () => flushSync(() => root.render(React.createElement(React.StrictMode, null,
      React.createElement(TooltipProvider, null, React.createElement(DesignInspector, {
        workspaceId, folder, active,
        frame: { file: "phone.html", frameId: "frame-a", title: "Phone", width: 390, height: 844, x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion: "a".repeat(24) },
        frameSelected: true, selectedNodeId: null, selectedNodeIds: [], details: null, lint: null,
        canvasBackground: "white", onCanvasBackgroundChange() {}, motionTimelineOpen: false,
        motionProperties: [], onOpenMotionTimeline() {}, zoomActionsRef: { current: null },
      })))));
    const directory = (id) => useDesignWorkspaceUiStore.getState().bindDirectory(workspaceId, id);
    const { useWorkspaceStore, workbenchScopeForFolder } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    const browserIntents = [];
    const dispatch = useWorkspaceStore.getState().dispatch;
    useWorkspaceStore.setState({ dispatch: action => {
      if (["ADD_WORKBENCH_TAB", "ACTIVATE_WORKBENCH_TAB"].includes(action.type)) browserIntents.push(action.scope);
      dispatch(action);
    } });
    const { acceptOrganizationSnapshot, clearTeamStore } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    const { acceptCloudWorkspaceDocument } = await import("/apps/desktop/src/renderer/state/cloud-workspace-catalog.ts");
    const organizationId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222";
    const cloudKey = `cloud://${organizationId}/${id}`;
    let version = 0;
    const role = (canEdit) => acceptCloudWorkspaceDocument({
      id, organizationId, teamId: organizationId, createdBy: organizationId,
      actorRole: canEdit ? "developer" : "prompter", name: "Design VM", placement: "cloud", status: "ready",
      version: ++version, error: null, createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z", deletedAt: null,
      capabilities: { canWrite: true, canEdit, canManage: false, canStart: true, startUnavailableReason: null },
      repository: { forge: "github.com", owner: "example", name: "project", revision: "refs/heads/main" },
      generation: { number: 1, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
    });
    window.__designPreviewRace = {
      opened, directory,
      browserIntents,
      role,
      accountChanged: () => clearTeamStore({ resetSelection: true }),
      local: () => { workspaceId = "preview-race"; folder = "/design/preview-race"; directory("directory-a"); render(); },
      visible: (value) => { active = value; render(); },
      browsers: () => (useWorkspaceStore.getState().workbenchByScope[workbenchScopeForFolder(cloudKey)]?.tabs ?? []).filter(tab => tab.type === "browser"),
      cloud: () => {
        const organization = { id: organizationId, slug: "fixture", name: "Example", logo: null, isPersonal: false, role: "admin", defaultTeamId: organizationId,
          workspaceCapabilities: { local: false, cloud: true }, teamCapabilities: { multiple: false, canCreate: false } };
        acceptOrganizationSnapshot({ user: { id: organizationId, email: "fixture@example.test", displayName: "Fixture", staffRole: null },
          teams: [organization], organizations: [organization] });
        role(true); workspaceId = folder = cloudKey; directory("directory-a"); render();
      },
      pending: () => !!settle,
      unmount: () => root.unmount(),
      mount: () => { root = createRoot(container); render(); },
      resolve: async (overrides = {}, previewUrl = "http://127.0.0.1:12345/preview/phone.html/") => {
        const complete = settle; settle = undefined;
        complete({ type: "WORKSPACE_RESPONSE", result: {
          reference: { version: 1, workspaceId: requestedWorkspace, directoryId: "directory-a", frame: "phone.html", frameId: "frame-a", revision: "a".repeat(24), ...overrides },
          previewUrl,
        } });
        await new Promise(resolve => setTimeout(resolve, 0));
      },
    };
    directory("directory-a"); render();
  });
  check("preview races use the exact harness runtime after resource timings are cleared", true);
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

  await request();
  await page.evaluate(async () => {
    window.__designPreviewRace.visible(false);
    await window.__designPreviewRace.resolve();
  });
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(2);
  await page.evaluate(() => window.__designPreviewRace.visible(true));
  check("hiding Local retires a preview reply delivered in the same browser task", true);

  await page.evaluate(() => window.__designPreviewRace.cloud());
  await expect(open).toBeVisible();
  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve());
  await expect.poll(() => page.evaluate(() => window.__designPreviewRace.browsers().length)).toBe(1);
  expect(await page.evaluate(() => window.__designPreviewRace.browsers()[0].url)).toBe("http://127.0.0.1:12345/preview/phone.html/");
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(2);
  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve());
  expect(await page.evaluate(() => window.__designPreviewRace.browsers().length)).toBe(1);
  expect(await page.evaluate(() => window.__designPreviewRace.browserIntents.length)).toBe(2);
  check("cloud Open preview reuses the exact workspace Browser destination without opening Mac loopback", true);

  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve({}, "https://other.example.test/preview/"));
  expect(await page.evaluate(() => window.__designPreviewRace.browserIntents.length)).toBe(2);
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(2);
  await expect(page.getByText("Refresh the canvas and try again.", { exact: true })).toBeVisible();
  check("cloud preview rejects a non-VM destination with short action copy", true);

  await request();
  await page.evaluate(() => window.__designPreviewRace.role(false));
  await page.evaluate(() => window.__designPreviewRace.resolve());
  await expect(open).toBeDisabled();
  expect(await page.evaluate(() => window.__designPreviewRace.browsers().length)).toBe(1);
  expect(await page.evaluate(() => window.__designPreviewRace.browserIntents.length)).toBe(2);
  await page.evaluate(() => window.__designPreviewRace.role(true));
  await request();
  await page.evaluate(async () => {
    window.__designPreviewRace.visible(false);
    await window.__designPreviewRace.resolve();
  });
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(2);
  expect(await page.evaluate(() => window.__designPreviewRace.browserIntents.length)).toBe(2);
  check("cloud permission loss and hiding retire pending preview intents", true);

  await page.evaluate(() => window.__designPreviewRace.visible(true));
  await request();
  await page.evaluate(() => window.__designPreviewRace.local());
  await page.evaluate(() => window.__designPreviewRace.resolve());
  expect(await page.evaluate(() => window.__designPreviewRace.browserIntents.length)).toBe(2);
  expect(await page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(2);
  await page.evaluate(() => window.__designPreviewRace.cloud());
  await request();
  await page.evaluate(() => window.__designPreviewRace.accountChanged());
  await page.evaluate(() => window.__designPreviewRace.resolve());
  expect(await page.evaluate(() => window.__designPreviewRace.browserIntents.length)).toBe(2);
  await page.evaluate(() => window.__designPreviewRace.local());
  await expect(open).toBeVisible();
  await expect(open).toBeEnabled();
  await request();
  await page.evaluate(() => window.__designPreviewRace.resolve());
  await expect.poll(() => page.evaluate(() => window.__designPreviewRace.opened.length)).toBe(3);
  check("workspace/account changes cancel cloud opens and signed-out Local still opens normally", true);
}
