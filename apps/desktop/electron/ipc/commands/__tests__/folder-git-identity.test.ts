import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceInspectFolder } from "../git";
import { runFile } from "../../../../src/engine/git/git-exec";

vi.mock("../../../../src/engine/git", () => ({
  isGitError: () => false,
  isRepo: async () => false,
}));
vi.mock("../../../../src/engine/git/git-exec", () => ({ runFile: vi.fn() }));
const run = vi.mocked(runFile);
const inspect = () =>
  workspaceInspectFolder({ path: "/fixture/folder" }, {} as never);
beforeEach(() => run.mockReset());

describe("folder capability inspection failures", () => {
  it("recognizes a confirmed non-Git directory", async () => {
    run.mockRejectedValueOnce({
      code: 128,
      stderr:
        "fatal: not a git repository (or any of the parent directories): .git",
    });
    await expect(inspect()).resolves.toMatchObject({
      isRepo: false,
      originUrl: null,
    });
  });
  it.each([
    {
      code: 128,
      stderr: "fatal: cannot change to '/fixture/folder': Permission denied",
    },
    {
      code: 128,
      stderr:
        "fatal: cannot change to '/fixture/folder': No such file or directory",
    },
    { code: "ENOENT", stderr: "" },
    { code: 128, stderr: "fatal: detected dubious ownership in repository" },
  ])(
    "rejects an inconclusive probe instead of reporting Git removed: %j",
    async (failure) => {
      run.mockRejectedValueOnce(failure);
      await expect(inspect()).rejects.toBeDefined();
    },
  );
  it("does not treat an unreadable Git config as a removed origin", async () => {
    run.mockResolvedValueOnce({ stdout: ".git\n", stderr: "" });
    run.mockRejectedValueOnce({
      code: 128,
      stderr: "fatal: unable to read config file: Permission denied",
    });
    await expect(inspect()).rejects.toBeDefined();
  });

  it("recognizes Git without an origin or first commit", async () => {
    run.mockResolvedValueOnce({ stdout: ".git\n", stderr: "" });
    run.mockRejectedValueOnce({ code: 1, stderr: "" });
    await expect(inspect()).resolves.toMatchObject({
      isRepo: true,
      originUrl: null,
      hasCommits: false,
    });
  });
});
