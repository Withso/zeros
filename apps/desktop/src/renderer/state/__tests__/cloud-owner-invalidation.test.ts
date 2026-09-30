import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  list: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (current: unknown) => ({ current }),
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));
vi.mock("../../platform/git", async (original) => ({
  ...(await original<typeof import("../../platform/git")>()),
  workspaceListSnapshot: async (...args: unknown[]) => ({
    workspaces: await hooks.list(...args),
    confirmedLocalWorkspaces: true,
  }),
}));
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import type { Workspace } from "../../platform/git";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import {
  notifyWorkspacesChanged,
  notifyWorkspacesChangedForIds,
  peekWorkspacesFor,
  reloadWorkspacesFor,
  useWorkspacesFor,
  useArchivedWorkspaces,
} from "../use-projects";
import {
  allBranchesCache,
  remoteBranchesCache,
  createLocalBranchesCache,
} from "../read-caches";
const a = cloudWorkspaceKey({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
});
const b = cloudWorkspaceKey({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "33333333-3333-4333-8333-333333333333",
});
const cleanups: Array<() => void> = [];
function WorkspaceConsumer({ repoSlug }: { repoSlug: string }) {
  useWorkspacesFor(repoSlug);
  useArchivedWorkspaces(repoSlug);
  return null;
}
afterEach(() => {
  for (const off of cleanups.splice(0)) off();
  hooks.effects.length = 0;
  setActiveBridge(null);
  vi.restoreAllMocks();
});
it.each(["catalog", "engine event"])(
  "cloud A %s invalidation leaves mounted Local/cloud B lists and retained picker snapshots untouched",
  async (source) => {
    const folders = ["/local", a, b];
    const slugs = ["local", "cloud-a", "cloud-b"];
    const rows = folders.map(
      (path, i) =>
        ({ id: path, path, repoSlug: slugs[i], archivedAt: null }) as Workspace,
    );
    hooks.list.mockImplementation(async ({ repoSlug, archived }) =>
      archived ? [] : rows.filter((row) => row.repoSlug === repoSlug),
    );
    setActiveBridge({
      status: "connected",
      onStatusChange: () => () => {},
    } as unknown as RuntimeClient);
    for (const slug of slugs) await reloadWorkspacesFor(slug);
    for (const repoSlug of slugs) WorkspaceConsumer({ repoSlug });
    for (const effect of hooks.effects.splice(0)) {
      const off = effect();
      if (off) cleanups.push(off);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshots = slugs.map(peekWorkspacesFor);
    const pickerSnapshots = folders.map((folder, i) => {
      allBranchesCache.setData(slugs[i], []);
      remoteBranchesCache.setData(folder, []);
      const key = JSON.stringify([folder, slugs[i]]);
      createLocalBranchesCache.setData(key, []);
      return [
        allBranchesCache.peekSnapshot(slugs[i]),
        remoteBranchesCache.peekSnapshot(folder),
        createLocalBranchesCache.peekSnapshot(key),
      ];
    });
    hooks.list.mockClear();
    if (source === "catalog") notifyWorkspacesChanged(slugs[1], [a]);
    else notifyWorkspacesChangedForIds([a]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.list.mock.calls.map(([params]) => params.repoSlug)).toEqual([
      slugs[1],
      slugs[1],
    ]);
    for (const i of [0, 2]) {
      expect(peekWorkspacesFor(slugs[i])).toBe(snapshots[i]);
      expect(allBranchesCache.peekSnapshot(slugs[i])).toBe(
        pickerSnapshots[i][0],
      );
      expect(remoteBranchesCache.peekSnapshot(folders[i])).toBe(
        pickerSnapshots[i][1],
      );
      expect(
        createLocalBranchesCache.peekSnapshot(
          JSON.stringify([folders[i], slugs[i]]),
        ),
      ).toBe(pickerSnapshots[i][2]);
    }
    expect(remoteBranchesCache.peekSnapshot(a).invalidationVersion).toBe(
      pickerSnapshots[1][1].invalidationVersion + 1,
    );
  },
);
