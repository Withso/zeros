import { describe, expect, it, vi } from "vitest";

import {
  agentAttachmentPathCandidates,
  readAgentAttachmentFile,
} from "../attachment-file-reader";
import type { ReadFileResult } from "../../../platform/files";

describe("agent attachment scope resolution", () => {
  it.each(["local", "shared"])(
    "reads a renamed %s record and its moved scope from a saved legacy path",
    async (scope) => {
      const diskPath = `.context-graph/${scope}/attachments/id/shot.png`;
      const current = `.context/${scope === "local" ? "shared" : "local"}/attachments/id/shot.png`;
      const read = vi.fn(
        async (_cwd: string, path: string): Promise<ReadFileResult> => ({
          kind: path === current ? "image" : "error",
          path,
          bytes: 1,
        }),
      );
      expect(
        await readAgentAttachmentFile({ cwd: "/repo", diskPath }, read),
      ).toMatchObject({ kind: "image", path: current });
    },
  );

  it("recognizes new paths and retains the exact path when both roots exist", async () => {
    const diskPath = ".context/local/attachments/id/notes.txt";
    const read = vi.fn(
      async (_cwd: string, path: string): Promise<ReadFileResult> => ({
        kind: "text",
        path,
        bytes: 1,
        content: "authoritative",
      }),
    );
    expect(
      await readAgentAttachmentFile({ cwd: "/repo", diskPath }, read),
    ).toMatchObject({ content: "authoritative" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/repo", diskPath);
  });

  it("resolves a moved graph record by stable attachment id", async () => {
    const local = ".context-graph/local/attachments/att-1/shot.png";
    const shared = ".context-graph/shared/attachments/att-1/shot.png";
    const read = vi.fn(
      async (_cwd: string, path: string): Promise<ReadFileResult> =>
        path === shared
          ? {
              kind: "image",
              path,
              bytes: 3,
              dataUrl: "data:image/png;base64,UE5H",
            }
          : {
              kind: "error",
              path,
              bytes: 0,
              error: "file no longer exists on disk",
            },
    );

    expect(
      agentAttachmentPathCandidates({
        diskPath: local,
        attachmentId: "att-1",
      }),
    ).toEqual([
      local,
      ".context/attachments/att-1/shot.png",
      ".context/local/attachments/att-1/shot.png",
      ".context/shared/attachments/att-1/shot.png",
      shared,
    ]);

    const result = await readAgentAttachmentFile(
      {
        cwd: "/repo",
        diskPath: local,
        attachmentId: "att-1",
      },
      read,
    );

    expect(result?.kind).toBe("image");
    expect(result?.path).toBe(shared);
    expect(read.mock.calls.map((call) => call[1])).toEqual([
      local,
      ".context/attachments/att-1/shot.png",
      ".context/local/attachments/att-1/shot.png",
      ".context/shared/attachments/att-1/shot.png",
      shared,
    ]);
  });

  it("reads current records first and falls back to earlier scopes by id", () => {
    expect(
      agentAttachmentPathCandidates({
        diskPath: ".context/attachments/att-1/shot.png",
        attachmentId: "att-1",
      }),
    ).toEqual([
      ".context/attachments/att-1/shot.png",
      ".context/local/attachments/att-1/shot.png",
      ".context/shared/attachments/att-1/shot.png",
      ".context-graph/local/attachments/att-1/shot.png",
      ".context-graph/shared/attachments/att-1/shot.png",
    ]);
  });

  it("does not widen legacy or malformed paths into graph reads", () => {
    expect(
      agentAttachmentPathCandidates({
        diskPath: ".context/attachments/chat-1/att-shot.png",
        attachmentId: "att-1",
      }),
    ).toEqual([".context/attachments/chat-1/att-shot.png"]);
    expect(
      agentAttachmentPathCandidates({
        diskPath: "../../secrets.png",
        attachmentId: "att-1",
      }),
    ).toEqual([]);
  });

  it("derives the stable id from pre-id graph rows", () => {
    expect(
      agentAttachmentPathCandidates({
        diskPath: ".context-graph/shared/attachments/old-id/shot.png",
      }),
    ).toEqual([
      ".context-graph/shared/attachments/old-id/shot.png",
      ".context/attachments/old-id/shot.png",
      ".context/local/attachments/old-id/shot.png",
      ".context/shared/attachments/old-id/shot.png",
      ".context-graph/local/attachments/old-id/shot.png",
    ]);
  });

  it.each([undefined, "../invalid"])(
    "keeps a flat chat-era path exact-only without a valid saved id (%s)",
    async (attachmentId) => {
      const diskPath = ".context/attachments/chat-1/shot.png";
      const read = vi.fn(async (_cwd: string, candidate: string): Promise<ReadFileResult> => ({
        kind: candidate === diskPath ? "error" : "image",
        path: candidate,
        bytes: 0,
      }));
      expect(agentAttachmentPathCandidates({ diskPath, attachmentId })).toEqual([diskPath]);
      expect(await readAgentAttachmentFile({ cwd: "/repo", diskPath, attachmentId }, read)).toMatchObject({ kind: "error" });
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
});
