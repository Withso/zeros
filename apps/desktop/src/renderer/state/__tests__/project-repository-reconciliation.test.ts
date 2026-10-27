import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  bridge: { status: "connected" } as { status: string } | null,
  inspect: vi.fn(), reconcile: vi.fn(), upsert: vi.fn<() => Promise<{ repoRoot: string; originUrl: string | null; originRevision: number } | undefined>>(),
}));
vi.mock("../../platform/git", () => ({ workspaceInspectFolder: mocks.inspect }));
vi.mock("../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => mocks.bridge }));
vi.mock("../../platform/bridge/workspace-bridge", () => ({
  bridgeProjectUpsert: mocks.upsert, bridgeProjectRemove: vi.fn(async () => {}),
  bridgeReconcileGithubRemote: mocks.reconcile,
}));
vi.mock("../cloud-workspace-catalog", () => ({ getCloudProjects: () => [] }));
import { loadProjects, removeProject, upsertProject } from "../projects-store";
import { refreshProjectCapabilities } from "../project-capabilities";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  mocks.bridge = { status: "connected" };
  mocks.inspect.mockReset().mockResolvedValue({ isRepo: true, originUrl: "git@github.com:former/widgets.git" });
  mocks.reconcile.mockReset(); mocks.upsert.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("repository transfer refresh", () => {
  const add = () => upsertProject({ repoRoot: "/repo/project", repoSlug: "former-widgets", isGitRepository: true,
    originUrl: "git@github.com:former/widgets.git" });
  const canonical = (repoRoot: string) => ({ project: { repoRoot, originUrl: "git@github.com:current/renamed.git", originRevision: 2 }, changed: true });

  it("updates saved Origin on the ordinary capability refresh and preserves names/slugs", async () => {
    const project = add();
    mocks.reconcile.mockResolvedValue(canonical(project.repoRoot));
    expect(await refreshProjectCapabilities(project)).toBe(true);
    expect(mocks.reconcile).toHaveBeenCalledWith(mocks.bridge, project.repoRoot);
    expect(loadProjects()).toEqual([{ ...project, originUrl: "git@github.com:current/renamed.git", originRevision: 2 }]);
    // The engine already owns this result; do not send it back as a new write.
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("retains usable local state when GitHub or an older engine cannot reconcile", async () => {
    const project = add();
    mocks.reconcile.mockRejectedValue(new Error("Unavailable"));
    expect(await refreshProjectCapabilities(project)).toBe(false);
    expect(loadProjects()).toEqual([project]);
  });

  it("keeps the canonical result when an earlier upsert acknowledges the unchanged Origin during repair", async () => {
    let acknowledge!: (value: { repoRoot: string; originUrl: string | null; originRevision: number }) => void;
    mocks.upsert.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
    const project = add();
    let repair!: (value: ReturnType<typeof canonical>) => void;
    mocks.reconcile.mockReturnValueOnce(new Promise(resolve => { repair = resolve; }));
    const pending = refreshProjectCapabilities(project);
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
    acknowledge({ repoRoot: project.repoRoot, originUrl: project.originUrl, originRevision: 0 });
    await vi.waitFor(() => expect(loadProjects()[0].originRevision).toBe(0));
    repair(canonical(project.repoRoot));
    expect(await pending).toBe(true);
    expect(loadProjects()[0]).toMatchObject(canonical(project.repoRoot).project);
  });

  it.each(["removed", "readded", "bridge"])("ignores a held repair after %s changes", async change => {
    const project = add();
    let resolve!: (result: ReturnType<typeof canonical>) => void;
    mocks.reconcile.mockReturnValue(new Promise(done => { resolve = done; }));
    const operation = refreshProjectCapabilities(project);
    await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledOnce());
    if (change === "bridge") mocks.bridge = { status: "connected" };
    else removeProject(project.id);
    if (change === "readded") add();
    const before = loadProjects();
    resolve(canonical(project.repoRoot));
    await operation;
    expect(loadProjects()).toEqual(before);
  });

  it("never sends a cloud owner to the Local engine or wakes its VM", async () => {
    await refreshProjectCapabilities({ ...add(), repoRoot: "cloud://org/workspace" });
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
