import { describe, expect, it } from "vitest";
import { developmentPaths } from "../../../engine/db/local-development-paths.cjs";
import {
  isWorktreePath,
  repoSlugFromWorktreePath,
  workspaceIdFromWorktreePath,
  workspaceKindFromManagedPath,
} from "../workspace-resolution";

// A new development identity keeps the visible root's flat shape, so the
// unchanged renderer matcher classifies its worktrees exactly as a legacy one.
describe("development visible root", () => {
  it("classifies a v2 identity's worktrees exactly as a legacy identity's", () => {
    const home = "/Users/dev";
    const classify = (root: string) => ({
      code: isWorktreePath(`${root}/workspaces/widgets/ws_1`),
      slug: repoSlugFromWorktreePath(`${root}/workspaces/widgets/ws_1/src/x.ts`),
      id: workspaceIdFromWorktreePath(`${root}/workspaces/widgets/ws_1`),
      design: workspaceKindFromManagedPath(`${root}/design workspaces/widgets/landing`),
      root: isWorktreePath(root),
    });
    for (const instance of ["a123456789abcdef", "alpha", "design-qual-0011aabb"]) {
      const v2 = developmentPaths({ instance, layout: "v2", home, platform: "darwin", env: {} });
      const legacy = developmentPaths({ instance, layout: instance === "a123456789abcdef" ? "legacy" : "v2", home, platform: "darwin", env: {} });
      expect(v2.visibleRoot).toBe(`${home}/zeros-local-${instance}`);
      expect(v2.workspacesRoot).toBe(`${v2.visibleRoot}/workspaces`);
      expect(classify(v2.visibleRoot)).toEqual(classify(legacy.visibleRoot));
      expect(classify(v2.visibleRoot)).toEqual({ code: true, slug: "widgets", id: "ws_1", design: "design", root: false });
    }
  });
});
