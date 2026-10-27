import { beforeEach, expect, it, vi } from "vitest";
import { statusForGeneration } from "../git-status-reads";
const read = vi.hoisted(() => vi.fn());
vi.mock("../../platform/git", () => ({
  gitStatus: read,
  gitChangeCounts: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({ conflicted: [] });
});
it("shares Local summary details with Changes and PR readers", async () => {
  await Promise.all([
    statusForGeneration("local-a", 1, "/a"),
    statusForGeneration("local-a", 1, "/a"),
  ]);
  expect(read).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledWith("local-a", { includeSummary: true });
});
it("keeps cloud status requests unchanged, including a VM path with a cloud identity", async () => {
  for (const path of ["cloud://org/workspace", "/home/user/owner/workspace"]) {
    read.mockClear();
    await statusForGeneration("cloud://org/workspace", 2, path);
    expect(read).toHaveBeenCalledWith("cloud://org/workspace");
  }
});
