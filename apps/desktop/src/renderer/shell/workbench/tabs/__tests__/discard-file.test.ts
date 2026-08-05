import { beforeEach, describe, expect, it, vi } from "vitest";

const gitMocks = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitClean: vi.fn(),
  gitUnstage: vi.fn(),
  gitDiscard: vi.fn(),
}));

vi.mock("@/renderer/platform/git", () => gitMocks);

import type { StatusResult } from "@/renderer/platform/git";
import { discardPath, planDiscard } from "../discard-file";

function status(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    conflictState: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gitMocks.gitClean.mockResolvedValue({ removed: [] });
  gitMocks.gitUnstage.mockResolvedValue(undefined);
  gitMocks.gitDiscard.mockResolvedValue(undefined);
});

describe("planDiscard", () => {
  it("cleans an untracked file and closes its path", () => {
    expect(
      planDiscard(status({ untracked: ["scratch.txt"] }), "scratch.txt"),
    ).toEqual({
      operation: "clean",
      outcome: "removed",
      isNewFile: true,
    });
  });

  it("unstages then cleans staged-new and intent-to-add paths", () => {
    for (const side of ["staged", "unstaged"] as const) {
      expect(
        planDiscard(
          status({ [side]: [{ path: "new.ts", status: "added" }] }),
          "new.ts",
        ),
      ).toEqual({
        operation: "unstage-clean",
        outcome: "removed",
        isNewFile: true,
      });
    }
  });

  it("reverts a tracked modification and keeps the path open", () => {
    expect(
      planDiscard(
        status({ unstaged: [{ path: "tracked.ts", status: "modified" }] }),
        "tracked.ts",
      ),
    ).toEqual({
      operation: "discard",
      outcome: "reverted",
      isNewFile: false,
    });
  });

  it("closes a rename destination because revert restores the old path", () => {
    expect(
      planDiscard(
        status({
          staged: [
            { path: "new-name.ts", oldPath: "old-name.ts", status: "renamed" },
          ],
        }),
        "new-name.ts",
      ),
    ).toEqual({
      operation: "discard",
      outcome: "removed",
      isNewFile: false,
      restorePaths: ["old-name.ts", "new-name.ts"],
    });
  });

  it("defaults a just-cleaned/raced tracked path to a harmless revert", () => {
    expect(planDiscard(status(), "tracked.ts")).toEqual({
      operation: "discard",
      outcome: "reverted",
      isNewFile: false,
    });
  });

  it("executes the planned operation and returns its path outcome", async () => {
    gitMocks.gitStatus.mockResolvedValue(
      status({ staged: [{ path: "new.ts", status: "added" }] }),
    );

    await expect(discardPath("workspace", "new.ts")).resolves.toBe("removed");
    expect(gitMocks.gitUnstage).toHaveBeenCalledWith({
      workspaceId: "workspace",
      paths: ["new.ts"],
    });
    expect(gitMocks.gitClean).toHaveBeenCalledWith({
      workspaceId: "workspace",
      paths: ["new.ts"],
    });
    expect(gitMocks.gitDiscard).not.toHaveBeenCalled();
    expect(gitMocks.gitUnstage.mock.invocationCallOrder[0]).toBeLessThan(
      gitMocks.gitClean.mock.invocationCallOrder[0],
    );
  });

  it("restores both sides of a rename", async () => {
    gitMocks.gitStatus.mockResolvedValue(
      status({
        unstaged: [{ path: "new.ts", oldPath: "old.ts", status: "renamed" }],
      }),
    );

    await expect(discardPath("workspace", "new.ts")).resolves.toBe("removed");
    expect(gitMocks.gitDiscard).toHaveBeenCalledWith({
      workspaceId: "workspace",
      paths: ["old.ts", "new.ts"],
    });
  });
});
