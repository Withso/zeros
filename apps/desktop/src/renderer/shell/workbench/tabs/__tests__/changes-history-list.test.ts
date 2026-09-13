import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitLog, type Commit } from "@/renderer/platform/git";
import { turnsList, type TurnInfo } from "@/renderer/platform/turns";
import { loadChangesCommits, loadChangesTurns } from "../changes-history-list";
vi.mock("@/renderer/platform/git", () => ({ gitLog: vi.fn() }));
vi.mock("@/renderer/platform/turns", () => ({ turnsList: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
describe("complete Changes history", () => {
  it("reads every commit page and pins later pages to the first HEAD", async () => {
    const commits = Array.from(
      { length: 507 },
      (_, i) => ({ sha: `sha-${i}` }) as Commit,
    );
    vi.mocked(gitLog)
      .mockResolvedValueOnce(commits.slice(0, 500))
      .mockResolvedValueOnce(commits.slice(500));
    expect(await loadChangesCommits("workspace", "main")).toEqual(commits);
    expect(gitLog).toHaveBeenLastCalledWith({
      workspaceId: "workspace",
      base: "main",
      limit: 500,
      skip: 500,
      ref: "sha-0",
    });
  });
  it("reads every turn page without losing selections past the old limit", async () => {
    const turns = Array.from(
      { length: 507 },
      (_, i) =>
        ({
          chatId: "chat",
          turnId: `turn-${i}`,
          startedAt: 1000 - i,
        }) as TurnInfo,
    );
    vi.mocked(turnsList)
      .mockResolvedValueOnce(turns.slice(0, 500))
      .mockResolvedValueOnce(turns.slice(500));
    expect(await loadChangesTurns("workspace")).toEqual(turns);
    expect(turnsList).toHaveBeenLastCalledWith("workspace", {
      limit: 500,
      offset: 500,
      before: 1000,
      after: { chatId: "chat", turnId: "turn-499", startedAt: 501 },
    });
  });
  it("rejects a failed later page instead of publishing a partial history", async () => {
    vi.mocked(gitLog)
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, () => ({ sha: "abc" }) as Commit),
      )
      .mockRejectedValueOnce(new Error("offline"));
    await expect(loadChangesCommits("workspace", "main")).rejects.toThrow(
      "offline",
    );
  });
});
