import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";
import type { ChatThread } from "../../../state/store";

const harness = vi.hoisted(() => ({
  workspace: null as Workspace | null,
  enabled: true,
  owner: null as string | null,
  transport: "local",
  copy: vi.fn(),
  selectCopy: undefined as (() => void) | undefined,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});
vi.mock("../../../features/settings/agent-control-rollout", () => ({
  useAgentControlFeatureActive: () => harness.enabled,
}));
vi.mock("../../../features/team/team-store", () => ({
  useActiveOrganization: () => ({ isPersonal: harness.owner == null }),
  getActiveOrganizationIdSnapshot: () => harness.owner,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ executionIdentity: { kind: harness.transport } }),
}));
vi.mock("../../../state/local-link-actions", async (original) => ({
  ...(await original<typeof import("../../../state/local-link-actions")>()),
  copyLocalLink: harness.copy,
}));
vi.mock("../../../state/use-active-workspace", () => ({
  useActiveWorkspace: () => ({ workspace: harness.workspace }),
}));
vi.mock("../../../state/store", () => ({
  useWorkspaceDispatch: () => vi.fn(),
}));
vi.mock("../../../state/use-projects", () => ({
  notifyWorkspacesChanged: vi.fn(),
}));
vi.mock("../../../state/pending-workspaces", () => ({
  useWorkspaceArchiving: () => false,
}));
vi.mock("../../../features/agent/chat-unread", () => ({
  useChatUnread: () => false,
}));
vi.mock("../../../state/composer-draft-presence", () => ({
  useChatHasDraft: () => false,
}));
vi.mock("../../../features/agent/sessions-store", () => ({
  useChatAwaitingKind: () => null,
  useChatWorkingActivity: () => null,
}));
vi.mock("../../terminal/terminal-activity", () => ({
  useTerminalBusy: () => false,
}));
vi.mock("../../terminal/cloud-terminal-indicator", () => ({
  CloudTerminalIndicator: () => null,
}));
vi.mock("../chat-history-menu", () => ({ ChatHistoryMenu: () => null }));
vi.mock("../new-chat-menu", () => ({ NewChatMenu: () => null }));
vi.mock("../conversation-header", () => ({ OpenInSubmenu: () => null }));
vi.mock("../../../shared/ui/primitives/context-menu", () => {
  const children = ({ children }: { children: ReactNode }) => children;
  return {
    ContextMenu: children,
    ContextMenuContent: children,
    ContextMenuTrigger: children,
    ContextMenuSub: children,
    ContextMenuSubContent: children,
    ContextMenuSubTrigger: children,
    ContextMenuSeparator: () => null,
    ContextMenuItem: ({
      children,
      onSelect,
    }: {
      children: ReactNode;
      onSelect?: () => void;
    }) => {
      if (
        renderToStaticMarkup(createElement("span", null, children)).includes(
          "Copy link",
        )
      )
        harness.selectCopy = onSelect;
      return children;
    },
  };
});

import { WorkspaceContextMenu } from "../../../shared/ui/workspace-context-menu";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";
import { ChatTabs, type ChatTabsProps } from "../chat-tabs";

const local = {
  id: "ws_local",
  path: "/tree",
  repoRoot: "/repo",
  repoSlug: "repo",
  organizationId: null,
  placement: "local",
  archivedAt: null,
  status: "in-progress",
} as Workspace;
const chat = {
  id: "chat_local",
  folder: "/tree",
  agentId: "codex",
  agentName: "Codex",
  title: "Work",
  kind: "chat",
  createdAt: 1,
  updatedAt: 1,
} as ChatThread;
const noOp = () => {};
function renderMenu(kind: "chat" | "workspace", row = chat): string {
  if (kind === "workspace")
    return renderToStaticMarkup(
      createElement(WorkspaceContextMenu, {
        workspace: harness.workspace!,
        children: createElement("span", null, "Workspace"),
      }),
    );
  const props: ChatTabsProps = {
    workspaceFolder: harness.workspace!.path,
    paneId: "pane",
    chats: [row],
    activeChatId: row.id,
    historyChats: [],
    showSyntheticUntitled: false,
    onSelectUntitled: noOp,
    onSelectChat: noOp,
    onPrefetchChat: noOp,
    onCloseTab: noOp,
    onRestoreChat: noOp,
    onSplit: noOp,
    canSplitDown: false,
    canSplitRight: false,
  };
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ChatTabs, props)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.selectCopy = undefined;
  harness.workspace = { ...local };
  harness.enabled = true;
  harness.owner = null;
  harness.transport = "local";
});

describe.each(["chat", "workspace"] as const)("%s Copy link menu", (kind) => {
  it("renders for Local and invokes the shared copy action", () => {
    expect(renderMenu(kind)).toContain("Copy link");
    harness.selectCopy!();
    if (kind === "chat")
      expect(harness.copy).toHaveBeenCalledWith(harness.workspace, chat.id);
    else expect(harness.copy).toHaveBeenCalledWith(harness.workspace);
  });

  it.each([
    "rollout",
    "organization-local",
    "cloud",
    "cloud transport",
    "owner switch",
  ])("hides for %s", (reason) => {
    if (reason === "rollout") harness.enabled = false;
    if (reason === "organization-local")
      harness.workspace!.organizationId = "org-one";
    if (reason === "cloud") harness.workspace!.placement = "cloud";
    if (reason === "cloud transport") harness.transport = "cloud";
    if (reason === "owner switch") harness.owner = "org-one";
    expect(renderMenu(kind)).not.toContain("Copy link");
    expect(harness.selectCopy).toBeUndefined();
  });
});

it("shows only Copy link for a folder workspace", () => {
  harness.workspace = { ...local, id: "local:repo", path: "/repo" };
  const markup = renderMenu("workspace");
  expect(markup).toContain("Copy link");
  expect(markup).not.toContain("Set status");
  expect(markup).not.toContain("Archive");
});

it.each<Partial<ChatThread>>([
  { archived: true },
  { kind: "terminal" },
  { folder: "cloud://org/workspace" },
])("does not offer a link for an ineligible chat: %j", (patch) => {
  expect(renderMenu("chat", { ...chat, ...patch })).not.toContain("Copy link");
});
