import { describe, expect, it } from "vitest";

import type { StatusResult } from "@/native/git";
import { trackedFilesForScope } from "../changes-scope-files";

const adStatus: Pick<StatusResult, "staged" | "unstaged" | "conflicted"> = {
  staged: [{ path: "test1.md", status: "added" }],
  unstaged: [{ path: "test1.md", status: "deleted" }],
  conflicted: [],
};

describe("trackedFilesForScope", () => {
  it("omits an AD path from a net-empty Uncommitted/All patch", () => {
    expect(trackedFilesForScope("", adStatus)).toEqual([]);
  });

  it("keeps the staged-add side when the cached comparison contains it", () => {
    const patch = [
      "diff --git a/test1.md b/test1.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test1.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "",
    ].join("\n");
    expect(trackedFilesForScope(patch, adStatus)).toMatchObject([
      { path: "test1.md", status: "added", staged: true, isNewFile: true },
    ]);
  });

  it("keeps the unstaged-delete side when the worktree comparison contains it", () => {
    const patch = [
      "diff --git a/test1.md b/test1.md",
      "deleted file mode 100644",
      "--- a/test1.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-hello",
      "",
    ].join("\n");
    expect(trackedFilesForScope(patch, adStatus)).toMatchObject([
      { path: "test1.md", status: "deleted", staged: true, isNewFile: true },
    ]);
  });
});
