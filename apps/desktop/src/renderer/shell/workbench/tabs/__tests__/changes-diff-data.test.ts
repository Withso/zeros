import { hydratePartialDiff } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { gitDiff } from "@/renderer/platform/git";
import { resetWorkspaceFileDataCacheForTests } from "../../../workspace-file-data-cache";

import {
  changesDiffDataWeight,
  changesDiffDataKey,
  completeChangesDiff,
  initialChangesDiff,
  loadChangesDiffData,
  peekChangesDiffData,
  placeholderFileContents,
  resetChangesDiffDataForTests,
  withChangesDiffCopyText,
} from "../changes-diff-data";
import type { ChangedFile } from "../changes-parse";

vi.mock("@/renderer/platform/git", () => ({ gitDiff: vi.fn() }));

beforeEach(() => {
  resetChangesDiffDataForTests();
  resetWorkspaceFileDataCacheForTests();
  vi.mocked(gitDiff).mockReset();
});

function completePatch(before: string, after: string): string {
  return createTwoFilesPatch(
    "long.txt",
    "long.txt",
    before,
    after,
    undefined,
    undefined,
    {
      context: 10_000,
    },
  );
}

describe("Changes complete diff data", () => {
  it("keeps a warm lazy diff when rendering other uncached summary rows", async () => {
    const file: ChangedFile = {
      path: "long.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "",
      binary: false,
    };
    const query = { workspaceId: "workspace", path: file.path };
    vi.mocked(gitDiff).mockResolvedValue({
      hunks: [],
      patch: completePatch("before\n", "after\n"),
    });
    const key = changesDiffDataKey(query, file, 0);
    const value = await loadChangesDiffData(key, query, file, "/repo");
    for (let i = 0; i < 1_001; i++) peekChangesDiffData(`uncached-${i}`);
    expect(peekChangesDiffData(key)).toBe(value);
  });

  it("loads a restored turn without an inline patch through its exact snapshot range", async () => {
    const file: ChangedFile = {
      path: "long.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "",
      binary: false,
    };
    const query = {
      workspaceId: "workspace",
      path: file.path,
      diffScope: "turn" as const,
      turnChatId: "chat",
      turnId: "turn",
    };
    vi.mocked(gitDiff).mockResolvedValue({
      hunks: [],
      patch: completePatch("before\n", "after\n"),
    });
    const value = await loadChangesDiffData(
      changesDiffDataKey(query, file, 0),
      query,
      file,
      "/repo",
    );
    expect(value.fileDiff?.additionLines.join("")).toBe("after\n");
    expect(gitDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        fullContext: true,
        history: {
          kind: "turn-range",
          from: { chatId: "chat", turnId: "turn" },
          to: { chatId: "chat", turnId: "turn" },
        },
      }),
    );
  });

  it("replaces the loading state with an explanation when a lazy patch exceeds the display limit", async () => {
    const file: ChangedFile = {
      path: "long.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "",
      binary: false,
    };
    const query = { workspaceId: "workspace", path: file.path };
    vi.mocked(gitDiff).mockResolvedValue({
      hunks: [],
      patch: "x".repeat(8 * 1024 * 1024 + 1),
    });
    const value = await loadChangesDiffData(
      changesDiffDataKey(query, file, 0),
      query,
      file,
      "/repo",
    );
    expect(value.message).toBe("This file is too large to display.");
    expect(value.fileDiff).toBeUndefined();
  });

  it.each(["modified", "added", "deleted"] as const)(
    "renders a lazily loaded %s row without an inline patch",
    async (status) => {
      const contents = `${Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
      const before = status === "added" ? "" : contents;
      const after =
        status === "deleted" ? "" : contents.replace("line 40\n", "changed\n");
      const file: ChangedFile = {
        path: "long.txt",
        status,
        additions: 1,
        deletions: 1,
        patch: "",
        binary: false,
      };
      const query = {
        workspaceId: "workspace",
        path: file.path,
        diffScope: "all" as const,
      };
      vi.mocked(gitDiff).mockResolvedValue({
        hunks: [],
        patch: completePatch(before, after),
      });

      expect(initialChangesDiff(file).fileDiff).toBeUndefined();
      const value = await loadChangesDiffData(
        changesDiffDataKey(query, file, 0),
        query,
        file,
        "/repo",
      );

      expect(value.fileDiff?.isPartial).toBe(false);
      expect(value.fileDiff?.deletionLines.join("")).toBe(before);
      expect(value.fileDiff?.additionLines.join("")).toBe(after);
      if (status === "modified")
        expect(value.fileDiff?.hunks[0]?.collapsedBefore).toBeGreaterThan(0);
      expect(value.message).toBeUndefined();
    },
  );

  it("reconstructs both complete snapshots so Pierre can expand unchanged lines", async () => {
    const before = `${Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const after = before.replace("line 40\n", "changed line\n");
    const partial = initialChangesDiff({
      path: "long.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: createTwoFilesPatch("long.txt", "long.txt", before, after),
      binary: false,
    }).fileDiff;

    const result = await completeChangesDiff(
      completePatch(before, after),
      "long.txt",
    );
    const hydrated = hydratePartialDiff("clone", partial!, result.loadedFiles!);

    expect(result.copyText).toBe(after);
    expect(result.loadedFiles).toMatchObject({
      oldFile: { name: "long.txt", contents: before },
      newFile: { name: "long.txt", contents: after },
    });
    expect(hydrated).toMatchObject({
      name: "long.txt",
      isPartial: false,
      type: "change",
    });
    expect(hydrated.deletionLines.join("")).toBe(before);
    expect(hydrated.additionLines.join("")).toBe(after);
    expect(hydrated.hunks[0]?.collapsedBefore).toBeGreaterThan(0);
    expect(partial?.isPartial).toBe(true);
    expect(result.notice).toBeUndefined();
  });

  it("keeps the ordinary short patch as an immediate partial first paint", () => {
    const before = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const after = before.replace("line 10\n", "changed\n");
    const file: ChangedFile = {
      path: "long.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: createTwoFilesPatch("long.txt", "long.txt", before, after),
      binary: false,
    };

    const result = initialChangesDiff(file);
    expect(result.fileDiff?.isPartial).toBe(true);
    expect(result.fileDiff?.deletionLines.join("")).not.toBe(before);
  });

  it("preserves missing final newlines in native hydration contents", () => {
    const result = completeChangesDiff(
      completePatch("before", "after"),
      "long.txt",
    );

    expect(result.loadedFiles?.oldFile?.contents).toBe("before");
    expect(result.loadedFiles?.newFile.contents).toBe("after");
    expect(result.copyText).toBe("after");
  });

  it("uses the old and new names when hydrating a changed rename", () => {
    const patch = [
      "diff --git a/old.txt b/new.txt",
      "similarity index 50%",
      "rename from old.txt",
      "rename to new.txt",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const result = completeChangesDiff(patch, "new.txt");

    expect(result.loadedFiles).toMatchObject({
      oldFile: { name: "old.txt", contents: "before\n" },
      newFile: { name: "new.txt", contents: "after\n" },
    });
  });

  it("recognizes binary and metadata-only cards without inventing text", async () => {
    const binary = await completeChangesDiff(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
      "logo.png",
    );
    expect(binary).toEqual({ message: "Binary file changed" });

    const rename = await completeChangesDiff(
      "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
      "new.txt",
    );
    expect(rename).toEqual({ message: "File metadata changed" });
  });

  it("supplies current contents to metadata-only file-card copy actions", () => {
    const metadata = { message: "File metadata changed" };
    expect(withChangesDiffCopyText(metadata, "unchanged contents\n")).toEqual({
      message: "File metadata changed",
      copyText: "unchanged contents\n",
    });
    const deleted = { ...metadata, copyText: "deleted contents\n" };
    expect(withChangesDiffCopyText(deleted, "current contents\n")).toBe(
      deleted,
    );
  });

  it("accounts for retained full snapshots in the cache budget", async () => {
    const result = await completeChangesDiff(
      completePatch("before\n", "after\n"),
      "long.txt",
    );
    expect(changesDiffDataWeight(result)).toBeGreaterThan(
      (result.copyText?.length ?? 0) * 2,
    );
  });
});

describe("placeholderFileContents", () => {
  // @pierre/diffs asserts by object identity that a collapsed re-render of a
  // file item commits the object it prepared layout for. A fresh but equal
  // object for the same card threw and unmounted the whole Changes surface.
  it("returns one shared object per path and message", () => {
    const first = placeholderFileContents("a.txt", "No textual changes");
    expect(placeholderFileContents("a.txt", "No textual changes")).toBe(first);
    expect(first).toEqual({
      name: "a.txt",
      contents: "No textual changes",
      lang: "text",
    });
    expect(placeholderFileContents("a.txt", "Binary file changed")).not.toBe(
      first,
    );
    expect(placeholderFileContents("b.txt", "No textual changes")).not.toBe(
      first,
    );
  });

  it("keeps recently rendered placeholders when older ones are evicted", () => {
    const live = placeholderFileContents("live.txt", "Loading diff…");
    const stale = placeholderFileContents("stale.txt", "No textual changes");
    for (let index = 0; index < 4100; index += 1) {
      placeholderFileContents(`other-${index}.txt`, "No textual changes");
      // A mounted card touches its placeholder on every items pass.
      if (index % 1000 === 0)
        placeholderFileContents("live.txt", "Loading diff…");
    }
    expect(placeholderFileContents("live.txt", "Loading diff…")).toBe(live);
    expect(placeholderFileContents("stale.txt", "No textual changes")).not.toBe(
      stale,
    );
  });
});
