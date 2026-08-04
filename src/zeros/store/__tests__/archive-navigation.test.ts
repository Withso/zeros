import { describe, expect, it } from "vitest";

import type { Workspace } from "../../../native/git";
import { previousWorkspaceInOrder } from "../archive-navigation";

function workspace(
  id: string,
  createdAt: number,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    repoSlug: "acme-app",
    repoRoot: "/repo",
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/worktrees/${id}`,
    status: "in-progress",
    createdAt,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    present: true,
    ...overrides,
  };
}

describe("previousWorkspaceInOrder", () => {
  it("chooses the nearest live tab to the left regardless of cache order", () => {
    const first = workspace("first", 1);
    const second = workspace("second", 2);
    const leaving = workspace("leaving", 3);
    expect(
      previousWorkspaceInOrder(leaving, [leaving, first, second], {}),
    ).toBe(second);
  });

  it("skips archived, missing, and concurrently disappearing predecessors", () => {
    const survivor = workspace("survivor", 1);
    const archived = workspace("archived", 2, { archivedAt: 10 });
    const missing = workspace("missing", 3, { present: false });
    const busy = workspace("busy", 4);
    const leaving = workspace("leaving", 5);
    expect(
      previousWorkspaceInOrder(
        leaving,
        [leaving, busy, missing, survivor, archived],
        { busy: 1, leaving: 1 },
      ),
    ).toBe(survivor);
  });

  it("returns null for the first worktree so callers fall back to Local main", () => {
    const leaving = workspace("leaving", 1);
    const later = workspace("later", 2);
    expect(previousWorkspaceInOrder(leaving, [later, leaving], {})).toBeNull();
  });

  it("uses id as the stable tie-breaker, matching the top-bar order", () => {
    const alpha = workspace("alpha", 1);
    const beta = workspace("beta", 1);
    expect(previousWorkspaceInOrder(beta, [beta, alpha], {})).toBe(alpha);
  });

  it("keeps the predecessor when a confirmed refresh already dropped the leaving row", () => {
    const first = workspace("first", 1);
    const predecessor = workspace("predecessor", 2);
    const leaving = workspace("leaving", 3);
    expect(
      previousWorkspaceInOrder(leaving, [predecessor, first], {
        leaving: 1,
      }),
    ).toBe(predecessor);
  });

  it("skips a hidden Design predecessor when Design access is disabled", () => {
    const code = workspace("code", 1);
    const design = workspace("design", 2, { kind: "design" });
    const leaving = workspace("leaving", 3);

    expect(
      previousWorkspaceInOrder(leaving, [code, design, leaving], {}, {
        allowDesignWorkspaces: false,
      }),
    ).toBe(code);
  });
});
