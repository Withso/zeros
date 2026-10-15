import { afterEach, describe, expect, it, vi } from "vitest";
import { relativeWorkspaceFilePath } from "@/renderer/platform/workspace-file-path";
import { buildFilePillOpenAction, openFilePill } from "../file-pill-navigation";
import { useWorkspaceStore } from "@/renderer/state/store";
import * as workspaces from "@/renderer/state/use-projects";
import * as changesFilter from "../tabs/changes-filter-store";
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
