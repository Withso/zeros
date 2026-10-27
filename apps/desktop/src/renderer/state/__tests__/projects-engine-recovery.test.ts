import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: { status: "connected" } as { status: string } | null,
  read: vi.fn(), push: vi.fn(async () => {}), remove: vi.fn(async () => {}),
}));
vi.mock("../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => mocks.bridge }));
vi.mock("../../platform/bridge/workspace-bridge", () => ({
  requestProjectList: mocks.read,
  bridgeProjectBulkUpsert: mocks.push,
  bridgeProjectUpsert: mocks.push,
  bridgeProjectRemove: mocks.remove,
}));
vi.mock("../cloud-workspace-catalog", () => ({ getCloudProjects: () => [] }));

import { loadProjects, removeProject, refreshNativeProjectOrigins, syncProjectsToEngine, upsertProject } from "../projects-store";

const local = { id: "saved-repository", repoRoot: "/repo/local", repoSlug: "local",
  name: "Local repository", originUrl: null as string | null, addedAt: 1 };

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  mocks.bridge = { status: "connected" };
  mocks.read.mockReset(); mocks.push.mockClear(); mocks.remove.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("native project recovery after an empty renderer cache", () => {
  it("shares concurrent native reads for the same bridge and cache generation", async () => {
    let resolve!: (rows: typeof local[]) => void;
    mocks.read.mockReturnValue(new Promise((done) => { resolve = done; }));
    const one = syncProjectsToEngine(), two = syncProjectsToEngine();
    expect(mocks.read).toHaveBeenCalledOnce();
    resolve([local]); await Promise.all([one, two]);
    expect(loadProjects()).toEqual([local]);
  });

  it("can recover after the first native read fails", async () => {
    mocks.read.mockRejectedValueOnce(new Error("connection replaced"));
    expect(await syncProjectsToEngine()).toBe(false);
    mocks.read.mockResolvedValueOnce([local]);
    expect(await syncProjectsToEngine()).toBe(true);
    expect(loadProjects()).toEqual([local]);
  });

  it("restores Local repository identity from the engine and excludes cloud entries", async () => {
    mocks.read.mockResolvedValue([local, { ...local, id: "cloud-project",
      repoRoot: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" }]);
    await syncProjectsToEngine();
    expect(loadProjects()).toEqual([local]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not resurrect a repository removed while recovery was in flight", async () => {
    let resolve!: (rows: typeof local[]) => void;
    mocks.read.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = syncProjectsToEngine();
    const added = upsertProject({ repoRoot: local.repoRoot });
    removeProject(added.id);
    expect(mocks.read).toHaveBeenCalledOnce();
    resolve([local]); await pending;
    expect(loadProjects()).toEqual([]);
  });

  it("preserves an intentional empty catalog when the last removal is still pending at the engine", async () => {
    const added = upsertProject({ repoRoot: local.repoRoot });
    removeProject(added.id);
    mocks.read.mockResolvedValue([local]);
    await syncProjectsToEngine();
    expect(loadProjects()).toEqual([]);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("discards a late registry response from a replaced bridge", async () => {
    let resolve!: (rows: typeof local[]) => void;
    mocks.read.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = syncProjectsToEngine();
    expect(mocks.read).toHaveBeenCalledOnce();
    mocks.bridge = { status: "connected" };
    resolve([local]); await pending;
    expect(loadProjects()).toEqual([]);
  });

  it("preserves an existing local catalog and its normal write-through", async () => {
    const project = upsertProject({ repoRoot: "/repo/existing" });
    mocks.read.mockResolvedValue([]);
    mocks.push.mockClear();
    await syncProjectsToEngine();
    expect(loadProjects()).toEqual([project]);
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledOnce();
  });

  it("pulls a repaired Origin into both boot caches without replacing local project identity", async () => {
    const project = upsertProject({ repoRoot: local.repoRoot, name: "My name", repoSlug: "former-widgets",
      originUrl: "git@github.com:former/widgets.git" });
    mocks.read.mockResolvedValue([{ ...local, originUrl: "git@github.com:current/renamed.git", originRevision: 3 }]);
    expect(await syncProjectsToEngine()).toBe(true);
    expect(loadProjects()).toEqual([{ ...project, originUrl: "git@github.com:current/renamed.git", originRevision: 3 }]);
    localStorage.removeItem("zeros-projects-v1");
    expect(loadProjects()[0].originUrl).toBe("git@github.com:current/renamed.git");
  });

  it("rejects a stale canonical metadata reply after removing and re-adding the same root", async () => {
    const project = upsertProject({ repoRoot: local.repoRoot });
    let resolve!: (rows: typeof local[]) => void;
    mocks.read.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = syncProjectsToEngine();
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    removeProject(project.id);
    const replacement = upsertProject({ repoRoot: local.repoRoot });
    resolve([{ ...local, originUrl: "git@github.com:current/renamed.git" }]);
    await pending;
    expect(loadProjects()).toEqual([replacement]);
  });

  it("revalidates native Origin notifications without echoing another write", async () => {
    const project = upsertProject({ repoRoot: local.repoRoot, originUrl: "git@github.com:former/widgets.git" });
    mocks.push.mockClear();
    let resolve!: (rows: (typeof local & { originRevision: number })[]) => void;
    mocks.read.mockReturnValue(new Promise(done => { resolve = done; }));
    const one = refreshNativeProjectOrigins(), two = refreshNativeProjectOrigins();
    expect(mocks.read).toHaveBeenCalledOnce();
    resolve([{ ...local, originUrl: "git@github.com:current/renamed.git", originRevision: 2 }]);
    await Promise.all([one, two]);
    expect(loadProjects()).toEqual([{ ...project, originUrl: "git@github.com:current/renamed.git", originRevision: 2 }]);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it.each(["remove", "replace bridge"])("discards a held Origin notification after %s", async change => {
    const project = upsertProject({ repoRoot: local.repoRoot });
    let resolve!: (rows: (typeof local & { originRevision: number })[]) => void;
    mocks.read.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = refreshNativeProjectOrigins();
    if (change === "remove") removeProject(project.id);
    else mocks.bridge = { status: "connected" };
    const current = loadProjects();
    resolve([{ ...local, originUrl: "git@github.com:current/renamed.git", originRevision: 2 }]);
    expect(await pending).toBe(false);
    expect(loadProjects()).toEqual(current);
  });
});
