import { afterEach, beforeEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  list: vi.fn(),
  folder:
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
}));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({ useCloudWorkspaceAccountAccess: () => false, hasCloudWorkspaceAccountAccess: () => false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (fn: () => void | (() => void)) => harness.effects.push(fn),
}));
vi.mock("@/renderer/state/store", async (original) => ({
  ...(await original<typeof import("@/renderer/state/store")>()),
  useWorkspaceStore: Object.assign(
    vi.fn(() => harness.folder),
    { getState: () => ({ chats: [], dispatch: vi.fn() }) },
  ),
}));
// Avoid the API module's catalog -> GitHub -> API partial-mock cycle. The
// fixture is a valid complete document; no validation behavior is under test.
vi.mock("@/renderer/platform/cloud-workspaces", () => ({
  CloudWorkspaceDocumentSchema: { parse: (value: unknown) => value },
  CloudWorkspaceRecoveryInputSchema: { parse: (value: unknown) => value },
  listCloudWorkspaceDocuments: harness.list,
  getCloudWorkspaceDocument: vi.fn(),
  changeCloudWorkspaceLifecycle: vi.fn(),
  recoverCloudWorkspace: vi.fn(),
}));
import { CloudWorkspaceLifecycle } from "@/renderer/state/cloud-workspace-lifecycle";
import {
  acceptCloudWorkspaceDocument,
  clearCloudWorkspaceCatalog,
  refreshCloudWorkspaceCatalog,
  getCloudWorkspaceRows,
} from "@/renderer/state/cloud-workspace-catalog";
import { setActiveBridge } from "@/renderer/platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import type { CloudWorkspaceDocument } from "@/renderer/platform/cloud-workspaces";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const doc: CloudWorkspaceDocument = {
  id: target.workspaceId,
  organizationId: target.organizationId,
  teamId: target.organizationId,
  createdBy: target.organizationId,
  name: "Fixture",
  placement: "cloud",
  status: "stopped",
  version: 1,
  error: null,
  deletedAt: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
  capabilities: {
    canWrite: true,
    canManage: true,
    canStart: true,
    startUnavailableReason: null,
  },
  repository: {
    forge: "github.com",
    owner: "example",
    name: "fixture",
    revision: "refs/heads/main",
  },
  generation: {
    number: 1,
    architecture: "x86_64",
    observedState: "stopped",
    lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
  },
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  clearCloudWorkspaceCatalog();
  harness.effects.length = 0;
  harness.list.mockResolvedValue([doc]);
});
afterEach(() => {
  setActiveBridge(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["initial failure", "new revision"])(
  "normal unchanged catalog polling recovers selected stopped history after %s",
  async (mode) => {
    let revision = 1;
    const history = vi.fn(async () => ({
      chats: [],
      chatDeletions: [],
      revision,
    }));
    if (mode === "initial failure")
      history.mockRejectedValueOnce(new Error("temporary network failure"));
    const open = vi.fn();
    const bridge = new WorkspaceRuntimeClient({
      open,
      workspaces: () => [],
      readHistory: history,
    });
    setActiveBridge(bridge);
    acceptCloudWorkspaceDocument(doc);
    CloudWorkspaceLifecycle();
    // Run the real active-workspace effect; invoke the same catalog poll as the timer.
    const off = harness.effects.find(effect => effect.toString().includes("warmCloudWorkspaceDestination"))!();
    try {
      await flush();
      expect(history).toHaveBeenCalledTimes(1);
      const prior = getCloudWorkspaceRows();
      revision = 2;
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
      await refreshCloudWorkspaceCatalog();
      await flush();
      expect(getCloudWorkspaceRows()).toBe(prior);
      expect(open).not.toHaveBeenCalled();
      expect(history).toHaveBeenCalledTimes(2);
      expect(bridge.hasChatSnapshot(harness.folder)).toBe(true);
    } finally {
      if (off) off();
      bridge.dispose();
    }
  },
);

it("successful polls revalidate only the visible owner and notify only a new confirmed history revision", async () => {
  let now = 100_000,
    revision = 1;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const history = vi.fn(async () => ({
    chats: [],
    chatDeletions: [],
    revision,
    sampledAt: now,
  }));
  const open = vi.fn();
  const bridge = new WorkspaceRuntimeClient({
    open,
    workspaces: () => [],
    readHistory: history,
  });
  setActiveBridge(bridge);
  const other = { ...doc, id: "33333333-3333-4333-8333-333333333333" };
  harness.list.mockResolvedValue([doc, other]);
  acceptCloudWorkspaceDocument(doc);
  acceptCloudWorkspaceDocument(other);
  const changes = vi.fn();
  const offChanges = bridge.on("DB_CHANGED", changes);
  CloudWorkspaceLifecycle();
  const off = harness.effects.find(effect => effect.toString().includes("warmCloudWorkspaceDestination"))!();
  try {
    await flush();
    expect(history).toHaveBeenCalledTimes(1);
    changes.mockClear();
    now += 31_000;
    await refreshCloudWorkspaceCatalog();
    await flush();
    expect(history).toHaveBeenCalledTimes(2);
    expect(changes).not.toHaveBeenCalled();
    expect(history.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      expect.objectContaining(target),
      expect.objectContaining(target),
    ]);
    expect(history).toHaveBeenLastCalledWith(
      expect.objectContaining(target),
      "chats.list",
      {},
    );
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    now += 31_000;
    revision++;
    await refreshCloudWorkspaceCatalog();
    await flush();
    expect(history).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    now += 31_000;
    await refreshCloudWorkspaceCatalog();
    await flush();
    expect(history).toHaveBeenCalledTimes(3);
    expect(changes).toHaveBeenCalledOnce();
    expect(changes).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cloudWorkspace: harness.folder,
        kinds: ["chats", "messages"],
      }),
    );
    expect(open).not.toHaveBeenCalled();
  } finally {
    off?.();
    offChanges();
    bridge.dispose();
  }
});

it("resume retries failed stopped history, while a failed catalog poll and hidden visibility stay inert", async () => {
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const history = vi.fn(async () => ({
    chats: [],
    chatDeletions: [],
    revision: 1,
  }));
  history.mockRejectedValueOnce(new Error("temporary history failure"));
  const open = vi.fn();
  const bridge = new WorkspaceRuntimeClient({
    open,
    workspaces: () => [],
    readHistory: history,
  });
  setActiveBridge(bridge);
  acceptCloudWorkspaceDocument(doc);
  CloudWorkspaceLifecycle();
  const off = harness.effects.find(effect => effect.toString().includes("warmCloudWorkspaceDestination"))!();
  const visibility = vi
    .mocked(document.addEventListener)
    .mock.calls.find(([type]) => type === "visibilitychange")![1] as () => void;
  try {
    await flush();
    expect(history).toHaveBeenCalledOnce();
    harness.list.mockRejectedValueOnce(new Error("temporary catalog failure"));
    now += 31_000;
    await expect(refreshCloudWorkspaceCatalog()).rejects.toThrow(
      "temporary catalog failure",
    );
    expect(history).toHaveBeenCalledOnce();
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    visibility();
    await flush();
    expect(history).toHaveBeenCalledOnce();
    now += 31_000;
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    visibility();
    await flush();
    expect(history).toHaveBeenCalledTimes(2);
    expect(bridge.hasChatSnapshot(harness.folder)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  } finally {
    off?.();
    bridge.dispose();
  }
});
