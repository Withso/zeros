import { describe, expect, it } from "vitest";

import type { Workspace } from "../../../platform/git";
import { resolveCardActionKind } from "../workspace-card-action";

/** A live, unremarkable workspace: present on disk, no PR. Dirtiness is now
 *  passed to resolveCardActionKind as its own (tri-state) argument, so
 *  `hasChanges` on the row itself is irrelevant here. */
function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoSlug: "acme/app",
    repoRoot: "/repo",
    branch: "zeros/moonflower-a162",
    baseBranch: "main",
    path: "/repo/.worktrees/moonflower-a162",
    status: "in-progress",
    createdAt: 0,
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

describe("resolveCardActionKind", () => {
  it("nothing done → no action", () => {
    expect(resolveCardActionKind(makeWorkspace(), false)).toBeNull();
  });

  it("local changes, no PR → create-pr", () => {
    expect(resolveCardActionKind(makeWorkspace(), true)).toBe("create-pr");
  });

  it("open PR + local changes → commit-push", () => {
    expect(
      resolveCardActionKind(
        makeWorkspace({ prNumber: 7, prState: "ready" }),
        true,
      ),
    ).toBe("commit-push");
  });

  it("draft PR, clean tree → ready-for-review", () => {
    expect(
      resolveCardActionKind(
        makeWorkspace({ prNumber: 7, prState: "draft" }),
        false,
      ),
    ).toBe("ready-for-review");
  });

  it("open (ready) PR, clean tree → merge", () => {
    expect(
      resolveCardActionKind(
        makeWorkspace({ prNumber: 7, prState: "ready" }),
        false,
      ),
    ).toBe("merge");
  });

  it("merged PR → archive (regardless of change probe)", () => {
    expect(
      resolveCardActionKind(
        makeWorkspace({ prNumber: 7, prState: "merged" }),
        undefined,
      ),
    ).toBe("archive");
  });

  it("closed PR → archive (regardless of change probe)", () => {
    expect(
      resolveCardActionKind(
        makeWorkspace({ prNumber: 7, prState: "closed" }),
        undefined,
      ),
    ).toBe("archive");
  });

  // The anti-footgun the tri-state exists for: while the lazy change probe is
  // still in flight (hasChanges === undefined), an OPEN non-draft PR must NOT
  // resolve to the destructive "merge" (which would be wrong if there is
  // uncommitted work). It shows no button until the probe lands.
  describe("unresolved change probe (hasChanges === undefined)", () => {
    it("open (ready) PR → no button, NEVER merge", () => {
      expect(
        resolveCardActionKind(
          makeWorkspace({ prNumber: 7, prState: "ready" }),
          undefined,
        ),
      ).toBeNull();
    });

    it("draft PR → no button", () => {
      expect(
        resolveCardActionKind(
          makeWorkspace({ prNumber: 7, prState: "draft" }),
          undefined,
        ),
      ).toBeNull();
    });

    it("no PR → no button", () => {
      expect(resolveCardActionKind(makeWorkspace(), undefined)).toBeNull();
    });
  });

  // A worktree deleted out-of-band (present:false, row still live + un-archived)
  // is an ORPHAN. It must resolve to "delete" regardless of PR/change state —
  // the folder is gone, so nothing else is actionable (the phantom-card bug).
  describe("orphaned workspace (present === false)", () => {
    it("plain orphan → delete", () => {
      expect(resolveCardActionKind(makeWorkspace({ present: false }), false)).toBe(
        "delete",
      );
    });

    it("delete takes priority over a merged PR", () => {
      expect(
        resolveCardActionKind(
          makeWorkspace({ present: false, prNumber: 7, prState: "merged" }),
          undefined,
        ),
      ).toBe("delete");
    });

    it("delete takes priority over an open PR with local changes", () => {
      expect(
        resolveCardActionKind(
          makeWorkspace({ present: false, prNumber: 7, prState: "ready" }),
          true,
        ),
      ).toBe("delete");
    });
  });

  it("present:undefined is treated as live, not orphaned", () => {
    // Only an explicit `false` means "gone" — undefined is not an orphan signal
    // (the engine's stampPresence always writes a boolean, and the
    // WorktreeMissingPanel gate is likewise `present === false`).
    expect(
      resolveCardActionKind(makeWorkspace({ present: undefined }), true),
    ).toBe("create-pr");
  });
});
