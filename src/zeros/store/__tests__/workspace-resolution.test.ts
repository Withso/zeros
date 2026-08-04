import { describe, expect, it } from "vitest";

import {
  findProjectForFolder,
  findWorkspaceForFolder,
  folderIsOwnedByProject,
  folderIsWithinRoot,
  isWorktreePath,
  repoRootForCwd,
  repoSlugFromWorktreePath,
  resolveWorkspacePresentationKind,
  workspaceKindFromManagedPath,
  resolveWorkspacePresentationFolder,
  workspaceIdFromWorktreePath,
  workspaceIdForCwd,
} from "../workspace-resolution";
import type { Project } from "../projects-store";

function project(
  overrides: Partial<Project> & Pick<Project, "repoRoot" | "repoSlug">,
): Project {
  return {
    id: `proj_${overrides.repoSlug}`,
    name: overrides.repoSlug,
    originUrl: null,
    addedAt: 0,
    ...overrides,
  };
}

describe("repoSlugFromWorktreePath", () => {
  it("extracts the slug from a legacy prod worktree path", () => {
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/.zeros/worktrees/zeros-mac/ws_abc123",
      ),
    ).toBe("zeros-mac");
  });

  it("extracts the slug from a legacy dev worktree path", () => {
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/.zeros-dev/worktrees/zeros-mac/ws_abc123/src",
      ),
    ).toBe("zeros-mac");
  });

  it("extracts the slug from the CURRENT ~/zeros/workspaces root (Phase 0)", () => {
    // Regression guard for the phantom-project bug: the relocated worktrees
    // root must resolve to its parent project's slug, not be treated as a repo.
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros/workspaces/widgets/ws_e14d72-phalaenopsis",
      ),
    ).toBe("widgets");
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros-dev/workspaces/widgets/ws_bbe7d6-delphinium/src",
      ),
    ).toBe("widgets");
  });

  it("extracts the owner from the sibling design-workspaces root", () => {
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros/design workspaces/widgets/landing-page",
      ),
    ).toBe("widgets");
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros-dev-montpellier-4281/design workspaces/widgets/landing-page/Zeros Design",
      ),
    ).toBe("widgets");
    expect(
      workspaceKindFromManagedPath(
        "/Users/dev/zeros/design workspaces/widgets/landing-page/Zeros Design",
      ),
    ).toBe("design");
    expect(
      workspaceKindFromManagedPath(
        "/Users/dev/zeros/workspaces/widgets/landing-page/src",
      ),
    ).toBe("code");
  });

  it("extracts the slug from a per-worktree DEV INSTANCE root (zeros-dev-<inst>)", () => {
    // Regression: the engine names an instanced dev root `zeros-dev-<slug>`
    // (e.g. `zeros-dev-mogadishu-5486`). The old `(?:-dev)?` regex only matched
    // bare `zeros`/`zeros-dev`, so an instanced dev worktree resolved to no
    // project → the topbar/chat showed "No workspace selected".
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros-dev-mogadishu-5486/workspaces/acme-widgets/ws_b47da6-myrtle",
      ),
    ).toBe("acme-widgets");
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros-dev-mogadishu-5486/workspaces/acme-widgets/ws_b47da6-myrtle/src/x.ts",
      ),
    ).toBe("acme-widgets");
    // Other channels (beta) + their instanced roots resolve too.
    expect(
      repoSlugFromWorktreePath("/Users/dev/zeros-beta/workspaces/widgets/ws_1"),
    ).toBe("widgets");
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/zeros-beta-abc-99/workspaces/widgets/ws_1",
      ),
    ).toBe("widgets");
  });

  it("returns null for paths outside the worktrees layout", () => {
    expect(repoSlugFromWorktreePath("/Users/dev/code/zeros")).toBeNull();
    expect(repoSlugFromWorktreePath("/Users/dev/.zeros/cache/foo")).toBeNull();
    expect(repoSlugFromWorktreePath("/Users/dev/Documents/widgets")).toBeNull();
    // A decoy folder that merely contains "zeros-dev" mid-segment must NOT match.
    expect(
      repoSlugFromWorktreePath(
        "/Users/dev/my-zeros-dev/workspaces/widgets/ws_1",
      ),
    ).toBeNull();
    expect(repoSlugFromWorktreePath("")).toBeNull();
  });

  it("requires a trailing path segment after the slug", () => {
    // Bare `<root>/<slug>` (no workspace id) shouldn't resolve, either layout.
    expect(
      repoSlugFromWorktreePath("/Users/dev/.zeros/worktrees/zeros-mac"),
    ).toBeNull();
    expect(
      repoSlugFromWorktreePath("/Users/dev/zeros/workspaces/widgets"),
    ).toBeNull();
  });
});

describe("resolveWorkspacePresentationKind", () => {
  const designPath =
    "/Users/dev/zeros/design workspaces/widgets/landing-page";

  it("lets a confirmed code workspace override every stale design hint", () => {
    expect(
      resolveWorkspacePresentationKind({
        confirmedKind: "code",
        pendingKind: "design",
        folder: designPath,
      }),
    ).toBe("code");
  });

  it("uses pending and managed-path identity only before a row confirms", () => {
    expect(
      resolveWorkspacePresentationKind({
        pendingKind: "design",
        folder: "/tmp/prepared",
      }),
    ).toBe("design");
    expect(
      resolveWorkspacePresentationKind({ folder: designPath }),
    ).toBe("design");
    expect(
      resolveWorkspacePresentationKind({ folder: "/tmp/plain" }),
    ).toBe("code");
  });
});

describe("isWorktreePath", () => {
  it("is true for both worktree roots (legacy + current), prod + dev", () => {
    expect(isWorktreePath("/Users/dev/.zeros/worktrees/zeros-mac/ws_a")).toBe(
      true,
    );
    expect(
      isWorktreePath("/Users/dev/.zeros-dev/worktrees/zeros-mac/ws_a"),
    ).toBe(true);
    expect(
      isWorktreePath(
        "/Users/dev/zeros/workspaces/widgets/ws_e14d72-phalaenopsis",
      ),
    ).toBe(true);
    expect(isWorktreePath("/Users/dev/zeros-dev/workspaces/widgets/ws_x")).toBe(
      true,
    );
    expect(
      isWorktreePath(
        "/Users/dev/zeros-dev/design workspaces/widgets/landing-page",
      ),
    ).toBe(true);
  });

  it("is false for a real repo checkout and nullish input", () => {
    expect(isWorktreePath("/Users/dev/Documents/widgets")).toBe(false);
    expect(isWorktreePath("/Users/dev/code/zeros")).toBe(false);
    expect(isWorktreePath(null)).toBe(false);
    expect(isWorktreePath(undefined)).toBe(false);
    expect(isWorktreePath("")).toBe(false);
  });
});

describe("workspaceIdFromWorktreePath", () => {
  it("extracts the workspace id (segment after the slug)", () => {
    expect(
      workspaceIdFromWorktreePath(
        "/Users/dev/.zeros/worktrees/zeros-mac/ws_abc123",
      ),
    ).toBe("ws_abc123");
  });

  it("works for the dev layout + tolerates a trailing subdir", () => {
    expect(
      workspaceIdFromWorktreePath(
        "/Users/dev/.zeros-dev/worktrees/zeros-mac/ws_abc123/src/shell",
      ),
    ).toBe("ws_abc123");
  });

  it("extracts the workspace id from the CURRENT ~/zeros/workspaces root", () => {
    expect(
      workspaceIdFromWorktreePath(
        "/Users/dev/zeros/workspaces/widgets/ws_e14d72-phalaenopsis",
      ),
    ).toBe("ws_e14d72-phalaenopsis");
    expect(
      workspaceIdFromWorktreePath(
        "/Users/dev/zeros-dev/workspaces/widgets/ws_bbe7d6-delphinium/src",
      ),
    ).toBe("ws_bbe7d6-delphinium");
  });

  it("does not mistake a human workspace directory for an opaque workspace id", () => {
    expect(
      workspaceIdFromWorktreePath(
        "/Users/dev/zeros/workspaces/widgets/delphinium-a12b/src",
      ),
    ).toBeNull();
  });

  it("returns null for the primary checkout / foreign / nullish paths", () => {
    expect(workspaceIdFromWorktreePath("/Users/dev/code/zeros")).toBeNull();
    expect(
      workspaceIdFromWorktreePath("/Users/dev/Cursor/worktrees/foo/bar"),
    ).toBeNull();
    expect(workspaceIdFromWorktreePath(null)).toBeNull();
    expect(workspaceIdFromWorktreePath("")).toBeNull();
  });

  it("returns null for a bare slug with no workspace id segment", () => {
    expect(
      workspaceIdFromWorktreePath("/Users/dev/.zeros/worktrees/zeros-mac"),
    ).toBeNull();
  });
});

describe("findWorkspaceForFolder", () => {
  const workspaces = [
    { path: "/Users/dev/.zeros/worktrees/zeros-mac/ws_a", id: "ws_a" },
    { path: "/var/folders/xy/ws_b", id: "ws_b" },
  ];

  it("matches an exact workspace path", () => {
    expect(
      findWorkspaceForFolder(
        "/Users/dev/.zeros/worktrees/zeros-mac/ws_a",
        workspaces,
      )?.id,
    ).toBe("ws_a");
  });

  it("matches a chat opened in a subdir of the workspace", () => {
    expect(
      findWorkspaceForFolder(
        "/Users/dev/.zeros/worktrees/zeros-mac/ws_a/src/shell",
        workspaces,
      )?.id,
    ).toBe("ws_a");
  });

  it("normalizes /private symlinks (folder /private/var ↔ workspace /var)", () => {
    expect(
      findWorkspaceForFolder("/private/var/folders/xy/ws_b", workspaces)?.id,
    ).toBe("ws_b");
  });

  it("returns null for an unrelated folder or nullish input", () => {
    expect(findWorkspaceForFolder("/Users/dev/other", workspaces)).toBeNull();
    expect(findWorkspaceForFolder(null, workspaces)).toBeNull();
  });

  it("does not match a sibling whose path is a string-prefix only", () => {
    // ws_a must NOT match a folder like `.../ws_a-2` (needs a path sep).
    expect(
      findWorkspaceForFolder(
        "/Users/dev/.zeros/worktrees/zeros-mac/ws_a-2",
        workspaces,
      ),
    ).toBeNull();
  });
});

describe("resolveWorkspacePresentationFolder", () => {
  const folder = "/workspaces/acme/new-workspace";

  it("presents a prepared Untitled chat before pending and server stores converge", () => {
    expect(
      resolveWorkspacePresentationFolder({
        activeFolder: folder,
        hasResolvedWorkspace: false,
        isProvisioning: false,
        pendingValidationFolder: folder,
        hasLiveChatAtActiveFolder: true,
      }),
    ).toBe(folder);
  });

  it("accepts confirmed and provisioning destinations", () => {
    expect(
      resolveWorkspacePresentationFolder({
        activeFolder: folder,
        hasResolvedWorkspace: true,
        isProvisioning: false,
        pendingValidationFolder: null,
        hasLiveChatAtActiveFolder: false,
      }),
    ).toBe(folder);
    expect(
      resolveWorkspacePresentationFolder({
        activeFolder: folder,
        hasResolvedWorkspace: false,
        isProvisioning: true,
        pendingValidationFolder: null,
        hasLiveChatAtActiveFolder: false,
      }),
    ).toBe(folder);
  });

  it("rejects stale, unrelated, and incomplete prepared identities", () => {
    const base = {
      activeFolder: folder,
      hasResolvedWorkspace: false,
      isProvisioning: false,
      pendingValidationFolder: folder,
      hasLiveChatAtActiveFolder: true,
    };
    expect(
      resolveWorkspacePresentationFolder({
        ...base,
        pendingValidationFolder: "/workspaces/acme/other",
      }),
    ).toBeNull();
    expect(
      resolveWorkspacePresentationFolder({
        ...base,
        hasLiveChatAtActiveFolder: false,
      }),
    ).toBeNull();
    expect(
      resolveWorkspacePresentationFolder({
        ...base,
        activeFolder: null,
      }),
    ).toBeNull();
  });
});

describe("folderIsWithinRoot", () => {
  it("matches exact and descendant owners across normalized path forms", () => {
    expect(folderIsWithinRoot("/repo/worktree", "/repo/worktree/")).toBe(true);
    expect(
      folderIsWithinRoot(
        "/private/var/folders/ws/packages/app",
        "/var/folders/ws",
      ),
    ).toBe(true);
  });

  it("does not treat a sibling string prefix as a descendant", () => {
    expect(folderIsWithinRoot("/repo/worktree-two", "/repo/worktree")).toBe(
      false,
    );
    expect(folderIsWithinRoot(null, "/repo/worktree")).toBe(false);
  });
});

describe("workspaceIdForCwd", () => {
  const workspaces = [
    { id: "local-main", path: "/Users/dev/code/zeros" },
    { id: "ws_a", path: "/Users/dev/zeros/workspaces/zeros/ws_a" },
  ];

  it("maps the primary checkout and subfolders to local-main from the workspace list", () => {
    expect(workspaceIdForCwd("/Users/dev/code/zeros", workspaces)).toBe(
      "local-main",
    );
    expect(workspaceIdForCwd("/Users/dev/code/zeros/src", workspaces)).toBe(
      "local-main",
    );
  });

  it("prefers the id embedded in a managed worktree path", () => {
    expect(
      workspaceIdForCwd(
        "/Users/dev/zeros/workspaces/zeros/ws_a/src",
        workspaces,
      ),
    ).toBe("ws_a");
  });

  it("passes through an existing workspace id from the workspace list", () => {
    expect(workspaceIdForCwd("local-main", workspaces)).toBe("local-main");
    expect(workspaceIdForCwd("ws_a", workspaces)).toBe("ws_a");
  });

  it("returns null when neither the path nor the workspace list resolves", () => {
    expect(workspaceIdForCwd("/Users/dev/other", workspaces)).toBeNull();
  });
});

describe("findProjectForFolder", () => {
  const projects: Project[] = [
    project({ repoRoot: "/Users/dev/code/zeros", repoSlug: "zeros-mac" }),
    project({ repoRoot: "/Users/dev/code/widgets", repoSlug: "widgets" }),
  ];

  it("returns null for empty / nullish folders", () => {
    expect(findProjectForFolder(null, projects)).toBeNull();
    expect(findProjectForFolder(undefined, projects)).toBeNull();
    expect(findProjectForFolder("", projects)).toBeNull();
  });

  it("matches via exact repoRoot", () => {
    const p = findProjectForFolder("/Users/dev/code/zeros", projects);
    expect(p?.repoSlug).toBe("zeros-mac");
  });

  it("matches via path prefix (folder under repoRoot)", () => {
    const p = findProjectForFolder("/Users/dev/code/zeros/src/shell", projects);
    expect(p?.repoSlug).toBe("zeros-mac");
  });

  it("chooses the most-specific nested repository owner", () => {
    const nested = [
      project({ repoRoot: "/code", repoSlug: "parent" }),
      project({ repoRoot: "/code/packages/child", repoSlug: "child" }),
    ];
    expect(
      findProjectForFolder("/code/packages/child/src", nested)?.repoSlug,
    ).toBe("child");
  });

  it("prefers a managed worktree identity over a broad repo-root prefix", () => {
    const nested = [
      project({ repoRoot: "/Users/dev", repoSlug: "parent" }),
      project({ repoRoot: "/code/zeros", repoSlug: "zeros-mac" }),
    ];
    expect(
      findProjectForFolder(
        "/Users/dev/zeros/workspaces/zeros-mac/ws_a/src",
        nested,
      )?.repoSlug,
    ).toBe("zeros-mac");
  });

  it("normalizes /private symlinks (folder /private/var ↔ repoRoot /var)", () => {
    // Finder/Electron hands back `/private/var/…` while the stored repoRoot
    // is `/var/…` (or vice versa); both must resolve the same project —
    // parity with findWorkspaceForFolder.
    const stored = [
      project({ repoRoot: "/var/folders/xy/scratch", repoSlug: "scratch" }),
    ];
    expect(
      findProjectForFolder("/private/var/folders/xy/scratch", stored)?.repoSlug,
    ).toBe("scratch");
    // Reverse: stored /private, queried /var, plus a subdir (prefix match).
    const priv = [
      project({
        repoRoot: "/private/var/folders/xy/scratch",
        repoSlug: "scratch",
      }),
    ];
    expect(
      findProjectForFolder("/var/folders/xy/scratch/src", priv)?.repoSlug,
    ).toBe("scratch");
  });

  it("matches via worktree slug embedded in the path (legacy root)", () => {
    const p = findProjectForFolder(
      "/Users/dev/.zeros/worktrees/zeros-mac/ws_xyz",
      projects,
    );
    expect(p?.repoSlug).toBe("zeros-mac");
  });

  it("matches via worktree slug embedded in the path (current ~/zeros/workspaces root)", () => {
    // The widgets project owns ~/zeros/workspaces/widgets/ws_* worktrees; they must
    // group UNDER widgets, not appear as their own phantom projects.
    const p = findProjectForFolder(
      "/Users/dev/zeros/workspaces/widgets/ws_e14d72-phalaenopsis",
      projects,
    );
    expect(p?.repoSlug).toBe("widgets");
  });

  it("matches the current human layout by repository basename when slug includes an owner", () => {
    const owned = [
      project({
        repoRoot: "/Users/dev/Documents/widgets",
        repoSlug: "acme-widgets",
      }),
    ];
    expect(
      findProjectForFolder(
        "/Users/dev/zeros/workspaces/widgets/delphinium-a12b/src",
        owned,
      )?.repoSlug,
    ).toBe("acme-widgets");
  });

  it("does not guess between repositories with the same basename", () => {
    const collisions = [
      project({ repoRoot: "/Users/a/app", repoSlug: "a-app" }),
      project({ repoRoot: "/Users/b/app", repoSlug: "b-app" }),
    ];
    expect(
      findProjectForFolder(
        "/Users/dev/zeros/workspaces/app/delphinium-a12b",
        collisions,
      ),
    ).toBeNull();
  });

  it("returns null when no project matches", () => {
    expect(findProjectForFolder("/Users/dev/other-repo", projects)).toBeNull();
  });

  it("does not match a different project whose repoRoot is a string prefix without a path separator", () => {
    // "/Users/dev/code/zeros" must NOT match "/Users/dev/code/zeros-prime"
    // — the prefix check requires the next char be a "/".
    const cousin = project({
      repoRoot: "/Users/dev/code/zeros-prime",
      repoSlug: "zeros-prime",
    });
    const p = findProjectForFolder("/Users/dev/code/zeros-prime/src", [
      projects[0]!,
      cousin,
    ]);
    expect(p?.repoSlug).toBe("zeros-prime");
  });
});

describe("folderIsOwnedByProject", () => {
  const nested = [
    project({ repoRoot: "/code", repoSlug: "parent" }),
    project({ repoRoot: "/code/packages/child", repoSlug: "child" }),
  ];

  it("protects a known nested repository during parent cleanup", () => {
    expect(
      folderIsOwnedByProject(
        "/code/packages/child/src",
        "proj_parent",
        nested,
        ["/code"],
      ),
    ).toBe(false);
  });

  it("uses deletion roots for a stale path with no remaining owner", () => {
    expect(
      folderIsOwnedByProject(
        "/external/worktree/packages/app",
        "proj_parent",
        nested,
        ["/external/worktree"],
      ),
    ).toBe(true);
  });
});

describe("repoRootForCwd", () => {
  const workspaces = [
    {
      id: "ws_abc123",
      path: "/Users/dev/zeros/workspaces/widgets/ws_abc123",
      repoRoot: "/Users/dev/Documents/Widgets",
    },
    {
      id: "local-main",
      path: "/Users/dev/Documents/Widgets",
      repoRoot: "/Users/dev/Documents/Widgets",
    },
  ];
  it("resolves a managed worktree (and a subdirectory of it) to the MAIN repo root", () => {
    expect(
      repoRootForCwd(
        "/Users/dev/zeros/workspaces/widgets/ws_abc123",
        workspaces,
      ),
    ).toBe("/Users/dev/Documents/Widgets");
    expect(
      repoRootForCwd(
        "/Users/dev/zeros/workspaces/widgets/ws_abc123/src/deep",
        workspaces,
      ),
    ).toBe("/Users/dev/Documents/Widgets");
  });

  it("resolves the primary checkout and its subdirectories", () => {
    expect(repoRootForCwd("/Users/dev/Documents/Widgets", workspaces)).toBe(
      "/Users/dev/Documents/Widgets",
    );
    expect(repoRootForCwd("/Users/dev/Documents/Widgets/src", workspaces)).toBe(
      "/Users/dev/Documents/Widgets",
    );
  });

  it("matches the repoRoot even when no workspace row carries the path", () => {
    // Repo with vars but only worktree rows: cwd under repoRoot still resolves.
    const worktreeOnly = [workspaces[0]!];
    expect(
      repoRootForCwd("/Users/dev/Documents/Widgets/pkg", worktreeOnly),
    ).toBe("/Users/dev/Documents/Widgets");
  });

  it("returns null for a plain folder and for a missing cwd", () => {
    expect(repoRootForCwd("/Users/dev/elsewhere", workspaces)).toBeNull();
    expect(repoRootForCwd(null, workspaces)).toBeNull();
    expect(repoRootForCwd(undefined, workspaces)).toBeNull();
  });

  it("does not cross a sibling whose root is a string prefix (no separator)", () => {
    const prefixy = [
      { id: "a", path: "/r/widgets", repoRoot: "/r/widgets" },
      { id: "b", path: "/r/widgets-prime", repoRoot: "/r/widgets-prime" },
    ];
    expect(repoRootForCwd("/r/widgets-prime/src", prefixy)).toBe(
      "/r/widgets-prime",
    );
  });
});
