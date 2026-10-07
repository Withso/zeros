import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTab } from "../tab-model";
vi.mock("../../../features/team/cloud-workspace-account-access", () => ({ useCloudWorkspaceAccountAccess: () => true, hasCloudWorkspaceAccountAccess: () => true }));

vi.mock("../../../features/agent/sessions-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../features/agent/sessions-hooks")
  >()),
  useAgentSessions: () => ({}),
}));
vi.mock("../../../platform/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/runtime")>()),
  useNativeRuntime: () => ({ ready: true }),
}));

const folder =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
afterEach(() => vi.unstubAllEnvs());

describe("preview-free cloud UI", () => {
  it("mounts a blank admission frame instead of navigating to Mac localhost", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "preview.example.test");
    const { BrowserTab } = await import("../tabs/browser-tab");
    const { TooltipProvider } = await import("../../../shared/ui/primitives");
    const markup = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(BrowserTab, { tab: createBrowserTab({ url: "http://localhost:5173/" }), active: true, scope: folder })));
    expect(markup).not.toContain('src="http://localhost:5173/"');
  });
  it("hides cloud Open controls but retains Stop and Local controls", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "");
    const { RunSessionButtons } =
      await import("../../terminal/run-session-buttons");
    const { TooltipProvider } = await import("../../../shared/ui/primitives");
    const props = {
      title: "Dev server",
      previewUrl: "http://localhost:5173/",
      onStop: () => {},
      onOpenPreview: () => {},
    };
    const cloud = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(RunSessionButtons, { ...props, folderKey: folder }),
      ),
    );
    expect(cloud).toContain('aria-label="Stop Dev server"');
    expect(cloud).not.toContain('aria-label="Open Dev server in Browser"');
    const local = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(RunSessionButtons, { ...props, folderKey: "/repo" }),
      ),
    );
    expect(local).toContain('aria-label="Open Dev server in Browser"');
  });
  it("does not restore a VM-local run URL as an unconfigured cloud iframe", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "");
    const { BrowserTab } = await import("../tabs/browser-tab");
    const tab = createBrowserTab({ url: "http://localhost:5173/" });
    const markup = renderToStaticMarkup(
      createElement(BrowserTab, { tab, active: true, scope: folder }),
    );
    expect(markup).toContain("Cloud preview URLs are not configured");
    expect(markup).not.toContain("<iframe");
  });
  it("does not suggest VM-local previews in an empty cloud Browser", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "");
    const { BrowserTab } = await import("../tabs/browser-tab");
    const { TooltipProvider } = await import("../../../shared/ui/primitives");
    const render = (scope: string) =>
      renderToStaticMarkup(
        createElement(
          TooltipProvider,
          null,
          createElement(BrowserTab, {
            tab: createBrowserTab(),
            active: true,
            scope,
          }),
        ),
      );
    const cloud = render(folder);
    expect(cloud).not.toContain("localhost:3000");
    expect(cloud).not.toContain("localhost:5173");
    expect(cloud).not.toContain("localhost:8080");
    expect(cloud).not.toContain("preview your app");
    expect(render("/repo")).toContain("localhost:5173");
  });
  it("keeps conversation-owned agent browsers independent from preview domains", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "");
    const { BrowserTab } = await import("../tabs/browser-tab");
    const { TooltipProvider } = await import("../../../shared/ui/primitives");
    const tab = createBrowserTab({
      url: "http://localhost:5173/",
      browserConversationId: "33333333-3333-4333-8333-333333333333",
    });
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(BrowserTab, { tab, active: false, scope: folder }),
      ),
    );
    expect(markup).not.toContain("Cloud preview URLs are not configured");
    expect(markup).not.toContain("<iframe");
  });
});
