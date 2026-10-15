import { beforeEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/renderer/platform/files", () => ({ readWorkspaceFile: read }));
import { loadAttachmentPillFile } from "../attachment-pill-file";
import { resetWorkspaceFileDataCacheForTests } from "@/renderer/shell/workspace-file-data-cache";

beforeEach(() => {
  read.mockReset();
  resetWorkspaceFileDataCacheForTests();
});

describe("restored attachment pill paths", () => {
  it.each([
    "/personal/repo",
    "/organization/repo",
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
  ])(
    "resolves a migrated record once and shares the file read in %s",
    async (cwd) => {
      const diskPath = ".context-graph/shared/attachments/restored/notes.txt";
      const current = ".context/attachments/restored/notes.txt";
      read.mockImplementation(async (_cwd: string, path: string) =>
        path === current
          ? { kind: "text", path, bytes: 5, content: "notes" }
          : {
              kind: "error",
              path,
              bytes: 0,
              error: "file no longer exists on disk",
            },
      );
      const query = { cwd, diskPath, attachmentId: "restored" };
      expect(
        await Promise.all([
          loadAttachmentPillFile(query),
          loadAttachmentPillFile(query),
        ]),
      ).toEqual([current, current]);
      expect(read.mock.calls).toEqual([
        [cwd, diskPath],
        [cwd, current],
      ]);
    },
  );

  it("keeps a late workspace response out of another owner's same-named file", async () => {
    const diskPath = ".context/local/attachments/race/same.png";
    let finishA!: (result: unknown) => void;
    read.mockImplementation((cwd: string, path: string) =>
      cwd === "/workspace-a"
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : Promise.resolve({
            kind: "image",
            path,
            bytes: 1,
            dataUrl: "data:image/png;base64,Qg==",
          }),
    );
    const queryA = { cwd: "/workspace-a", diskPath, attachmentId: "race" };
    const pendingA = loadAttachmentPillFile(queryA);
    await vi.waitFor(() => expect(finishA).toBeTypeOf("function"));
    expect(
      await loadAttachmentPillFile({ ...queryA, cwd: "/workspace-b" }),
    ).toBe(diskPath);
    finishA({
      kind: "image",
      path: diskPath,
      bytes: 1,
      dataUrl: "data:image/png;base64,QQ==",
    });
    expect(await pendingA).toBe(diskPath);
    expect(await loadAttachmentPillFile(queryA)).toBe(diskPath);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing legacy chat path exact instead of opening another record", async () => {
    const diskPath = ".context/attachments/chat-id/same.png";
    read.mockResolvedValue({
      kind: "error",
      path: diskPath,
      bytes: 0,
      error: "file no longer exists on disk",
    });
    expect(
      await loadAttachmentPillFile({
        cwd: "/missing",
        diskPath,
        attachmentId: "different-id",
      }),
    ).toBe(diskPath);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("separates relative paths in two directories of the same cloud owner", async () => {
    const cloud =
      "cloud://11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
    const diskPath = ".context/shared/attachments/nested/same.txt";
    const current = ".context/attachments/nested/same.txt";
    read.mockImplementation(async (cwd: string, path: string) => ({
      kind: cwd.endsWith("/first") && path === diskPath ? "error" : "text",
      path,
      bytes: 1,
      content: "file",
      error: "file no longer exists on disk",
    }));
    expect(
      await loadAttachmentPillFile({
        cwd: `${cloud}/first`,
        diskPath,
        attachmentId: "nested",
      }),
    ).toBe(current);
    expect(
      await loadAttachmentPillFile({
        cwd: `${cloud}/second`,
        diskPath,
        attachmentId: "nested",
      }),
    ).toBe(diskPath);
  });
});
