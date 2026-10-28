import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneError } from "../../features/team/control-plane";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { resetSidebarListPreferencesForTests, setSidebarRepositoryIds, sidebarRepositoryFilterOwner, sidebarRepositoryIds } from "../sidebar-list-preferences";
import { changedSidebarWorkspaceFolders } from "../../shell/sidebar-workspace-activity";
import { peekWorkspacesFor, setWorkspaceRowsForTesting } from "../use-projects";
import { cloudGithubPrScope } from "../../platform/cloud-github-pr-scope";
import { cloudGithubPrCatalogContext } from "../../platform/cloud-github-pr-capability";
import { clearCloudGithubPr } from "../../platform/cloud-github-pr";
import { githubReviewCache, githubReviewKey } from "../../features/code-review/github-review-cache";
const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), lifecycle: vi.fn(), forget: vi.fn(), projects: vi.fn(() => [] as unknown[]), rollout: false, complete: true }));
vi.mock("../../platform/cloud-workspace-access", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/cloud-workspace-access")>(), forgetCloudWorkspacePortForwarding:api.forget,
}));
vi.mock("../cloud-workspace-stream-rollout", () => ({ cloudCatalogStreamRolloutEnabled: () => api.rollout }));
vi.mock("../../platform/cloud-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/cloud-workspaces")>()),
  listCloudWorkspaceCatalogSnapshot: async (...args: unknown[]) => ({ workspaces: await api.list(...args), catalogVersion: null, complete: api.complete }),
  getCloudWorkspaceDocument: api.read,
  changeCloudWorkspaceLifecycle: api.lifecycle,
}));
vi.mock("../projects-store", () => ({ loadProjects: api.projects }));
import {
  acceptCloudWorkspaceDocument,
  acceptCloudEngineWorkspace,
  clearCloudWorkspaceCatalog,
  cloudWorkspaceCatalogConfirmed,
  cloudCatalogNeedsFastRefresh,
  cloudWorkspaceDocument,
  canReadCloudWorkspace,
  canBackgroundSyncCloudWorkspace,
  getCloudWorkspaceRows,
  getCloudProjects,
  cloudProjectForFolder,
  manageCloudWorkspace,
  waitForCloudWorkspaceLifecycle,
  cloudWorkspaceStopVersion,
  cloudWorkspaceOperation,
  refreshCloudWorkspaceCatalog,
  refreshCloudWorkspace,
  cloudWorkspaceDetails,
  subscribeCloudWorkspaces,
  subscribeCloudWorkspaceRows,
} from "../cloud-workspace-catalog";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
function doc(version: number, status = "ready"): CloudWorkspaceDocument {
  return {
    id: target.workspaceId,
    organizationId: target.organizationId,
    teamId: target.organizationId,
    name: "Cloud fixture",
    placement: "cloud",
    createdBy: target.organizationId,
    status,
    version,
    error: null,
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: `2026-09-26T00:00:${String(version).padStart(2, "0")}Z`,
    deletedAt: null,
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
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: "running",
      lastObservedAt: null,
    },
  };
}

it.each(["capability", "branch", "repository"])("retires protected PR presentation when catalog %s changes", change => {
  const initial = doc(1);
  initial.capabilities.githubPullRequests = 1;
  initial.github = { repositoryId: "42", branch: "feature", baseBranch: "main", headSha: "a".repeat(40), prNumber: 7, prState: "ready", prUrl: "https://github.com/example/fixture/pull/7" };
  acceptCloudWorkspaceDocument(initial);
  const key = `cloud://${target.organizationId}/${target.workspaceId}`;
  const reviewKey = githubReviewKey(key, 7), scope = cloudGithubPrScope(key);
  githubReviewCache.setData(reviewKey, { headSha: "a".repeat(40), baseSha: "b".repeat(40), threads: [], threadsTruncated: false, annotations: [], annotationsTruncated: false, annotationError: null });
  const next = { ...initial, version: 2, capabilities: { ...initial.capabilities }, github: { ...initial.github } };
  if (change === "capability") delete next.capabilities.githubPullRequests;
  else if (change === "branch") next.github.branch = "another-branch";
  else next.github.repositoryId = "43";
  acceptCloudWorkspaceDocument(next);
  expect(cloudGithubPrScope(key)).not.toBe(scope);
  expect(githubReviewCache.peekSnapshot(reviewKey).data).toBeUndefined();
});

it("retains unchanged PR context but retires it across a branch round trip", () => {
  const initial = doc(1);
  initial.capabilities.githubPullRequests = 1;
  initial.github = { repositoryId: "42", branch: "feature", baseBranch: "main", headSha: "a".repeat(40), prNumber: 7, prState: "ready", prUrl: "https://github.com/example/fixture/pull/7" };
  acceptCloudWorkspaceDocument(initial);
  const context = cloudGithubPrCatalogContext(target);
  const scope = cloudGithubPrScope(`cloud://${target.organizationId}/${target.workspaceId}`);
  acceptCloudWorkspaceDocument({ ...initial, version: 2 });
  expect(cloudGithubPrCatalogContext(target)).toBe(context);
  expect(cloudGithubPrScope(`cloud://${target.organizationId}/${target.workspaceId}`)).toBe(scope);
  acceptCloudWorkspaceDocument({ ...initial, version: 3, github: { ...initial.github, branch: "another-branch" } });
  acceptCloudWorkspaceDocument({ ...initial, version: 4 });
  expect(cloudGithubPrCatalogContext(target)).not.toBe(context);
});

it("retires an organization's review caches even after its transport snapshot was evicted", () => {
  const initial = doc(1);
  initial.capabilities.githubPullRequests = 1;
  const other = { ...initial, organizationId: "33333333-3333-4333-8333-333333333333" };
  acceptCloudWorkspaceDocument(initial);
  acceptCloudWorkspaceDocument(other);
  const key = githubReviewKey(`cloud://${initial.organizationId}/${initial.id}`, 7);
  const otherKey = githubReviewKey(`cloud://${other.organizationId}/${other.id}`, 7);
  const value = { headSha: "a".repeat(40), baseSha: "b".repeat(40), threads: [], threadsTruncated: false, annotations: [], annotationsTruncated: false, annotationError: null };
  // Presentation caches have a separate lifetime from the bounded transport
  // snapshot map. A connection change must retire all of this owner's data.
  githubReviewCache.setData(key, value);
  githubReviewCache.setData(otherKey, value);
  clearCloudGithubPr(initial.organizationId);
  expect(githubReviewCache.peekSnapshot(key).data).toBeUndefined();
  expect(githubReviewCache.peekSnapshot(otherKey).data).toBe(value);
});

it("prunes a sidebar repository filter only when its last cloud workspace is removed", () => {
  const second = { ...doc(1), id: "33333333-3333-4333-8333-333333333333" };
  acceptCloudWorkspaceDocument(doc(1));
  acceptCloudWorkspaceDocument(second);
  const project = getCloudProjects()[0];
  const owner = sidebarRepositoryFilterOwner(doc(1).createdBy, target.organizationId);
  setSidebarRepositoryIds(owner, [project.id]);
  acceptCloudWorkspaceDocument({ ...doc(2, "deleted"), deletedAt: "2026-09-26T00:00:02Z" });
  expect(sidebarRepositoryIds(owner)).toEqual([project.id]);
  acceptCloudWorkspaceDocument({ ...doc(3, "deleted"), id: second.id, deletedAt: "2026-09-26T00:00:03Z" });
  expect(sidebarRepositoryIds(owner)).toEqual([]);
});

it("retains repository filters through a cloud account reset and reload", () => {
  acceptCloudWorkspaceDocument(doc(1));
  const project = getCloudProjects()[0];
  const owner = sidebarRepositoryFilterOwner(doc(1).createdBy, target.organizationId);
  setSidebarRepositoryIds(owner, [project.id]);
  clearCloudWorkspaceCatalog();
  expect(sidebarRepositoryIds(owner)).toEqual([project.id]);
  acceptCloudWorkspaceDocument(doc(1));
  expect(sidebarRepositoryIds(owner)).toEqual([project.id]);
});

it("prunes a removed cloud repository only for the account that owned its workspaces", () => {
  acceptCloudWorkspaceDocument(doc(1));
  const project = getCloudProjects()[0];
  const owner = sidebarRepositoryFilterOwner(doc(1).createdBy, target.organizationId);
  const otherAccount = sidebarRepositoryFilterOwner("other-account", target.organizationId);
  setSidebarRepositoryIds(owner, [project.id]);
  setSidebarRepositoryIds(otherAccount, [project.id]);
  acceptCloudWorkspaceDocument({ ...doc(2, "deleted"), deletedAt: "2026-09-26T00:00:02Z" });
  expect(sidebarRepositoryIds(owner)).toEqual([]);
  expect(sidebarRepositoryIds(otherAccount)).toEqual([project.id]);
});

it("does not turn the first cloud metadata load into recent workspace activity", () => {
  acceptCloudWorkspaceDocument(doc(1));
  const catalog = getCloudWorkspaceRows();
  acceptCloudEngineWorkspace(target, { ...catalog[0], branch: "real-branch", status: "in-review", prNumber: 42 });
  const loaded = getCloudWorkspaceRows();
  expect(changedSidebarWorkspaceFolders(catalog, loaded)).toEqual([]);
  acceptCloudEngineWorkspace(target, { ...loaded[0], status: "done" });
  expect(changedSidebarWorkspaceFolders(loaded, getCloudWorkspaceRows())).toEqual([loaded[0].path]);
});

it("retains cloud metadata provenance through an unchanged shared workspace cache refresh", () => {
  acceptCloudWorkspaceDocument(doc(1));
  const catalog = getCloudWorkspaceRows();
  const slug = catalog[0].repoSlug;
  try {
    setWorkspaceRowsForTesting(slug, [...catalog]);
    acceptCloudEngineWorkspace(target, { ...catalog[0] });
    setWorkspaceRowsForTesting(slug, [...getCloudWorkspaceRows()]);
    const loaded = peekWorkspacesFor(slug)!;
    expect(changedSidebarWorkspaceFolders(catalog, loaded)).toEqual([]);
    acceptCloudEngineWorkspace(target, { ...loaded[0], status: "done" });
    setWorkspaceRowsForTesting(slug, [...getCloudWorkspaceRows()]);
    expect(changedSidebarWorkspaceFolders(loaded, peekWorkspacesFor(slug)!)).toEqual([loaded[0].path]);
  } finally {
    setWorkspaceRowsForTesting(slug, []);
  }
});

beforeEach(() => {
  api.rollout = false;
  api.complete = true;
  clearCloudWorkspaceCatalog();
  resetSidebarListPreferencesForTests();
  vi.clearAllMocks();
  api.forget.mockResolvedValue(undefined);
  api.projects.mockReturnValue([]);
});

describe("catalog stream races", () => {

  it("retains a same-version access update while an older detail response is pending", async () => {
    const initial = doc(6); acceptCloudWorkspaceDocument(initial);
    let finish!: (row: CloudWorkspaceDocument) => void;
    api.read.mockReturnValueOnce(new Promise<CloudWorkspaceDocument>(resolve => { finish = resolve; }));
    const read = refreshCloudWorkspace(target);
    acceptCloudWorkspaceDocument({ ...initial, capabilities: { ...initial.capabilities, canWrite: false } });
    finish(initial); await read;
    expect(cloudWorkspaceDocument(target)?.capabilities.canWrite).toBe(false);
  });

  it("retains a same-version access update delivered while an aggregate read is pending", async () => {
    const initial = doc(6); acceptCloudWorkspaceDocument(initial);
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValueOnce(new Promise<CloudWorkspaceDocument[]>(resolve => { finish = resolve; }));
    const read = refreshCloudWorkspaceCatalog();
    const revoked = { ...initial, capabilities: { ...initial.capabilities, canWrite: false, canManage: false } };
    acceptCloudWorkspaceDocument(revoked);
    finish([initial]); await read;
    expect(cloudWorkspaceDocument(target)?.capabilities.canWrite).toBe(false);
  });

  it("does not replace a confirmed newer document with a lower-version snapshot", async () => {
    acceptCloudWorkspaceDocument(doc(8, "stopped"));
    api.list.mockResolvedValueOnce([doc(7, "ready")]);
    await refreshCloudWorkspaceCatalog();
    expect(cloudWorkspaceDocument(target)?.status).toBe("stopped");
    expect(cloudWorkspaceDocument(target)?.version).toBe(8);
  });
});

describe("organization-scoped catalog fallback", () => {
  afterEach(() => api.list.mockReset());
  const other = { organizationId: "33333333-3333-4333-8333-333333333333", workspaceId: "44444444-4444-4444-8444-444444444444" };
  const otherDoc = () => ({ ...doc(6), id: other.workspaceId, organizationId: other.organizationId, teamId: other.organizationId });

  it.each(["global", "scoped"])("retains omitted rows from an incomplete %s list until a complete observation", async scope => {
    acceptCloudWorkspaceDocument(doc(6));
    const retained = cloudWorkspaceDocument(target);
    const listed = { ...doc(7), id: other.workspaceId };
    api.complete = false;
    api.list.mockResolvedValueOnce([listed]);
    await refreshCloudWorkspaceCatalog(scope === "scoped" ? [target.organizationId] : undefined);
    expect(cloudWorkspaceCatalogConfirmed()).toBe(false);
    expect(cloudWorkspaceDocument(target)).toBe(retained);
    expect(getCloudWorkspaceRows()).toHaveLength(2);
    api.complete = true;
    api.list.mockResolvedValueOnce([listed]);
    await refreshCloudWorkspaceCatalog(scope === "scoped" ? [target.organizationId] : undefined);
    expect(cloudWorkspaceDocument(target)).toBeUndefined();
    expect(getCloudWorkspaceRows()).toHaveLength(1);
    expect(cloudWorkspaceCatalogConfirmed()).toBe(scope === "global");
  });

  it("keeps identical native workspace IDs distinct across organization reads and removal", async () => {
    const another = { ...otherDoc(), id: target.workspaceId };
    acceptCloudWorkspaceDocument(doc(6));
    acceptCloudWorkspaceDocument(another);
    const retained = cloudWorkspaceDocument(target);
    api.list.mockResolvedValueOnce([{ ...another, version: 7 }]);
    await refreshCloudWorkspaceCatalog([other.organizationId]);
    expect(cloudWorkspaceDocument(target)).toBe(retained);
    expect(cloudWorkspaceDocument({ ...other, workspaceId: target.workspaceId })?.version).toBe(7);
    expect(getCloudProjects()).toHaveLength(2);
    api.list.mockResolvedValueOnce([]);
    await refreshCloudWorkspaceCatalog([other.organizationId]);
    expect(cloudWorkspaceDocument(target)).toBe(retained);
    expect(getCloudWorkspaceRows()).toHaveLength(1);
  });

  it("reads only uncovered organizations without pruning or moving another owner's snapshot", async () => {
    acceptCloudWorkspaceDocument(doc(6)); acceptCloudWorkspaceDocument(otherDoc());
    const before = getCloudWorkspaceRows(), kept = cloudWorkspaceDocument(target);
    api.list.mockResolvedValue([otherDoc()]);
    await refreshCloudWorkspaceCatalog([other.organizationId]);
    expect(api.list).toHaveBeenCalledExactlyOnceWith(other.organizationId);
    expect(cloudWorkspaceDocument(target)).toBe(kept); expect(getCloudWorkspaceRows()).toBe(before);
    api.list.mockResolvedValue([]); await refreshCloudWorkspaceCatalog([other.organizationId]);
    expect(cloudWorkspaceDocument(other)).toBeUndefined(); expect(cloudWorkspaceDocument(target)).toBe(kept);
  });

  it.each(["covered", "fallback"])("keeps row order when the %s organization publishes during a scoped read", async owner => {
    acceptCloudWorkspaceDocument(doc(6)); acceptCloudWorkspaceDocument(otherDoc());
    acceptCloudWorkspaceDocument({ ...doc(6), id: "55555555-5555-4555-8555-555555555555" });
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValueOnce(new Promise<CloudWorkspaceDocument[]>(resolve => { finish = resolve; }));
    const reading = refreshCloudWorkspaceCatalog([other.organizationId]);
    const current = owner === "covered" ? doc(6) : otherDoc();
    acceptCloudWorkspaceDocument({ ...current, capabilities: { ...current.capabilities, canWrite: false } });
    const published = getCloudWorkspaceRows();
    finish([otherDoc()]); await reading;
    expect(getCloudWorkspaceRows()).toBe(published);
    expect(cloudWorkspaceDocument(owner === "covered" ? target : other)?.capabilities.canWrite).toBe(false);
  });

  it("refuses a scoped response for another organization and keeps confirmed rows", async () => {
    acceptCloudWorkspaceDocument(doc(6)); const before = getCloudWorkspaceRows();
    api.list.mockResolvedValue([doc(6)]);
    await expect(refreshCloudWorkspaceCatalog([other.organizationId])).rejects.toThrow(/organization/i);
    expect(getCloudWorkspaceRows()).toBe(before);
  });

  it("does no read for an empty fallback set", async () => {
    acceptCloudWorkspaceDocument(doc(6));
    api.list.mockResolvedValue([]); await refreshCloudWorkspaceCatalog([]);
    expect(api.list).not.toHaveBeenCalled(); expect(cloudWorkspaceDocument(target)).toBeDefined();
  });

  it("does not satisfy a requested global snapshot with an older scoped flight", async () => {
    acceptCloudWorkspaceDocument(doc(6)); acceptCloudWorkspaceDocument(otherDoc());
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValueOnce(new Promise<CloudWorkspaceDocument[]>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce([doc(7), otherDoc()]);
    const scoped = refreshCloudWorkspaceCatalog([other.organizationId]);
    const global = refreshCloudWorkspaceCatalog();
    expect(api.list).toHaveBeenCalledTimes(1);
    finish([otherDoc()]); await Promise.all([scoped, global]);
    expect(api.list.mock.calls).toEqual([[other.organizationId], []]);
    expect(cloudWorkspaceDocument(target)?.version).toBe(7);
  });

  it("uses the guest-aware global list when a scoped route reports lost membership", async () => {
    acceptCloudWorkspaceDocument(doc(6)); acceptCloudWorkspaceDocument(otherDoc());
    api.list.mockRejectedValueOnce(new ControlPlaneError(403, "forbidden", "Membership ended"))
      .mockResolvedValueOnce([doc(6)]);
    await refreshCloudWorkspaceCatalog([other.organizationId]);
    expect(api.list.mock.calls).toEqual([[other.organizationId], []]);
    expect(cloudWorkspaceDocument(target)).toBeDefined(); expect(cloudWorkspaceDocument(other)).toBeUndefined();
  });

  it("does not start a queued global read for an account replaced during a scoped read", async () => {
    acceptCloudWorkspaceDocument(otherDoc());
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValueOnce(new Promise<CloudWorkspaceDocument[]>(resolve => { finish = resolve; }));
    const scoped = refreshCloudWorkspaceCatalog([other.organizationId]), global = refreshCloudWorkspaceCatalog();
    clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc(8));
    finish([otherDoc()]); await Promise.all([scoped, global]);
    expect(api.list).toHaveBeenCalledTimes(1); expect(cloudWorkspaceDocument(other)).toBeUndefined();
    expect(cloudWorkspaceDocument(target)?.version).toBe(8);
  });
});

describe("cloud lifecycle observation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.read.mockReset();
    acceptCloudWorkspaceDocument(doc(2, "stopping"));
  });
  afterEach(() => {
    clearCloudWorkspaceCatalog();
    vi.useRealTimers();
  });

  it("settles a Stop event published before the older operation receipt", async () => {
    const stopped = doc(3, "stopped");
    acceptCloudWorkspaceDocument(stopped);
    const settled = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "stop", doc(2, "stopping")).then(settled, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith(stopped);
    await pending;
    expect(api.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"])("settles Stop during a hung refresh and ignores its late %s", async outcome => {
    let finish!: (value: CloudWorkspaceDocument) => void, fail!: (error: Error) => void;
    api.read.mockReturnValue(new Promise<CloudWorkspaceDocument>((resolve, reject) => { finish = resolve; fail = reject; }));
    const settled = vi.fn(), failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "stop", doc(2, "stopping")).then(settled, failed);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.read).toHaveBeenCalledExactlyOnceWith(target);
    const stopped = doc(4, "stopped");
    acceptCloudWorkspaceDocument(stopped);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledWith(stopped);
    await pending;
    if (outcome === "resolve") finish(doc(3, "stopping"));
    else fail(new Error("Late transport failure"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(api.read).toHaveBeenCalledOnce();
    expect(cloudWorkspaceDocument(target)?.status).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the one-second poll fallback despite other workspace and owner events", async () => {
    api.read.mockResolvedValueOnce(doc(3, "stopping")).mockResolvedValueOnce(doc(4, "stopped"));
    const settled = vi.fn(), failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "stop", doc(2, "stopping")).then(settled, failed);
    await vi.advanceTimersByTimeAsync(900);
    acceptCloudWorkspaceDocument({ ...doc(3, "stopped"), id: "33333333-3333-4333-8333-333333333333" });
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.read).toHaveBeenCalledExactlyOnceWith(target);
    await vi.advanceTimersByTimeAsync(900);
    acceptCloudWorkspaceDocument({ ...doc(3, "stopped"), id: "44444444-4444-4444-8444-444444444444",
      organizationId: "55555555-5555-4555-8555-555555555555" });
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(settled).toHaveBeenCalledWith(doc(4, "stopped"));
    expect(api.read).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["account", "workspace", "organization"])("ends the wait immediately when its %s is retired during a hung refresh", async removed => {
    api.read.mockReturnValue(new Promise(() => {}));
    const settled = vi.fn(), failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "stop", doc(2, "stopping")).then(settled, failed);
    await vi.advanceTimersByTimeAsync(1_000);
    if (removed === "account") clearCloudWorkspaceCatalog();
    else {
      api.list.mockResolvedValue(removed === "workspace" ? [] : [{ ...doc(3, "stopped"),
        organizationId: "55555555-5555-4555-8555-555555555555" }]);
      await refreshCloudWorkspaceCatalog();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: removed === "account"
      ? "Cloud account changed" : "Cloud workspace access changed" }));
    await pending;
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an exact-workspace failure event before polling", async () => {
    const failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "stop", doc(2, "stopping")).catch(failed);
    acceptCloudWorkspaceDocument({ ...doc(3, "failed"), error: { code: "checkpoint_failed", message: "Checkpoint failed" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Checkpoint failed" }));
    await pending;
    expect(api.read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["archive", "stop", "wake"] as const)("keeps waiting for %s through an error that predates the request", async operation => {
    const earlier = { code: "setup_failed", message: "Setup failed" };
    const accepted = { ...doc(2, operation === "archive" ? "archiving" : operation === "stop" ? "stopping" : "waking"), error: earlier };
    const done = { ...doc(3, operation === "archive" ? "archived" : operation === "stop" ? "stopped" : "ready"), error: earlier };
    api.read.mockResolvedValueOnce(accepted).mockResolvedValueOnce(done);
    const settled = vi.fn(), failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, operation, accepted).then(settled, failed);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(failed).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(done);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a new error or a failed status that replaces an earlier error", async () => {
    const earlier = { code: "setup_failed", message: "Setup failed" };
    const failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "archive", { ...doc(2, "archiving"), error: earlier }).catch(failed);
    acceptCloudWorkspaceDocument({ ...doc(3, "archiving"), error: { code: "archive_failed", message: "Archive failed" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "Archive failed" }));
    await pending;
    const unchanged = vi.fn(), retried = { ...doc(4, "archiving"), error: earlier };
    acceptCloudWorkspaceDocument(retried);
    const second = waitForCloudWorkspaceLifecycle(target, "archive", retried).catch(unchanged);
    acceptCloudWorkspaceDocument({ ...doc(5, "failed"), error: earlier });
    await vi.advanceTimersByTimeAsync(0);
    expect(unchanged).toHaveBeenCalledWith(expect.objectContaining({ message: "Setup failed" }));
    await second;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung refresh to the original elapsed deadline", async () => {
    api.read.mockReturnValue(new Promise(() => {}));
    const failed = vi.fn();
    const pending = waitForCloudWorkspaceLifecycle(target, "stop", doc(2, "stopping")).catch(failed);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(58_999);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message:
      "The cloud workspace operation is still running. Its status will update when it finishes." }));
    await pending;
    expect(api.read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("cloud workspace catalog ownership", () => {
  it("preserves waiting wake readiness across an accepted generation replacement", async () => {
    vi.useFakeTimers();
    try {
      acceptCloudWorkspaceDocument(doc(1, "stopped"));
      api.lifecycle.mockResolvedValueOnce(doc(2, "waking"));
      const waiting = manageCloudWorkspace(target, "wake", true)
        .then(value => ({ status: value.status, generation: value.generation.number }), error => ({ error: error.message }));
      await vi.advanceTimersByTimeAsync(0);
      acceptCloudWorkspaceDocument({ ...doc(3, "ready"), generation: { ...doc(3).generation, number: 2 } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waiting).toEqual({ status: "ready", generation: 2 });
      expect(api.lifecycle).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("publishes a bounded local Stop fence before HTTP settles and clears it with the account", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    let resolve!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockImplementationOnce(() => new Promise<CloudWorkspaceDocument>(done => { resolve = done; }));
    const changed = vi.fn(), off = subscribeCloudWorkspaces(changed);
    const pending = manageCloudWorkspace(target, "stop");
    expect(cloudWorkspaceStopVersion(target)).toBeGreaterThan(0); expect(changed).toHaveBeenCalled();
    resolve(doc(2, "stopped")); await pending; off();
    const other = { ...target, workspaceId: "33333333-3333-4333-8333-333333333333" };
    expect(cloudWorkspaceStopVersion(other)).toBe(0);
    clearCloudWorkspaceCatalog(); expect(cloudWorkspaceStopVersion(target)).toBe(0);
  });
  it("a waiting Stop joins an in-flight non-waiting Stop and still waits for the final checkpoint", async () => {
    vi.useFakeTimers();
    try {
      acceptCloudWorkspaceDocument(doc(1, "ready"));
      let finish!: (document: CloudWorkspaceDocument) => void;
      api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
      api.list.mockResolvedValue([]);
      const first = manageCloudWorkspace(target, "stop");
      let settled = false;
      const joined = manageCloudWorkspace(target, "stop", true).then(value => { settled = true; return value; });
      finish(doc(2, "stopping"));
      await first;
      expect(settled).toBe(false);
      acceptCloudWorkspaceDocument(doc(3, "stopped"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await joined).toMatchObject({status:"stopped"});
      expect(api.lifecycle).toHaveBeenCalledExactlyOnceWith(target, "stop", expect.any(String));
      expect(api.read).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(["stopped", "archived", "stopping", "failed", "error"])("does not schedule background reads or mirrors for %s workspaces", status => {
    expect(canBackgroundSyncCloudWorkspace(target)).toBe(false);
    acceptCloudWorkspaceDocument(doc(1, status));
    expect(canBackgroundSyncCloudWorkspace(target)).toBe(false);
    expect(canReadCloudWorkspace(cloudWorkspaceDocument(target))).toBe(true);
    acceptCloudWorkspaceDocument(doc(2, "ready"));
    expect(canBackgroundSyncCloudWorkspace(target)).toBe(true);
  });
  it.each(["stopped", "failed"])("retires a wake after confirmed %s so an explicit retry gets a new identity", async status => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    let firstKey: string;
    api.lifecycle.mockImplementationOnce(async (_target, _operation, key) => { firstKey = key; return doc(2, "waking"); })
      .mockImplementation(async (_target, _operation, key) => key === firstKey ? doc(4, "stopped") : doc(5, "waking"));
    await manageCloudWorkspace(target, "wake");
    acceptCloudWorkspaceDocument(doc(3, status === "stopped" ? "stopping" : "failed"));
    acceptCloudWorkspaceDocument(doc(4, "stopped"));
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[1][2]).not.toBe(api.lifecycle.mock.calls[0][2]);
    expect(cloudWorkspaceDocument(target)?.status).toBe("waking");
  });
  it("retains an unresolved wake identity through an unchanged stopped read", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    api.lifecycle.mockRejectedValueOnce(new Error("Transport response lost")).mockResolvedValueOnce(doc(2, "waking"));
    await expect(manageCloudWorkspace(target, "wake")).rejects.toThrow("Transport response lost");
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[1][2]).toBe(api.lifecycle.mock.calls[0][2]);
  });
  it("does not clear a newer explicit wake flight when an older ready receipt arrives", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready"));
    let finishFirst!: (value: CloudWorkspaceDocument) => void, finishSecond!: (value: CloudWorkspaceDocument) => void;
    const secondReceipt = new Promise<CloudWorkspaceDocument>(resolve => { finishSecond = resolve; });
    api.lifecycle.mockReturnValueOnce(new Promise<CloudWorkspaceDocument>(resolve => { finishFirst = resolve; }))
      .mockReturnValue(secondReceipt);
    const first = manageCloudWorkspace(target, "wake", false, undefined, crypto.randomUUID());
    acceptCloudWorkspaceDocument(doc(2, "ready"));
    const id = crypto.randomUUID();
    const second = manageCloudWorkspace(target, "wake", false, undefined, id);
    finishFirst(doc(1, "ready")); await first;
    const joined = manageCloudWorkspace(target, "wake", false, undefined, id);
    const calls = api.lifecycle.mock.calls.length;
    finishSecond(doc(3, "ready")); await Promise.all([second, joined]);
    expect(calls).toBe(2);
  });
  it("retains an interaction reason with an uncertain wake intent when a send retries it", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    api.lifecycle.mockRejectedValueOnce(new Error("Transport response lost")).mockResolvedValueOnce(doc(2, "waking"));
    await expect(manageCloudWorkspace(target, "wake", false, "interaction")).rejects.toThrow("Transport response lost");
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls).toEqual([
      [target, "wake", expect.any(String), "interaction"],
      [target, "wake", api.lifecycle.mock.calls[0][2], "interaction"],
    ]);
  });
  it("does not retag an uncertain ordinary wake when an interaction joins its retry", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    api.lifecycle.mockRejectedValueOnce(new Error("Transport response lost")).mockResolvedValueOnce(doc(2, "waking"));
    await expect(manageCloudWorkspace(target, "wake")).rejects.toThrow("Transport response lost");
    await manageCloudWorkspace(target, "wake", false, "interaction");
    expect(api.lifecycle.mock.calls).toEqual([
      [target, "wake", expect.any(String)],
      [target, "wake", api.lifecycle.mock.calls[0][2]],
    ]);
  });
  it("does not retain the wake key after a confirmed rejection", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    api.lifecycle.mockRejectedValueOnce(new ControlPlaneError(409, "quota_exceeded", "No capacity"))
      .mockResolvedValueOnce(doc(2, "waking"));
    await expect(manageCloudWorkspace(target, "wake")).rejects.toThrow("No capacity");
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[1][2]).not.toBe(api.lifecycle.mock.calls[0][2]);
  });
  it("does not retain the Stop key after a confirmed rejection", async () => {
    acceptCloudWorkspaceDocument(doc(1, "ready"));
    api.lifecycle.mockRejectedValueOnce(new ControlPlaneError(409, "checkpoint_failed", "Checkpoint unavailable"))
      .mockResolvedValueOnce(doc(2, "stopping"));
    await expect(manageCloudWorkspace(target, "stop")).rejects.toThrow("Checkpoint unavailable");
    await manageCloudWorkspace(target, "stop");
    expect(api.lifecycle.mock.calls[1][2]).not.toBe(api.lifecycle.mock.calls[0][2]);
  });
  it.each(["account", "removed", "generation", "target"])("rejects a late wake response after its %s changes", async reason => {
    acceptCloudWorkspaceDocument({ ...doc(1, "stopped"), generation: { ...doc(1).generation, number: 2 } });
    let finish!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const waking = manageCloudWorkspace(target, "wake");
    const rejected = expect(waking).rejects.toThrow(/changed|removed|different/i);
    if (reason === "account") clearCloudWorkspaceCatalog();
    if (reason === "removed") {
      api.list.mockResolvedValue([]);
      await refreshCloudWorkspaceCatalog();
    }
    if (reason === "generation") acceptCloudWorkspaceDocument(doc(3));
    finish({ ...doc(2, "waking"), generation: { ...doc(2).generation, number: 2 }, ...(reason === "target" ? { organizationId: "33333333-3333-4333-8333-333333333333" } : {}) });
    await rejected;
    if (["account", "removed"].includes(reason)) expect(cloudWorkspaceDocument(target)).toBeUndefined();
    if (reason === "generation") expect(cloudWorkspaceDocument(target)?.generation.number).toBe(1);
    if (reason === "target") expect(getCloudProjects()).toHaveLength(1);
  });
  it("shares the wake receipt while the replacement generation drains and ignores an older response", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    let finish!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = manageCloudWorkspace(target, "wake", false, "interaction");
    const replacement = { ...doc(3, "stopping"), generation: { ...doc(3).generation, number: 2 } };
    acceptCloudWorkspaceDocument(replacement);
    const second = manageCloudWorkspace(target, "wake");
    expect(api.lifecycle).toHaveBeenCalledOnce();
    finish(doc(2, "waking"));
    expect(await first).toEqual(replacement); expect(await second).toEqual(replacement);
  });
  it("gives a later explicit wake a fresh receipt after Stop of a replacement generation", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    const replacement = (version: number, status: string) => ({ ...doc(version, status), generation: { ...doc(version).generation, number: 2 } });
    api.lifecycle.mockResolvedValueOnce(replacement(2, "setting_up")).mockResolvedValueOnce(replacement(3, "stopped")).mockResolvedValueOnce(replacement(4, "waking"));
    await manageCloudWorkspace(target, "wake");
    const original = api.lifecycle.mock.calls[0][2];
    await manageCloudWorkspace(target, "stop");
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[2][2]).not.toBe(original);
    expect(cloudWorkspaceDocument(target)?.status).toBe("waking");
  });
  it.each(["waking", "ready"])("shares a candidate wake receipt through rollback to %s and ignores its late candidate response", async status => {
    const candidate = { ...doc(1, "setting_up"), generation: { ...doc(1).generation, number: 2 } };
    acceptCloudWorkspaceDocument(candidate);
    let finish!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const first = manageCloudWorkspace(target, "wake", false, "interaction");
    const failed = vi.fn(); const completed = first.catch(failed);
    let source = doc(3, "waking"); acceptCloudWorkspaceDocument(source);
    const second = manageCloudWorkspace(target, "wake").catch(failed);
    if (status === "ready") { source = doc(4, "ready"); acceptCloudWorkspaceDocument(source); }
    expect(api.lifecycle).toHaveBeenCalledOnce();
    finish({ ...candidate, version: 2 });
    expect(await completed).toEqual(source); expect(await second).toEqual(source);
    expect(failed).not.toHaveBeenCalled();
  });
  it("accepts a newer detail version that rolls a setting-up candidate back to waking", async () => {
    acceptCloudWorkspaceDocument({ ...doc(1, "setting_up"), generation: { ...doc(1).generation, number: 2 } });
    api.read.mockResolvedValue(doc(2, "waking"));
    expect((await refreshCloudWorkspace(target)).generation.number).toBe(1);
  });
  it("returns a newer stop instead of the late wake receipt", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    let finish!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const waking = manageCloudWorkspace(target, "wake");
    acceptCloudWorkspaceDocument(doc(3, "stopping"));
    finish(doc(2, "waking"));
    expect((await waking).status).toBe("stopping");
  });
  it("refuses checkpoint recovery, which cloud workspaces do not have", async () => {
    await expect(cloudWorkspaceOperation(target, "workspace.recover", { workspaceId: target.workspaceId })).rejects.toThrow("no checkpoint recovery");
    expect(api.lifecycle).not.toHaveBeenCalled();
  });
  it.each(["deleting", "deleted"])("retires %s workspaces before provider storage removal finishes", (status) => {
    acceptCloudWorkspaceDocument(doc(1));
    const second = { ...doc(1), id: "33333333-3333-4333-8333-333333333333" };
    acceptCloudWorkspaceDocument(second);
    acceptCloudWorkspaceDocument(doc(2, status));
    expect(getCloudWorkspaceRows()).toHaveLength(1);
    expect(getCloudProjects()[0].repoRoot).toContain(second.id);
    expect(cloudProjectForFolder(`cloud://${target.organizationId}/${target.workspaceId}`)).toBeNull();
    expect(canReadCloudWorkspace(cloudWorkspaceDocument(target))).toBe(false);
  });
  it.each(["ready", "busy", "stopped", "archived", "failed"])("allows %s history without requiring a running VM", status => {
    expect(canReadCloudWorkspace(doc(1, status))).toBe(true);
    expect(canReadCloudWorkspace({ ...doc(1, status), deletedAt: doc(1).updatedAt })).toBe(false);
    expect(canReadCloudWorkspace(undefined)).toBe(false);
  });
  it("does not keep every workspace on fast polling while provider storage deletion is pending", () => {
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
    acceptCloudWorkspaceDocument(doc(1, "deleting"));
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
    acceptCloudWorkspaceDocument({ ...doc(1, "starting"), id: "33333333-3333-4333-8333-333333333333" });
    expect(cloudCatalogNeedsFastRefresh()).toBe(true);
    acceptCloudWorkspaceDocument({ ...doc(2, "ready"), id: "33333333-3333-4333-8333-333333333333" });
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it.each(["ready", "busy", "stopped", "archived", "failed", "error", "deleted"])("polls settled %s state at the normal cadence", status => {
    acceptCloudWorkspaceDocument(doc(1, status));
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it("ignores tombstoned transitions and clears polling state on account replacement", () => {
    acceptCloudWorkspaceDocument({ ...doc(1, "starting"), deletedAt: doc(1).updatedAt });
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
    acceptCloudWorkspaceDocument(doc(2, "starting"));
    expect(cloudCatalogNeedsFastRefresh()).toBe(true);
    clearCloudWorkspaceCatalog();
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it("keeps organization repository ownership separate from a matching local checkout", () => {
    api.projects.mockReturnValue([{id:"local-project",name:"fixture",repoRoot:"/local/fixture",repoSlug:"fixture",originUrl:"https://github.com/example/fixture.git",addedAt:1}]);
    acceptCloudWorkspaceDocument(doc(1));
    expect(getCloudProjects()).toHaveLength(1);
    const project = cloudProjectForFolder(`cloud://${target.organizationId}/${target.workspaceId}`);
    expect(project?.repoRoot).toMatch(/^cloud:\/\//);
    expect(project?.id).not.toBe("local-project");
  });
  it.each(["failed", "error"])("projects %s setup as failed instead of indefinitely running", (status) => {
    acceptCloudWorkspaceDocument(doc(1, status));
    expect(getCloudWorkspaceRows()[0].setupState).toBe("failed");
  });
  it("treats an archived workspace as settled instead of keeping fast setup polling active", () => {
    acceptCloudWorkspaceDocument(doc(1, "archived"));
    expect(getCloudWorkspaceRows()[0]).toMatchObject({
      setupState: "passed", archivedAt: Date.parse(doc(1, "archived").updatedAt),
    });
    acceptCloudWorkspaceDocument(doc(2, "starting"));
    expect(getCloudWorkspaceRows()[0]).toMatchObject({ setupState: "running", archivedAt: null });
  });
  it("moves a cloud-only repository's entry point when its first workspace is deleted", () => {
    const second = { ...doc(1), id: "33333333-3333-4333-8333-333333333333" };
    acceptCloudWorkspaceDocument(doc(1));
    acceptCloudWorkspaceDocument(second);
    acceptCloudWorkspaceDocument({
      ...doc(2, "deleted"),
      deletedAt: "2026-09-26T00:00:02Z",
    });
    expect(getCloudProjects()[0].repoRoot).toContain(second.id);
    expect(getCloudWorkspaceRows()).toHaveLength(1);
  });
  it("keeps the newest version when a detail and a list overlap, with stable row references", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = refreshCloudWorkspaceCatalog();
    acceptCloudWorkspaceDocument(doc(2));
    finish([doc(3)]);
    await refresh;
    expect(cloudWorkspaceDocument(target)?.version).toBe(3);
    const rows = getCloudWorkspaceRows();
    acceptCloudWorkspaceDocument(doc(3));
    expect(getCloudWorkspaceRows()).toBe(rows);
  });
  it("ignores late lists after account changes", async () => {
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = refreshCloudWorkspaceCatalog();
    clearCloudWorkspaceCatalog();
    finish([doc(1)]);
    await refresh;
    expect(getCloudWorkspaceRows()).toEqual([]);
  });
  it("reuses an uncertain lifecycle intent but starts a new one after a confirmed operation", async () => {
    api.lifecycle
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce(doc(1, "starting"))
      .mockResolvedValueOnce(doc(3, "starting"));
    await expect(manageCloudWorkspace(target, "wake")).rejects.toThrow(
      "network lost",
    );
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[0][2]).toBe(api.lifecycle.mock.calls[1][2]);
    acceptCloudWorkspaceDocument(doc(2, "ready"));
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[2][2]).not.toBe(
      api.lifecycle.mock.calls[1][2],
    );
  });
});


it("unchanged list polls retain details while status-only changes notify document observers", async () => {
  const initial = doc(1);
  acceptCloudWorkspaceDocument(initial);
  const key = getCloudWorkspaceRows()[0].id;
  const details = cloudWorkspaceDetails.peekSnapshot(key);
  const detailListener = vi.fn(), documents = vi.fn(), rows = vi.fn();
  const off = [cloudWorkspaceDetails.subscribe(key, detailListener), subscribeCloudWorkspaces(documents), subscribeCloudWorkspaceRows(rows)];
  try {
    api.list.mockResolvedValue([initial]);
    await refreshCloudWorkspaceCatalog();
    expect(cloudWorkspaceDetails.peekSnapshot(key)).toBe(details);
    expect(detailListener).not.toHaveBeenCalled();
    expect(documents).not.toHaveBeenCalled();
    acceptCloudWorkspaceDocument(doc(2, "stopped"));
    expect(documents).toHaveBeenCalledOnce();
    expect(rows).not.toHaveBeenCalled();
  } finally { off.forEach(stop => stop()); }
});
