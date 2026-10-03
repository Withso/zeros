import { describe, expect, it } from "vitest";
import {
  buildLocalMainWorkspace,
  withFolderWorkspaces,
} from "../local-main-workspace";
import type { Project } from "../projects-store";
import type { Workspace } from "../../platform/git";

const folder: Project = {
  id: "proj_folder",
  name: "Custom project name",
  repoRoot: "/projects/To-do app",
  repoSlug: "to-do-app",
  originUrl: null,
  addedAt: 100,
  isGitRepository: false,
};

describe("previously opened folder workspaces", () => {
  it("restores an existing folder workspace with its name and exact working directory", () => {
    const [workspace] = withFolderWorkspaces(
      [folder],
      [],
      new Set([folder.repoRoot]),
    );
    expect(workspace).toMatchObject({
      id: "local:to-do-app",
      branch: "To-do app",
      path: folder.repoRoot,
      repoRoot: folder.repoRoot,
      present: true,
    });
  });

  it("never offers a fresh root workspace just because a project was registered", () => {
    const rows: Workspace[] = [];
    for (const isGitRepository of [false, true, undefined]) {
      expect(withFolderWorkspaces([{ ...folder, isGitRepository }], rows)).toBe(
        rows,
      );
    }
  });

  it("restores a saved subdirectory without changing its cwd or repository identity", () => {
    const cwd = `${folder.repoRoot}/packages/app`;
    expect(withFolderWorkspaces([folder], [], new Set([cwd]))).toEqual([
      { ...buildLocalMainWorkspace(folder), path: cwd },
    ]);
  });

  it("restores the last original-folder cwd after switching between repositories", () => {
    const first = `${folder.repoRoot}/packages/first`;
    const second = `${folder.repoRoot}/packages/second`;
    const opened = new Set([folder.repoRoot, first, second]);
    for (const cwd of [first, second, first]) {
      expect(
        withFolderWorkspaces([folder], [], opened, {
          [folder.repoRoot]: cwd,
        }),
      ).toEqual([{ ...buildLocalMainWorkspace(folder), path: cwd }]);
    }
    // A later worktree selection must not replace the saved folder destination.
    expect(
      withFolderWorkspaces([folder], [], opened, {
        [folder.repoRoot]: "/worktrees/other",
      }),
    ).toEqual([buildLocalMainWorkspace(folder)]);
  });

  it("gives a saved subdirectory to its most-specific registered owner", () => {
    const parent = { ...folder, repoRoot: "/tmp/repo" };
    const nested = {
      ...folder,
      id: "proj_nested",
      repoRoot: "/tmp/repo/nested",
      repoSlug: "nested",
    };
    const cwd = "/private/tmp/repo/nested/packages/app";
    for (const projects of [[parent, nested], [nested, parent]]) {
      expect(withFolderWorkspaces(projects, [], new Set([cwd]))).toEqual([
        { ...buildLocalMainWorkspace(nested), path: cwd },
      ]);
    }
    const rows: Workspace[] = [];
    expect(
      withFolderWorkspaces([parent], rows, new Set(["/tmp/repo-other/app"])),
    ).toBe(rows);
  });

  it("does not synthesize original-folder rows from managed worktree subdirectories", () => {
    const managed = {
      ...buildLocalMainWorkspace(folder),
      id: "ws_existing",
      path: `${folder.repoRoot}/worktrees/existing`,
    };
    const rows = [managed];
    expect(
      withFolderWorkspaces([folder], rows, new Set([`${managed.path}/src`])),
    ).toBe(rows);
    // Recognize managed layouts even before their exact workspace cache loads.
    const coldRows: Workspace[] = [];
    expect(
      withFolderWorkspaces(
        [folder],
        coldRows,
        new Set([`${folder.repoRoot}/zeros/workspaces/to-do-app/ws_existing/src`]),
      ),
    ).toBe(coldRows);
  });

  it("deduplicates existing root rows and keeps managed workspaces intact", () => {
    const root = buildLocalMainWorkspace(folder);
    const managed = { ...root, id: "ws_other", path: "/worktrees/other" };
    const rows = [root, managed];
    expect(
      withFolderWorkspaces([folder], rows, new Set([folder.repoRoot])),
    ).toBe(rows);
    expect(
      withFolderWorkspaces([folder], [managed], new Set([folder.repoRoot]))[1],
    ).toBe(managed);
  });

  it("keeps folder names and cwd values isolated across repositories", () => {
    const other = {
      ...folder,
      id: "proj_other",
      repoRoot: "/projects/Notes",
      repoSlug: "notes",
    };
    const workspaces = withFolderWorkspaces(
      [folder, other],
      [],
      new Set([folder.repoRoot, other.repoRoot]),
    );
    expect(workspaces.map((w) => [w.id, w.branch, w.path])).toEqual([
      ["local:to-do-app", "To-do app", "/projects/To-do app"],
      ["local:notes", "Notes", "/projects/Notes"],
    ]);
  });

  it("preserves the root workspace identity and Git checkout label after initialization", () => {
    const initialized = buildLocalMainWorkspace({
      ...folder,
      isGitRepository: true,
    });
    expect(initialized.id).toBe(buildLocalMainWorkspace(folder).id);
    expect(initialized.branch).toBe("main");
    expect(initialized.path).toBe(folder.repoRoot);
  });

  it.each([true, undefined])(
    "does not restore local main from saved checkout history with Git capability %s",
    (isGitRepository) => {
      const project = { ...folder, isGitRepository };
      const cwd = `${project.repoRoot}/packages/app`;
      const rows: Workspace[] = [];
      expect(
        withFolderWorkspaces([project], rows, new Set([project.repoRoot, cwd]), {
          [project.repoRoot]: cwd,
        }),
      ).toBe(rows);

      const managed = {
        ...buildLocalMainWorkspace(project),
        id: "ws_main_branch",
        path: "/worktrees/main",
      };
      const managedRows = [managed];
      expect(
        withFolderWorkspaces([project], managedRows, new Set([cwd])),
      ).toBe(managedRows);
    },
  );

  it("does not assign a nested Git checkout's saved chats to its plain-folder parent", () => {
    const nested = {
      ...folder,
      id: "proj_nested",
      repoRoot: `${folder.repoRoot}/nested`,
      repoSlug: "nested",
      isGitRepository: true,
    };
    const rows: Workspace[] = [];
    expect(
      withFolderWorkspaces(
        [folder, nested],
        rows,
        new Set([`${nested.repoRoot}/src`]),
      ),
    ).toBe(rows);
  });

  it("keeps cloud primary workspaces in their catalog", () => {
    const path =
      "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const project = { ...folder, repoRoot: path, isGitRepository: true };
    const rows: Workspace[] = [
      {
        ...buildLocalMainWorkspace(project),
        id: path,
        placement: "cloud",
      },
    ];
    expect(withFolderWorkspaces([project], rows, new Set([path]))).toBe(rows);
  });

  it("keeps previously opened plain folders reachable", () => {
    const opened = new Set([folder.repoRoot]);
    const [workspace] = withFolderWorkspaces([folder], [], opened);
    expect(workspace.path).toBe(folder.repoRoot);
    expect(workspace.id).toBe("local:to-do-app");
    expect(withFolderWorkspaces([], [], opened)).toEqual([]);
    expect(withFolderWorkspaces([folder], [], new Set(["/other"]))).toEqual([]);
  });
});
