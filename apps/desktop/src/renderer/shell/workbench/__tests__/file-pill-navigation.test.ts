import { afterEach, describe, expect, it, vi } from "vitest";
import { relativeWorkspaceFilePath } from "@/renderer/platform/workspace-file-path";
import {
  buildFilePillOpenAction,
  openFilePill,
  warmFilePill,
} from "../file-pill-navigation";
import { useWorkspaceStore } from "@/renderer/state/store";
import * as workspaces from "@/renderer/state/use-projects";
import * as changesFilter from "../tabs/changes-filter-store";
import * as changesSnapshots from "../tabs/changes-snapshot-cache";
import * as fileData from "../../workspace-file-data-cache";
import { createChangesTab, createFilesTab } from "../tab-model";
import {
  resetWorkbenchEditorDirtyForTests,
  setWorkbenchEditorDirty,
} from "../tabs/code-editor/editor-state";

const cloud =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const otherCloud =
  "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
afterEach(() => {
  resetWorkbenchEditorDirtyForTests();
  vi.restoreAllMocks();
});

describe("file pill paths", () => {
  it.each(["/personal/project", "/organization/project", cloud])(
    "keeps literal names in %s",
    (cwd) => {
      expect(
        relativeWorkspaceFilePath(
          cwd,
          "./.context/attachments/abc/Screenshot ü #1.png",
        ),
      ).toBe(".context/attachments/abc/Screenshot ü #1.png");
      expect(relativeWorkspaceFilePath(cwd, "a//same.ts")).toBe("a/same.ts");
      for (const path of [
        "../elsewhere.ts",
        "x/../../a.ts",
        "https://example.com/a.png",
        "//host/a.ts",
        "a\u0000.ts",
        "a\\b.ts",
      ])
        expect(relativeWorkspaceFilePath(cwd, path), path).toBeNull();
    },
  );
  it("requires exact containment for local absolute paths", () => {
    expect(relativeWorkspaceFilePath("/repo", "/repo/src/same.ts")).toBe(
      "src/same.ts",
    );
    expect(
      relativeWorkspaceFilePath("/repo", "/repo-other/src/same.ts"),
    ).toBeNull();
    expect(
      relativeWorkspaceFilePath("/repo", "/repo/../other/a.ts"),
    ).toBeNull();
  });
  it("recognizes the macOS canonical path for the same local checkout", () => {
    expect(
      relativeWorkspaceFilePath("/var/repo", "/private/var/repo/src/a.ts"),
    ).toBe("src/a.ts");
    expect(
      relativeWorkspaceFilePath("/private/tmp/repo", "/tmp/repo/src/a.ts"),
    ).toBe("src/a.ts");
  });
  it("maps VM paths only through the confirmed root of the selected cloud owner", () => {
    expect(
      relativeWorkspaceFilePath(cloud, "/workspace/repo/src/a.ts"),
    ).toBeNull();
    expect(
      relativeWorkspaceFilePath(
        cloud,
        "/workspace/repo/src/a.ts",
        "/workspace/repo",
      ),
    ).toBe("src/a.ts");
    expect(
      relativeWorkspaceFilePath(
        cloud,
        "/workspace/other/a.ts",
        "/workspace/repo",
      ),
    ).toBeNull();
    expect(
      relativeWorkspaceFilePath(
        cloud,
        `${otherCloud}/src/a.ts`,
        "/workspace/repo",
      ),
    ).toBeNull();
    expect(relativeWorkspaceFilePath(cloud, `${cloud}/src/a.ts`)).toBe(
      "src/a.ts",
    );
    expect(
      relativeWorkspaceFilePath(
        `${cloud}/src`,
        "/workspace/repo/src/a.ts",
        "/workspace/repo",
      ),
    ).toBe("a.ts");
  });
});

describe("file pill navigation", () => {
  const owners = ["/personal/project", "/organization/project", cloud];

  function confirmedChanges(cwd: string, paths: string[], baseBranch = "main") {
    vi.spyOn(workspaces, "peekLiveWorkspaceUnion").mockReturnValue([
      { id: cwd, path: cwd, baseBranch },
    ] as never);
    const key = changesSnapshots.changesSnapshotKey(
      cwd,
      { kind: "all" },
      baseBranch,
    );
    return vi
      .spyOn(changesSnapshots, "readChangesSections")
      .mockImplementation((requested) =>
        requested === key
          ? [
              {
                kind: "committed",
                title: null,
                files: paths.map((path) => ({
                  path,
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  binary: false,
                  patch: "",
                })),
              },
            ]
          : undefined,
      );
  }

  function recordNavigation() {
    const dispatch = vi.fn();
    vi.spyOn(useWorkspaceStore, "getState").mockReturnValue({
      ...useWorkspaceStore.getState(),
      workbenchByScope: {},
      dispatch,
    });
    return dispatch;
  }

  it.each(owners)(
    "preserves a dirty Changes editor and the nested source path in %s",
    (root) => {
      confirmedChanges(root, []).mockReturnValue(undefined);
      const scope = `${root}/packages/app`;
      const changes = { ...createChangesTab(), filePath: "draft.ts" };
      setWorkbenchEditorDirty(changes.id, true);
      const dispatch = vi.fn();
      const filter = vi
        .spyOn(changesFilter, "setChangesScope")
        .mockImplementation(() => {});
      vi.spyOn(useWorkspaceStore, "getState").mockReturnValue({
        ...useWorkspaceStore.getState(),
        dispatch,
        workbenchByScope: {
          [scope]: {
            tabs: [changes],
            activeId: changes.id,
            recentBrowsers: [],
          },
        },
      });
      openFilePill(scope, ".context/notes.ts", "changes");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          scope,
          tab: expect.objectContaining({
            filePath: ".context/notes.ts",
            diff: false,
          }),
        }),
      );
      expect(filter).not.toHaveBeenCalled();
    },
  );

  it.each(owners)(
    "opens the renamed diff for an old tool path in %s",
    (cwd) => {
      confirmedChanges(cwd, []).mockReturnValue([
        {
          kind: "committed",
          title: null,
          files: [
            {
              path: "src/after.ts",
              oldPath: "src/before.ts",
              status: "renamed",
              additions: 0,
              deletions: 0,
              binary: false,
              patch: "",
            },
          ],
        },
      ]);
      const dispatch = recordNavigation();
      vi.spyOn(changesFilter, "setChangesScope").mockImplementation(() => {});
      openFilePill(cwd, "src/before.ts", "changes");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: expect.objectContaining({
            filePath: "src/after.ts",
            diff: true,
          }),
        }),
      );
    },
  );

  it.each(owners)(
    "keeps ignored and unchanged diff targets in Changes for %s",
    (cwd) => {
      confirmedChanges(cwd, ["src/changed.ts"]);
      const dispatch = recordNavigation();
      const filter = vi
        .spyOn(changesFilter, "setChangesScope")
        .mockImplementation(() => {});
      for (const path of [
        ".context/task/fit.swift",
        "src/unchanged.ts",
        ".context/Shot ü #1.png",
      ]) {
        openFilePill(cwd, path, "changes");
        expect(dispatch).toHaveBeenLastCalledWith(
          expect.objectContaining({
            scope: cwd,
            updates: expect.objectContaining({ filePath: path, diff: true, changesRequestedFile: path }),
          }),
        );
      }
      expect(filter).toHaveBeenCalledWith(cwd, { kind: "all" });
    },
  );

  it.each(owners)("keeps changed edit targets in Changes for %s", (cwd) => {
    confirmedChanges(cwd, ["src/changed.ts"]);
    const dispatch = recordNavigation();
    vi.spyOn(changesFilter, "setChangesScope").mockImplementation(() => {});
    openFilePill(cwd, "src/changed.ts", "changes");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: cwd,
        updates: expect.objectContaining({
          filePath: "src/changed.ts",
          diff: true,
          changesRequestedFile: "src/changed.ts",
        }),
      }),
    );
  });

  it.each(owners)("uses only the owning branch comparison for %s", (cwd) => {
    const snapshot = confirmedChanges(cwd, [], "release");
    const dispatch = recordNavigation();
    openFilePill(cwd, "README.md", "changes");
    expect(snapshot).toHaveBeenCalledWith(
      changesSnapshots.changesSnapshotKey(cwd, { kind: "all" }, "release"),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        updates: expect.objectContaining({
          filePath: "README.md",
          diff: true,
        }),
      }),
    );
  });

  it.each(owners)(
    "keeps absent diff targets relative to the owning Git root in %s",
    (root) => {
      confirmedChanges(root, ["src/other.ts"]);
      const dispatch = recordNavigation();
      openFilePill(`${root}/packages/app`, ".context/notes.md", "changes");
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: `${root}/packages/app`,
          updates: expect.objectContaining({
            filePath: "packages/app/.context/notes.md",
            diff: true,
          }),
        }),
      );
    },
  );

  it.each(owners)(
    "warms a local Changes destination without waking a cloud VM in %s",
    (cwd) => {
      confirmedChanges(cwd, []);
      const read = vi
        .spyOn(fileData, "prefetchWorkspaceFileRead")
        .mockImplementation(() => {});
      const diff = vi
        .spyOn(fileData, "prefetchWorkspaceFileDiff")
        .mockImplementation(() => {});
      warmFilePill(cwd, ".context/notes.md", "changes");
      expect(read).not.toHaveBeenCalled();
      if (cwd === cloud) expect(diff).not.toHaveBeenCalled();
      else expect(diff).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: cwd, path: ".context/notes.md", diffScope: "all" }));
    },
  );

  it.each([
    ["/repo/nested/child", "nested", "child/src/a.ts"],
    [`${cloud}/packages/app`, cloud, "packages/app/src/a.ts"],
  ])(
    "opens a subdirectory tool's Changes path from %s at its owning Git root",
    (cwd, target, path) => {
      vi.spyOn(workspaces, "peekLiveWorkspaceUnion").mockReturnValue([
        { id: "outer", path: "/repo" },
        { id: "nested", path: "/repo/nested" },
      ] as never);
      const filter = vi
        .spyOn(changesFilter, "setChangesScope")
        .mockImplementation(() => {});
      const dispatch = vi.fn();
      vi.spyOn(useWorkspaceStore, "getState").mockReturnValue({
        ...useWorkspaceStore.getState(),
        workbenchByScope: {},
        dispatch,
      });
      openFilePill(cwd, "src/a.ts", "changes");
      expect(filter).toHaveBeenCalledWith(target, { kind: "all" });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: cwd,
          updates: expect.objectContaining({ filePath: path }),
        }),
      );
    },
  );
  it("does not trim a literal file name into a different file", () => {
    const existing = createFilesTab("notes.ts");
    expect(
      buildFilePillOpenAction([existing], " notes.ts ", "/repo"),
    ).toMatchObject({
      type: "ADD_WORKBENCH_TAB",
      tab: { filePath: " notes.ts " },
    });
  });
  it.each(["/personal/project", "/organization/project", cloud])(
    "opens exact files under their captured %s owner",
    (scope) => {
      const existing = createFilesTab("other/same.ts");
      const action = buildFilePillOpenAction([existing], "src/same.ts", scope);
      expect(action).toMatchObject({
        type: "ADD_WORKBENCH_TAB",
        scope,
        tab: { type: "files", filePath: "src/same.ts", diff: false },
      });
      expect(existing.filePath).toBe("other/same.ts");
    },
  );
  it("reuses the same file without preserving an old diff intent or resetting its editor", () => {
    const existing = {
      ...createFilesTab("src/a.ts"),
      diff: true,
      contentRevision: 4,
    };
    setWorkbenchEditorDirty(existing.id, true);
    const action = buildFilePillOpenAction([existing], "src/a.ts", "/repo");
    expect(action).toMatchObject({
      type: "OPEN_WORKBENCH_TAB",
      id: existing.id,
      updates: { diff: false, viewerMode: undefined },
    });
    expect(action).not.toHaveProperty("updates.contentRevision");
  });
  it("opens Changes and the requested file in one navigation action", () => {
    const changes = createChangesTab();
    expect(
      buildFilePillOpenAction([changes], "src/a.ts", cloud, "changes"),
    ).toMatchObject({
      type: "OPEN_WORKBENCH_TAB",
      id: changes.id,
      scope: cloud,
      updates: {
        filePath: "src/a.ts",
        diff: true,
        diffScope: "all",
        changesPresentation: "single",
        changesRequestedFile: "src/a.ts",
      },
    });
  });
  it("preserves a legacy dirty Changes editor when opening a different file", () => {
    const changes = { ...createChangesTab(), filePath: "draft.ts" };
    setWorkbenchEditorDirty(changes.id, true);
    expect(
      buildFilePillOpenAction([changes], "src/a.ts", "/repo", "changes"),
    ).toMatchObject({
      type: "ADD_WORKBENCH_TAB",
      tab: { type: "files", filePath: "src/a.ts", diff: true },
    });
  });
});
