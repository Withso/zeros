import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createBrowserTab, type WorkbenchTab } from "../tab-model";

vi.mock("../../../features/team/cloud-workspace-account-access", () => ({
  useCloudWorkspaceAccountAccess: () => true,
  hasCloudWorkspaceAccountAccess: () => true,
}));
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

async function renderBrowserTab(tab: WorkbenchTab) {
  const { BrowserTab } = await import("../tabs/browser-tab");
  const { TooltipProvider } = await import("../../../shared/ui/primitives");
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(BrowserTab, { tab, active: true, scope: "/repo" }),
    ),
  );
}

function iframeTag(markup: string): string {
  const tag = markup.match(/<iframe\b[^>]*>/)?.[0];
  if (!tag) throw new Error("The Browser tab rendered no page frame.");
  return tag;
}

describe("Browser tab page appearance", () => {
  it("gives the page frame the tab's chosen color scheme", async () => {
    const tab = createBrowserTab({ url: "https://example.com/" });
    expect(
      iframeTag(await renderBrowserTab({ ...tab, appearance: "dark" })),
    ).toMatch(/style="[^"]*color-scheme:dark/);
    expect(
      iframeTag(await renderBrowserTab({ ...tab, appearance: "light" })),
    ).toMatch(/style="[^"]*color-scheme:light/);
  });

  it("lets a System page frame inherit the Zeros color scheme", async () => {
    const tab = createBrowserTab({ url: "https://example.com/" });
    expect(iframeTag(await renderBrowserTab(tab))).not.toContain(
      "color-scheme",
    );
  });

  it("keeps the agent tab's More menu available before a live session exists", async () => {
    const tab = createBrowserTab({
      url: "https://example.com/",
      browserConversationId: "33333333-3333-4333-8333-333333333333",
    });
    const trigger = (await renderBrowserTab(tab)).match(
      /<button\b[^>]*aria-label="More browser actions"[^>]*>/,
    )?.[0];
    expect(trigger).toBeDefined();
    expect(trigger).not.toMatch(/\sdisabled=/);
  });
});
