import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkerConfiguration } from "../../agents/containment/cloud-worker-config";

const fixture = vi.hoisted(() => ({
  worker: null as CloudWorkerConfiguration | null,
  mapping: { workspaceRoot: "/srv/zeros/workspace", repositoryAlias: "/srv/zeros/repos/fixture/repo" },
  descriptors: new Map<number, string>(), nextFd: 100,
  changeOwner: vi.fn(), loadWorker: vi.fn(), loadPaths: vi.fn(), open: vi.fn(), close: vi.fn(),
}));
vi.mock("../../agents/containment/cloud-worker-config", async original => ({
  ...await original<object>(), loadCloudWorkerConfiguration: fixture.loadWorker,
}));
vi.mock("../../agents/containment/cloud-workspace-paths", async original => ({
  ...await original<object>(), loadCloudWorkspacePaths: fixture.loadPaths,
}));
vi.mock("node:fs", async original => ({
  ...await original<object>(), fchownSync: fixture.changeOwner, openSync: fixture.open, closeSync: fixture.close,
  realpathSync: (target: string) => target.startsWith("/proc/self/fd/") ? fixture.descriptors.get(Number(target.split("/").at(-1))) : target,
  fstatSync: (fd: number) => ({ uid: process.geteuid?.(), nlink: 1,
    isDirectory: () => !fixture.descriptors.get(fd)?.endsWith("source.md"),
    isFile: () => fixture.descriptors.get(fd)?.endsWith("source.md") === true }),
}));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fixture.descriptors.clear(); fixture.nextFd = 100;
  fixture.worker = { version: 4, uid: 10001, gid: 10001 } as CloudWorkerConfiguration;
  fixture.loadWorker.mockImplementation(() => fixture.worker);
  fixture.loadPaths.mockReturnValue(fixture.mapping);
  fixture.open.mockImplementation((target: string) => { const fd = fixture.nextFd++; fixture.descriptors.set(fd, target); return fd; });
});
afterEach(() => vi.restoreAllMocks());

describe("admitted cloud publication routing", () => {
  it("publishes the trusted same-checkout alias by descriptor without sharing arbitrary repository roots", async () => {
    const ownership = await import("../cloud-workspace-ownership");
    const target = `${fixture.mapping.repositoryAlias}/nested/source.md`;
    fixture.descriptors.set(42, target);
    ownership.publishCloudWorkspacePath(target, 42);
    expect(fixture.changeOwner).toHaveBeenCalledWith(42, 10001, 10001);
    expect(fixture.changeOwner).toHaveBeenCalledTimes(2);
    expect(fixture.close).not.toHaveBeenCalledWith(42);
    fixture.changeOwner.mockClear(); fixture.open.mockClear();
    ownership.publishCloudWorkspacePath("/srv/zeros/repos/other/repo/source.md");
    expect(fixture.changeOwner).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("keeps alias-qualified private/nested-owner exclusions when recovering the logical checkout", async () => {
    const ownership = await import("../cloud-workspace-ownership");
    const recover = vi.spyOn(ownership.CloudWorkspaceOwnership.prototype, "recoverCompletely").mockResolvedValue({ visited: 0, published: 0, skipped: 0, failed: 0, bounded: false });
    await ownership.recoverCloudWorkspaceOwnership(fixture.worker, {
      ownerRoots: [`${fixture.mapping.repositoryAlias}/registered-owner`],
      privateRoots: [`${fixture.mapping.repositoryAlias}/private-storage`],
    });
    expect(recover).toHaveBeenCalledWith({
      ownerRoots: expect.arrayContaining(["/srv/zeros/workspace/registered-owner"]),
      privateRoots: expect.arrayContaining(["/srv/zeros/workspace/private-storage"]),
    });
  });

  it("keeps Local publication and recovery independent of cloud path admission", async () => {
    fixture.worker = null;
    const ownership = await import("../cloud-workspace-ownership");
    ownership.publishCloudWorkspacePath("/srv/zeros/workspace/source.md");
    expect(await ownership.recoverCloudWorkspaceOwnership(null)).toMatchObject({ visited: 0, published: 0 });
    expect(fixture.loadPaths).not.toHaveBeenCalled();
    expect(fixture.changeOwner).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });
});
