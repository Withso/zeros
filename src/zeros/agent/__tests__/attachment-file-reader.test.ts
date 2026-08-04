import { describe, expect, it, vi } from "vitest";

import {
  agentAttachmentPathCandidates,
  readAgentAttachmentFile,
} from "../attachment-file-reader";
import type { ReadFileResult } from "../../../native/files";

describe("agent attachment scope resolution", () => {
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
    ).toEqual([local, shared]);

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
    expect(read.mock.calls.map((call) => call[1])).toEqual([local, shared]);
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
      ".context-graph/local/attachments/old-id/shot.png",
    ]);
  });
});
