import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ nativeReady: true }));

vi.mock("../../../platform/runtime", async (original) => ({
  ...(await original<typeof import("../../../platform/runtime")>()),
  useNativeRuntime: () => ({ ready: fixture.nativeReady }),
}));
vi.mock("../conversation-header", () => ({
  OpenInSubmenu: ({ path }: { path: string }) => createElement("span", { "data-open-in": path }, "Open in"),
}));
vi.mock("../../../state/chat-panes-store", () => ({
  useChatPanesStore: (select: (state: { byFolder: Record<string, unknown> }) => unknown) => select({ byFolder: {} }),
}));
vi.mock("../../../state/store", () => ({
  useWorkspaceDispatch: () => vi.fn(),
  useWorkspaceStore: (select: (state: { chats: unknown[]; activeChatId: null }) => unknown) => select({ chats: [], activeChatId: null }),
}));
vi.mock("../../../shared/ui/primitives/dropdown-menu", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children);
  return {
    DropdownMenu: passthrough, DropdownMenuContent: passthrough, DropdownMenuTrigger: passthrough,
    DropdownMenuShortcut: passthrough, DropdownMenuItem: passthrough,
    DropdownMenuSeparator: () => createElement("hr"),
  };
});

import { SessionActionsMenu } from "../session-switcher";

const render = (folder: string, readOnly = false) =>
  renderToStaticMarkup(createElement(SessionActionsMenu, { folder, readOnly }));

beforeEach(() => {
  fixture.nativeReady = true;
});

describe("session actions Open in", () => {
  it.each(["/Users/fixture/personal", "/Users/fixture/organization-local"])("offers Open in for the Local folder %s after the splits", (folder) => {
    const html = render(folder);
    expect(html).toContain(`data-open-in="${folder}"`);
    expect(html.indexOf("Split down")).toBeLessThan(html.indexOf("<hr/><span data-open-in"));
  });

  it("omits Open in for a cloud workspace", () => {
    const html = render("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222");
    expect(html).toContain("Split right");
    expect(html).not.toContain("data-open-in");
  });

  it("omits Open in until the native bridge is ready", () => {
    fixture.nativeReady = false;
    expect(render("/Users/fixture/personal")).not.toContain("data-open-in");
  });
});
