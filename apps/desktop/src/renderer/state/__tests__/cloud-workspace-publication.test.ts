import { afterEach, expect, it, vi } from "vitest";
import { RuntimeClient } from "../../platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import {
  peekWorkspacesFor,
  reloadWorkspacesFor,
  runWorkspaceDiscoveryForTesting,
  setWorkspaceRowsForTesting,
} from "../use-projects";
import type { Workspace } from "../../platform/git";
const folder = cloudWorkspaceKey({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
});
afterEach(() => {
  setActiveBridge(null);
  vi.restoreAllMocks();
});
it("publishes cloud workspace rows on cold boot without emptying retained Local repository lists", async () => {
  const local = {
    id: "local",
    repoSlug: "publication-local",
    path: "/publication-local",
    archivedAt: null,
  } as Workspace;
  const cloud = {
    id: folder,
    repoSlug: "publication-cloud",
    path: folder,
    archivedAt: null,
  } as Workspace;
  setWorkspaceRowsForTesting(local.repoSlug, [local]);
  const prior = peekWorkspacesFor(local.repoSlug);
  const request = vi
    .spyOn(RuntimeClient.prototype, "request")
    .mockRejectedValue(new Error("Local disconnected"));
  const client = new WorkspaceRuntimeClient({
    open: vi.fn(),
    workspaces: () => [cloud as unknown as Record<string, unknown>],
  });
  setActiveBridge(client);
  try {
    await runWorkspaceDiscoveryForTesting();
    expect(peekWorkspacesFor(cloud.repoSlug)).toEqual([cloud]);
    expect(peekWorkspacesFor(local.repoSlug)).toBe(prior);
    request.mockClear();
    expect(await reloadWorkspacesFor(cloud.repoSlug)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  } finally {
    client.dispose();
  }
});
