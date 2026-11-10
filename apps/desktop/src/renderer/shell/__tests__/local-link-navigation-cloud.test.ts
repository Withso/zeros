// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceLink } from "@zeros/protocol/cloud-workspace-link";
import { parseLocalLink } from "@zeros/protocol/local-orchestration";

const fixture = vi.hoisted(() => ({
  deliver: null as null | ((link: unknown) => void),
  teams: { me: null as unknown, status: "loading" },
  bridge: null as unknown,
  status: "connecting",
  navigate: vi.fn(),
  readLocal: vi.fn(),
  open: vi.fn(),
  owners: new Set<() => void>(),
  generation: 0,
  cancelChat: vi.fn(),
}));
vi.mock("../../state/cloud-chat-link-selection", () => ({ cancelCloudChatLinkSelection: fixture.cancelChat }));
vi.mock("../../platform/local-links", () => ({
  onLocalNavigation: async (handler: (link: unknown) => void) => {
    fixture.deliver = handler;
    return () => { fixture.deliver = null; };
  },
}));
vi.mock("../cloud-workspace-link-navigation", () => ({ navigateCloudWorkspaceLink: fixture.navigate }));
vi.mock("../../platform/local-link-snapshot", () => ({ readLocalLinkSnapshot: fixture.readLocal }));
vi.mock("../../platform/bridge/use-bridge", () => ({
  useBridge: () => fixture.bridge,
  useBridgeStatus: () => fixture.status,
}));
vi.mock("../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => fixture.bridge }));
vi.mock("../../features/settings/agent-control-rollout", () => ({
  useAgentControlFeatureActive: () => true,
  isAgentControlFeatureActive: () => true,
}));
vi.mock("../../features/team/team-store", () => ({
  useTeams: () => fixture.teams,
  getActiveOrganizationIdSnapshot: () => null,
  getOrganizationStoreGeneration: () => fixture.generation,
}));
vi.mock("../../features/team/active-team", () => ({
  setActiveOrganizationSelection: vi.fn(),
  subscribeActiveTeam: (listener: () => void) => {
    fixture.owners.add(listener);
    return () => fixture.owners.delete(listener);
  },
}));
vi.mock("../../features/team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.test" }));
vi.mock("../../platform/runtime", () => ({ isLocalDevelopment: () => false }));
vi.mock("../../state/use-open-workspace", () => ({ useOpenWorkspace: () => fixture.open }));
vi.mock("../../state/use-projects", () => ({
  peekProjects: () => [],
  notifyProjectsChanged: vi.fn(),
  beginLocalWorkspaceRead: () => vi.fn(),
}));
vi.mock("../../state/projects-store", () => ({ syncProjectsToEngine: vi.fn() }));
vi.mock("../../state/store", () => ({
  useWorkspaceStore: {
    getState: () => ({ navigationVersion: 0, chats: [], activeChatId: null, dispatch: vi.fn() }),
    subscribe: () => () => {},
  },
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { LocalLinkNavigation } from "../local-link-navigation";

const link: CloudWorkspaceLink = {
  scheme: "zeros",
  kind: "cloud-workspace",
  organizationId: "5d2f8c1a-3b7e-4f90-a6d4-9c1e2b7f8a35",
  workspaceId: "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46",
};
let root: Root, container: HTMLDivElement;
const readChat = vi.fn() as unknown as Parameters<typeof LocalLinkNavigation>[0]["readChat"];
const render = () => act(async () => root.render(createElement(LocalLinkNavigation, { readChat })));

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.teams = { me: null, status: "loading" };
  fixture.bridge = null;
  fixture.status = "connecting";
  fixture.generation = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("waits for the account's organizations, then opens a cloud link once, whatever the bridge does", async () => {
  let finish!: () => void;
  fixture.navigate.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  await act(async () => fixture.deliver!(link));
  expect(fixture.navigate).not.toHaveBeenCalled();

  fixture.teams = { me: { user: { id: "u" }, organizations: [] }, status: "ready" };
  await render();
  expect(fixture.navigate).toHaveBeenCalledOnce();
  expect(fixture.navigate.mock.calls[0]![0]).toEqual(link);
  const { current, openWorkspace } = fixture.navigate.mock.calls[0]![1];

  // Booting the Local engine bridge is unrelated to a control-plane read.
  fixture.bridge = { status: "connected", executionIdentity: { kind: "local" }, onStatusChange: () => () => {} };
  fixture.status = "connected";
  await render();
  expect(fixture.navigate).toHaveBeenCalledOnce();
  expect(current()).toBe(true);

  openWorkspace({ path: "cloud://x", repoRoot: "cloud://x" });
  expect(fixture.open).toHaveBeenCalledWith({ path: "cloud://x", repoRoot: "cloud://x" });
  await act(async () => finish());
  await render();
  expect(fixture.navigate).toHaveBeenCalledOnce();
  expect(fixture.readLocal).not.toHaveBeenCalled();
});

it("retires a cloud link's read when the owner changes, and a newer link replaces it", async () => {
  fixture.teams = { me: { user: { id: "u" }, organizations: [] }, status: "ready" };
  await render();
  fixture.navigate.mockReturnValue(new Promise<void>(() => {}));
  await act(async () => fixture.deliver!(link));
  const first = fixture.navigate.mock.calls[0]![1];
  for (const listener of fixture.owners) listener();
  expect(first.current()).toBe(false);

  const next = { ...link, workspaceId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" };
  await act(async () => fixture.deliver!(next));
  expect(fixture.navigate).toHaveBeenCalledTimes(2);
  expect(fixture.navigate.mock.calls[1]![0]).toEqual(next);
  expect(fixture.navigate.mock.calls[1]![1].current()).toBe(true);
});

it("sends an organization's numbered workspace or chat link to the cloud, never to the engine", async () => {
  fixture.teams = { me: { user: { id: "u" }, organizations: [] }, status: "ready" };
  fixture.bridge = { status: "connected", executionIdentity: { kind: "local" }, onStatusChange: () => () => {} };
  fixture.status = "connected";
  await render();
  fixture.navigate.mockResolvedValue(undefined);
  const chat = parseLocalLink("zeros://acme/w/310?session=chat-1")!;
  await act(async () => fixture.deliver!(chat));
  expect(fixture.navigate).toHaveBeenCalledOnce();
  expect(fixture.navigate.mock.calls[0]![0]).toEqual(chat);
  expect(fixture.readLocal).not.toHaveBeenCalled();

  // Local's own numbered link reads the engine.
  fixture.readLocal.mockReturnValue(new Promise(() => {}));
  await act(async () => fixture.deliver!(parseLocalLink("zeros://local/w/3")!));
  expect(fixture.navigate).toHaveBeenCalledOnce();
});

it("retires a chat link still waiting for its chats as soon as any newer link arrives", async () => {
  fixture.teams = { me: { user: { id: "u" }, organizations: [] }, status: "ready" };
  await render();
  fixture.navigate.mockResolvedValue(undefined);
  await act(async () => fixture.deliver!(parseLocalLink("zeros://acme/w/310?session=chat-1")!));
  expect(fixture.cancelChat).toHaveBeenCalledOnce();
  fixture.readLocal.mockReturnValue(new Promise(() => {}));
  await act(async () => fixture.deliver!(parseLocalLink("zeros://local/w/3")!));
  expect(fixture.cancelChat).toHaveBeenCalledTimes(2);
  expect(fixture.cancelChat.mock.invocationCallOrder[1]).toBeLessThan(
    fixture.readLocal.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});
