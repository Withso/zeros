import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  list: vi.fn(),
}));
// These tests drive cache subscriptions outside React. Presentation recovery
// is exercised with mounted readers in read-recovery.test.ts.
vi.mock("../../platform/bridge/use-bridge", () => ({ useBridgeStatus: () => "connected" }));
vi.mock("../use-read-recovery", () => ({
  useReadRecovery: (_key: string, read: { error: Error | null; pending: boolean }) => read,
}));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({ useCloudWorkspaceAccountAccess: () => false, hasCloudWorkspaceAccountAccess: () => false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) =>
    harness.effects.push(effect),
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (current: unknown) => ({ current }),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("../../features/auth/auth-store", async (original) => ({
  ...(await original<typeof import("../../features/auth/auth-store")>()),
  getSession: () => new Promise(() => {}),
  onAuthStateChange: () => () => {},
}));
vi.mock("../../platform/cloud-workspace-access", () => ({
  cloudWorkspaceCapability: async () => ({ enabled: false }),
}));
vi.mock("../store", async (original) => {
  const actual = await original<typeof import("../store")>();
  return {
    ...actual,
    useWorkspaceStore: Object.assign(() => null, {
      getState: actual.useWorkspaceStore.getState,
    }),
  };
});
vi.mock("../../platform/cloud-workspaces", () => ({
  CloudWorkspaceDocumentSchema: { parse: (value: unknown) => value },
  CloudWorkspaceRecoveryInputSchema: { parse: (value: unknown) => value },
  listCloudWorkspaceCatalogSnapshot: async (...args: unknown[]) => ({ workspaces: await harness.list(...args), catalogVersion: null, complete: true }),
  getCloudWorkspaceDocument: vi.fn(),
  changeCloudWorkspaceLifecycle: vi.fn(),
  recoverCloudWorkspace: vi.fn(),
}));
import { CloudWorkspaceLifecycle } from "../cloud-workspace-lifecycle";
import {
  clearCloudWorkspaceCatalog,
  refreshCloudWorkspaceCatalog,
  getCloudWorkspaceRows,
  cloudWorkspaceCatalogConfirmed,
} from "../cloud-workspace-catalog";
import {
  peekWorkspacesFor,
  setWorkspaceRowsForTesting,
  useArchivedWorkspaces,
} from "../use-projects";
import { RuntimeClient } from "../../platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import type { Workspace } from "../../platform/git";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudScopedId, cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { sanitizeCachedChat } from "../chat-boot-cache";
import { selectActiveFolder, useWorkspaceStore } from "../store";
const doc = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: "11111111-1111-4111-8111-111111111111",
  status: "archived",
  deletedAt: null,
  name: "Removed",
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  version: 1,
  repository: {
    forge: "github.com",
    owner: "example",
    name: "removed",
    revision: "main",
  },
  generation: { number: 1 },
} as CloudWorkspaceDocument;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function ArchiveConsumer() {
  return useArchivedWorkspaces();
}
afterEach(() => {
  setActiveBridge(null);
  clearCloudWorkspaceCatalog();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  harness.effects.length = 0;
});
it.each(["global", "scoped"])("%s catalog removal prunes chats and unmounted collections without a Local reload", async scope => {
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  clearCloudWorkspaceCatalog();
  harness.list.mockResolvedValue([doc]);
  const organizations = scope === "scoped" ? [doc.organizationId] : undefined;
  await refreshCloudWorkspaceCatalog(organizations);
  const target = { organizationId: doc.organizationId, workspaceId: doc.id };
  const chat = sanitizeCachedChat({ id: cloudScopedId(target, "chat"), folder: cloudWorkspaceKey(target) })!;
  const localChat = sanitizeCachedChat({ id: "local-chat", folder: "/local" })!;
  const dispatch = useWorkspaceStore.getState().dispatch;
  dispatch({ type: "HYDRATE_CHATS", chats: [localChat, chat], activeChatId: chat.id });
  dispatch({ type: "OPEN_WORKSPACE", folder: chat.folder, repoRoot: chat.folder, chatId: chat.id });
  const cloud = getCloudWorkspaceRows()[0];
  const local = {
    id: "v1-local-archived",
    path: "/local",
    repoSlug: "v1-local-archived",
    archivedAt: 1,
  } as Workspace;
  const request = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { workspaces: [local] },
    } as never);
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () =>
      getCloudWorkspaceRows() as unknown as Record<string, unknown>[],
    workspacesConfirmed: cloudWorkspaceCatalogConfirmed,
  });
  (bridge as unknown as { setStatus: (status: string) => void }).setStatus(
    "connected",
  );
  setActiveBridge(bridge);
  setWorkspaceRowsForTesting(cloud.repoSlug, [{ ...cloud, archivedAt: null }]);
  ArchiveConsumer();
  const archiveCleanups = harness.effects.splice(0).map((effect) => effect());
  await flush();
  if (scope === "global") expect(ArchiveConsumer().workspaces.map((row) => row.id)).toEqual(
    expect.arrayContaining([local.id, cloud.id]),
  );
  expect(cloudWorkspaceCatalogConfirmed()).toBe(scope === "global");
  expect(useWorkspaceStore.getState().chats).toContainEqual(chat);
  for (const off of archiveCleanups) off?.(); // Retained, now hidden collection.
  (bridge as unknown as { setStatus: (status: string) => void }).setStatus(
    "disconnected",
  );
  harness.effects.length = 0;
  renderToStaticMarkup(createElement(CloudWorkspaceLifecycle));
  const off = harness.effects.find(effect => effect.toString().includes("pruneChats"))!(); // Real catalog -> consumer publication path.
  try {
    request.mockClear();
    harness.list.mockResolvedValue([]);
    await refreshCloudWorkspaceCatalog(organizations);
    await flush();
    expect(getCloudWorkspaceRows()).toEqual([]);
    expect(peekWorkspacesFor(cloud.repoSlug)).toEqual([]);
    expect(ArchiveConsumer().workspaces).toEqual([local]);
    expect(useWorkspaceStore.getState().chats).toEqual([localChat]);
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBeNull();
    expect(request).not.toHaveBeenCalled();
  } finally {
    off?.();
    bridge.dispose();
  }
});
