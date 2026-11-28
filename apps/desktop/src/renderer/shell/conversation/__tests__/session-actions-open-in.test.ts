import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ nativeReady: true, chats: [] as unknown[], activeChatId: null as string | null }));

vi.mock("../../../platform/runtime", async (original) => ({
  ...(await original<typeof import("../../../platform/runtime")>()),
  useNativeRuntime: () => ({ ready: fixture.nativeReady }),
}));
vi.mock("../conversation-header", () => ({
  OpenInSubmenu: ({ path }: { path: string }) => createElement("span", { "data-open-in": path }, "Open in"),
}));
const childTargets = vi.hoisted(() => [] as string[]);
vi.mock("../../../features/agent/add-child-session", async (original) => {
  const actual = await original<typeof import("../../../features/agent/add-child-session")>();
  return {
    ...actual,
    canAddChildSession: (parent: Parameters<typeof actual.canAddChildSession>[0]) => {
      if (parent) childTargets.push(parent.id);
      return actual.canAddChildSession(parent);
    },
  };
});
vi.mock("../../../state/chat-panes-store", () => ({
  useChatPanesStore: (select: (state: { byFolder: Record<string, unknown> }) => unknown) => select({ byFolder: {} }),
}));
vi.mock("../../../state/store", () => ({
  useWorkspaceDispatch: () => vi.fn(),
  useWorkspaceStore: (select: (state: { chats: unknown[]; activeChatId: string | null }) => unknown) =>
    select({ chats: fixture.chats, activeChatId: fixture.activeChatId }),
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
  fixture.chats = [];
  fixture.activeChatId = null;
});

describe("session actions while a side chat has focus", () => {
  const folder = "/Users/fixture/personal";
  const chat = (id: string, extra: Record<string, unknown> = {}) => ({
    id, folder, title: id, agentId: "claude", agentName: null, model: null, effort: "high",
    permissionMode: "auto", createdAt: 1, updatedAt: 1, ...extra,
  });

  it("acts on the chat column's session and never offers a side chat there", () => {
    fixture.chats = [chat("column"), chat("side", { kind: "side", sourceChatId: "column" })];
    fixture.activeChatId = "side";
    childTargets.length = 0;
    const html = render(folder);
    expect(html).toContain("Add child session");
    expect(childTargets).toContain("column");
    expect(childTargets).not.toContain("side");
    expect(html).not.toContain("New side chat");
  });
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
