import { afterEach, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async original => ({ ...(await original<typeof import("react")>()),
 useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
 useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (current: unknown) => ({ current }),
 useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
import { useArchivedWorkspaces, commitWorkspaceRestored, notifyWorkspacesChanged } from "@/renderer/state/use-projects";
import { RuntimeClient } from "@/renderer/platform/bridge/ws-client";
import { WorkspaceRuntimeClient } from "@/renderer/platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "@/renderer/platform/bridge/active-bridge";
import type { Workspace } from "@/renderer/platform/git";
import { cloudWorkspaceKey } from "@/renderer/platform/bridge/cloud-workspace-key";
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { setActiveBridge(null); vi.restoreAllMocks(); harness.effects.length = 0; });
it.each([false, true])("a failed archive refresh cannot put a confirmed-restored Local workspace back in Archived (cloud: %s)", async mixed => {
 const row = { id: "v1b-archived", repoSlug: "v1b-archive-retention", path: "/v1b-archived", archivedAt: 1 } as Workspace;
 const key = cloudWorkspaceKey({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });
 const cloud = { ...row, id: key, repoSlug: key, path: key };
 const cloudRows = mixed ? [cloud] : [];
 const request = vi.spyOn(RuntimeClient.prototype, "request").mockResolvedValue({ type: "WORKSPACE_RESPONSE", result: { workspaces: [row] } } as never);
 const bridge = new WorkspaceRuntimeClient({ open: vi.fn(), workspaces: () => cloudRows });
 const inbound = bridge as unknown as { setStatus: (status: string) => void; handleIncoming: (message: unknown) => void };
 inbound.setStatus("connected"); setActiveBridge(bridge);
 useArchivedWorkspaces();
 const cleanups = harness.effects.splice(0).map(effect => effect());
 try {
  notifyWorkspacesChanged(row.repoSlug);
  await flush(); expect(useArchivedWorkspaces().workspaces).toEqual([row, ...cloudRows]);
  commitWorkspaceRestored({ ...row, archivedAt: null });
  expect(useArchivedWorkspaces().workspaces).toEqual(cloudRows);
  request.mockRejectedValueOnce(new Error("Local list temporarily unavailable"));
  inbound.handleIncoming({ type: "DB_CHANGED", kinds: ["workspaces"], workspaceIds: [row.id] });
  notifyWorkspacesChanged(row.repoSlug);
  await flush(); await flush();
  expect(useArchivedWorkspaces().workspaces).toEqual(cloudRows);
 } finally { for (const off of cleanups) off?.(); bridge.dispose(); }
});
