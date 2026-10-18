import { afterEach, describe, expect, it, vi } from "vitest";
const placement = vi.hoisted(() => ({ cloud: false }));
vi.mock("../git-execution-identity", async (original) => ({
  ...(await original<typeof import("../git-execution-identity")>()),
  gitExecutionIdentity: () => placement.cloud ? { uid: 10003, gid: 10003 } : undefined,
}));
import * as git from "../git-exec";
import { listIgnoredEntries } from "../workspace-files";

afterEach(() => { placement.cloud = false; vi.restoreAllMocks(); });

describe("ignored-file observation sharing", () => {
  it.each([false, true])("shares only simultaneous exact Local observations, cloud=%s", async (cloud) => {
    placement.cloud = cloud;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.spyOn(git, "runGit").mockImplementation(async () => { await gate; return { stdout: "ignored.txt\0", stderr: "" }; });
    const requests = Array.from({ length: 4 }, () => listIgnoredEntries("/fixture"));
    expect(read).toHaveBeenCalledTimes(cloud ? 4 : 1);
    release();
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 4 }, () => ["ignored.txt"]));
    await listIgnoredEntries("/fixture");
    expect(read).toHaveBeenCalledTimes(cloud ? 5 : 2);
  });

  it("keeps worktrees and result limits separate and retires a failed scan", async () => {
    const read = vi.spyOn(git, "runGit").mockResolvedValue({ stdout: "one\0two\0", stderr: "" });
    expect(await Promise.all([listIgnoredEntries("/a", undefined, 1), listIgnoredEntries("/a", undefined, 2), listIgnoredEntries("/b", undefined, 1)])).toEqual([["one"], ["one", "two"], ["one"]]);
    expect(read).toHaveBeenCalledTimes(3);
    read.mockRejectedValueOnce(new Error("interrupted"));
    expect(await listIgnoredEntries("/a")).toEqual([]);
    expect(await listIgnoredEntries("/a")).toEqual(["one", "two"]);
  });
});
