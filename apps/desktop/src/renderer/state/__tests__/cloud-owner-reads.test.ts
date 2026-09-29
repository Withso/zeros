import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/renderer/platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import { bridgeWorkspaceListSnapshot } from "@/renderer/platform/bridge/workspace-bridge";
import {
  cloudScopedId,
  cloudWorkspaceKey,
} from "@/renderer/platform/bridge/cloud-workspace-key";
import { subscribeChatSnapshots } from "@/renderer/state/chat-snapshot-subscription";
import { setActiveBridge } from "@/renderer/platform/bridge/active-bridge";
import {
  peekWorkspacesFor,
  reloadWorkspacesFor,
  runWorkspaceDiscoveryForTesting,
  setWorkspaceRowsForTesting,
} from "@/renderer/state/use-projects";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const folder = cloudWorkspaceKey(target);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  setActiveBridge(null);
  vi.restoreAllMocks();
});

it("a cloud-only history revision does not re-read Local through the persistence subscription", async () => {
  let revision = 1;
  const other = {
    ...target,
    workspaceId: "33333333-3333-4333-8333-333333333333",
  };
  const localChat = { id: "local-saved", folder: "/local" };
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: { chats: [localChat], chatDeletions: [] },
    } as never);
  const history = vi.fn(async (owner: typeof target) => ({
    chats: [
      { id: cloudScopedId(owner, "saved"), folder: cloudWorkspaceKey(owner) },
    ],
    chatDeletions: [],
    revision,
  }));
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
    readHistory: history,
  });
  (bridge as unknown as { setStatus: (status: string) => void }).setStatus(
    "connected",
  );
  await bridge.warmHistoryWorkspace(target);
  await bridge.warmHistoryWorkspace(other);
  const snapshots = vi.fn();
  const off = subscribeChatSnapshots({
    bridge,
    onSnapshot: snapshots,
    onError: vi.fn(),
    onLocalReadinessChange: vi.fn(),
  });
  try {
    await flush();
    local.mockClear();
    history.mockClear();
    revision++;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    await bridge.warmHistoryWorkspace(target);
    await flush();
    expect(snapshots.mock.lastCall?.[0].confirmedCloudWorkspaces).toEqual(
      expect.arrayContaining([folder, cloudWorkspaceKey(other)]),
    );
    expect(snapshots.mock.lastCall?.[0].chats).toContainEqual(localChat);
    expect(history).toHaveBeenCalledOnce();
    expect(history).toHaveBeenLastCalledWith(target, "chats.list", {});
    expect(local).not.toHaveBeenCalled();
  } finally {
    off();
    bridge.dispose();
  }
});

it("removing a cloud repository's final row publishes an authoritative empty list without Local", async () => {
  const slug = "cloud-v1-deleted-last-row";
  let rows: Record<string, unknown>[] = [
    { id: folder, path: folder, repoSlug: slug, archivedAt: null },
  ];
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockRejectedValue(new Error("Local disconnected"));
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => rows,
  });
  setActiveBridge(bridge);
  try {
    expect(await reloadWorkspacesFor(slug)).toBe(true);
    expect(peekWorkspacesFor(slug)).toHaveLength(1);
    rows = []; // The authorized catalog has confirmed logical deletion.
    expect.soft(await reloadWorkspacesFor(slug)).toBe(true);
    expect.soft(peekWorkspacesFor(slug)).toEqual([]);
    expect.soft(local).not.toHaveBeenCalled();
  } finally {
    bridge.dispose();
  }
});

it("global final-cloud-row removal publishes while Local remains stalled and retains Local rows", async () => {
  const slug = "cloud-v1-global-last-row";
  let rows: Record<string, unknown>[] = [
    { id: folder, path: folder, repoSlug: slug, archivedAt: null },
  ];
  const localRow = {
    id: "local-retained",
    path: "/local-retained",
    repoSlug: "v1-retained-local",
    archivedAt: null,
  };
  setWorkspaceRowsForTesting(localRow.repoSlug, [localRow as never]);
  const priorLocal = peekWorkspacesFor(localRow.repoSlug);
  let finishLocal!: (response: never) => void;
  const local = vi.spyOn(RuntimeClient.prototype, "request").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishLocal = resolve;
      }),
  );
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => rows,
  });
  setActiveBridge(bridge);
  try {
    await runWorkspaceDiscoveryForTesting();
    expect(peekWorkspacesFor(slug)).toHaveLength(1);
    rows = [];
    let complete = false;
    void runWorkspaceDiscoveryForTesting().then(() => {
      complete = true;
    });
    await flush();
    expect(complete).toBe(true);
    expect(peekWorkspacesFor(slug)).toEqual([]);
    expect(peekWorkspacesFor(localRow.repoSlug)).toBe(priorLocal);
    expect(local).toHaveBeenCalledTimes(1);
  } finally {
    bridge.dispose();
    finishLocal({
      type: "WORKSPACE_RESPONSE",
      result: { workspaces: [] },
    } as never);
    await flush();
  }
});

it("an empty catalog distinguishes cold state from confirmed deletion for a persisted cloud repository", async () => {
  const slug = `cloud-${target.organizationId}:github.com:example/deleted-before-reload`;
  let confirmed = false;
  const local = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockRejectedValue(new Error("Local unavailable"));
  const bridge = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [],
    workspacesConfirmed: () => confirmed,
  });
  setActiveBridge(bridge);
  try {
    await expect(
      bridgeWorkspaceListSnapshot(bridge, { repoSlug: slug }),
    ).rejects.toThrow("not confirmed");
    confirmed = true;
    expect(
      await bridgeWorkspaceListSnapshot(bridge, { repoSlug: slug }),
    ).toMatchObject({
      workspaces: [],
      confirmedCloudWorkspaces: true,
      confirmedLocalWorkspaces: false,
    });
    expect(local).not.toHaveBeenCalled();
    // Account replacement closes the confirmation gate until its catalog wins.
    confirmed = false;
    bridge.clearCloudConnections();
    await expect(
      bridgeWorkspaceListSnapshot(bridge, { repoSlug: slug }),
    ).rejects.toThrow("not confirmed");
    expect(local).not.toHaveBeenCalled();
  } finally {
    bridge.dispose();
  }
});
