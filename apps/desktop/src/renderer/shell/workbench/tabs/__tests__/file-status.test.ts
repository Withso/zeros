import { describe, expect, it } from "vitest";
import type { StatusResult } from "@/renderer/platform/git";
import {
  fileStatusesForFolder,
  FILE_STATUS_PRESENTATION,
} from "../file-status";

const cloud =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const status: StatusResult = {
  staged: [
    { path: "added.ts", status: "added" },
    { path: "gone.ts", status: "added" },
    { path: "new.ts", oldPath: "old.ts", status: "renamed" },
  ],
  unstaged: [
    { path: "added.ts", status: "modified" },
    { path: "gone.ts", status: "deleted" },
    { path: "new.ts", status: "modified" },
    { path: "conflict.ts", status: "modified" },
  ],
  untracked: ["fresh.ts"],
  conflicted: [{ path: "conflict.ts", status: "conflicted" }],
  conflictState: "merge",
};
describe("Files Git status presentation", () => {
  it.each(["/personal/project", "/organization/project", cloud])(
    "enriches exact file paths in %s without redefining Changes counts",
    (root) => {
      expect([...fileStatusesForFolder(status, root, root)]).toEqual([
        ["added.ts", "added"],
        ["gone.ts", "deleted"],
        ["old.ts", "deleted"],
        ["new.ts", "renamed"],
        ["conflict.ts", "conflicted"],
        ["fresh.ts", "untracked"],
      ]);
    },
  );
  it.each(["/personal/project", "/organization/project", cloud])(
    "maps only descendants of a nested cwd in %s",
    (root) => {
      const value = {
        ...status,
        staged: [],
        unstaged: [
          { path: "packages/app/a.ts", status: "modified" as const },
          { path: "packages/other/a.ts", status: "deleted" as const },
        ],
      };
      expect([
        ...fileStatusesForFolder(value, `${root}/packages/app`, root),
      ]).toEqual([["a.ts", "modified"]]);
    },
  );
  it("does not apply a rename source deletion to a reused path", () => {
    const value = { ...status, untracked: ["old.ts"] };
    expect(fileStatusesForFolder(value, "/repo", "/repo").get("old.ts")).toBe(
      "untracked",
    );
  });
  it("uses a distinct accessible letter and semantic color for every status", () => {
    expect(FILE_STATUS_PRESENTATION.modified).toMatchObject({
      letter: "M",
      className: "text-yellow-primary",
    });
    expect(FILE_STATUS_PRESENTATION.deleted).toMatchObject({
      letter: "D",
      className: "text-red-primary",
    });
    expect(
      new Set(
        Object.values(FILE_STATUS_PRESENTATION).map((value) => value.letter),
      ).size,
    ).toBe(6);
  });
});
