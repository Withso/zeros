import { beforeEach, expect, it } from "vitest";
import {
  adoptedWorktreeSlug,
  recordAdoptedWorktree,
} from "../adopted-worktrees";
import type { Project } from "../projects-store";
import {
  findProjectForFolder,
  folderIsOwnedByProject,
} from "../workspace-resolution";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

it("resolves a reconnected folder's descendant chats to their most specific owner", () => {
  recordAdoptedWorktree("/var/moved/workspace/", "outer");
  recordAdoptedWorktree("/var/moved/workspace/nested", "inner");
  expect(adoptedWorktreeSlug("/private/var/moved/workspace/packages/app")).toBe(
    "outer",
  );
  expect(adoptedWorktreeSlug("/var/moved/workspace/nested/src")).toBe("inner");
  expect(adoptedWorktreeSlug("/var/moved/workspace-other")).toBeNull();
});

it("protects a registered nested repository when deleting an adopted worktree's owner", () => {
  const outer: Project = {
    id: "outer",
    name: "Outer",
    repoRoot: "/repos/outer",
    repoSlug: "outer",
    originUrl: null,
    addedAt: 1,
  };
  const container: Project = {
    ...outer,
    id: "container",
    repoSlug: "container",
    repoRoot: "/var/moved",
  };
  const nested: Project = {
    ...outer,
    id: "nested",
    repoSlug: "nested",
    repoRoot: "/private/var/moved/workspace/nested/",
  };
  const projects = [container, outer, nested];
  recordAdoptedWorktree("/var/moved/workspace", outer.repoSlug);

  expect(
    findProjectForFolder("/var/moved/workspace/nested/src", projects),
  ).toBe(nested);
  expect(
    folderIsOwnedByProject(
      "/var/moved/workspace/nested/src",
      outer.id,
      projects,
    ),
  ).toBe(false);
  expect(
    folderIsOwnedByProject(
      "/var/moved/workspace/nested/src",
      nested.id,
      projects,
    ),
  ).toBe(true);
  expect(
    findProjectForFolder("/private/var/moved/workspace/src", projects),
  ).toBe(outer);
  expect(findProjectForFolder("/var/moved/workspace-other/src", projects)).toBe(
    container,
  );

  // A worktree adopted inside the nested checkout has its own, deeper owner.
  recordAdoptedWorktree("/var/moved/workspace/nested/worktree", outer.repoSlug);
  expect(
    findProjectForFolder("/var/moved/workspace/nested/worktree/src", projects),
  ).toBe(outer);
});
