import { describe, expect, it, vi } from "vitest";
import { readyCopyRestoreSource } from "./retention-restore-source.js";

const workspace = { id: "6f2b7c1e-3b0a-4f7e-9d43-8a0b2b9c6d11", organizationId: "org", projectId: "project" };
const copy = (result: { repositoryId: string; checkoutFolder?: string | null }[] | null, machineId: string | null = "bx_ready0001") =>
  ({ machineId, result }) as never;

describe("the machine a retention restore forks", () => {
  it("is the ready copy's when it is laid out as the workspace is", async () => {
    const copies = { forkable: vi.fn(async () => copy([{ repositoryId: "1", checkoutFolder: "proj/app" }, { repositoryId: "2", checkoutFolder: "proj/api" }])),
      workspaceLayout: vi.fn(async (): Promise<[string, string | null][]> => [["1", "proj/app"], ["2", "proj/api"]]) };
    expect(await readyCopyRestoreSource(copies)(workspace)).toBe("bx_ready0001");
    expect(copies.forkable).toHaveBeenCalledWith("org", "project", expect.any(Date));
  });

  it("is none for another layout, a copy without a machine or result, or a workspace without a project", async () => {
    const layout = vi.fn(async (): Promise<[string, string | null][]> => [["1", "proj/app"]]);
    for (const forkable of [copy([{ repositoryId: "1", checkoutFolder: "other/app" }]), copy([{ repositoryId: "1", checkoutFolder: "proj/app" }], null), copy(null), null])
      expect(await readyCopyRestoreSource({ forkable: async () => forkable, workspaceLayout: layout })(workspace)).toBeNull();
    const copies = { forkable: vi.fn(), workspaceLayout: layout };
    expect(await readyCopyRestoreSource(copies)({ ...workspace, projectId: undefined })).toBeNull();
    expect(copies.forkable).not.toHaveBeenCalled();
  });
});
