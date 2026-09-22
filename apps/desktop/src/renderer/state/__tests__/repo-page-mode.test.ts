import { describe, expect, it } from "vitest";
import type { Project } from "../projects-store";
import {
  effectiveRepoPageView,
  isRepoPageViewAvailable,
} from "../repo-page-mode";
import type { RepoPageView } from "../store";

const folder: Project = {
  id: "folder",
  name: "Notes",
  repoRoot: "/fixture/Notes",
  repoSlug: "notes",
  originUrl: null,
  addedAt: 1,
  isGitRepository: false,
};

describe("repository settings capabilities", () => {
  it.each<RepoPageView>(["workspaces", "git", "files"])(
    "falls back synchronously from saved %s for a plain folder",
    (view) => {
      expect(isRepoPageViewAvailable(folder, view)).toBe(false);
      expect(effectiveRepoPageView(folder, view)).toBe("environment");
      // Initializing Git restores the saved view without changing owner or preference.
      expect(
        effectiveRepoPageView({ ...folder, isGitRepository: true }, view),
      ).toBe(view);
    },
  );

  it.each<RepoPageView>([
    "environment",
    "actions",
    "paths",
    "design",
    "design-preferences",
  ])("keeps %s available without Git", (view) => {
    expect(isRepoPageViewAvailable(folder, view)).toBe(true);
    expect(effectiveRepoPageView(folder, view)).toBe(view);
  });

  it.each([true, undefined])(
    "preserves local Git and legacy settings when isGitRepository is %s",
    (isGitRepository) => {
      const project = { ...folder, isGitRepository };
      for (const view of ["workspaces", "git", "files"] as const) {
        expect(isRepoPageViewAvailable(project, view)).toBe(true);
        expect(effectiveRepoPageView(project, view)).toBe(view);
      }
    },
  );
});
