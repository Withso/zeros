// Text attachments persist their durable graph id on the sent bubble but never
// their bytes, so edit-resend has to read the body back out of the context
// graph. Images can do that from a `diskPath` the bubble carries; text has to
// resolve the id to a path first, because the physical filename is the
// ENGINE's sanitised form of the original name and nothing in the renderer may
// keep a second copy of that sanitiser (engine/files/context-graph.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

const listContextGraph = vi.fn();
const readWorkspaceFile = vi.fn();

vi.mock("../../../platform/context-graph", () => ({
  listContextGraph: (...args: unknown[]) => listContextGraph(...args),
  notifyContextGraphChanged: vi.fn(),
}));

vi.mock("../../../platform/files", () => ({
  readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...args),
}));

import { readTextAttachment } from "../agent-history-client";

const GRAPH = {
  exists: true,
  truncated: false,
  items: [
    {
      relPath: ".context-graph/local/attachments/att-1/pasted-text.txt",
      name: "pasted-text.txt",
      scope: "local",
      category: "attachment",
      kind: "text",
      bytes: 11,
      mtimeMs: 1,
      ctimeMs: 1,
      attachmentId: "att-1",
    },
    // A doc card has no attachment id — it must never answer an id lookup.
    {
      relPath: ".context-graph/shared/docs/notes.md",
      name: "notes.md",
      scope: "shared",
      category: "doc",
      kind: "markdown",
      bytes: 4,
      mtimeMs: 1,
      ctimeMs: 1,
    },
  ],
};

function textFile(path: string, content: string) {
  return { kind: "text" as const, path, bytes: content.length, content };
}

describe("readTextAttachment", () => {
  beforeEach(() => {
    listContextGraph.mockReset().mockResolvedValue(GRAPH);
    readWorkspaceFile.mockReset();
  });

  it("resolves the durable id through the graph, then reads that record", async () => {
    readWorkspaceFile.mockResolvedValue(
      textFile(
        ".context-graph/local/attachments/att-1/pasted-text.txt",
        "pasted body",
      ),
    );

    await expect(
      readTextAttachment({ cwd: "/repo", attachmentId: "att-1" }),
    ).resolves.toBe("pasted body");
    expect(readWorkspaceFile).toHaveBeenCalledWith(
      "/repo",
      ".context-graph/local/attachments/att-1/pasted-text.txt",
    );
  });

  it("uses an exact disk reference without listing the graph", async () => {
    const diskPath = ".context-graph/shared/attachments/att-1/pasted-text.txt";
    readWorkspaceFile.mockResolvedValue(textFile(diskPath, "pasted body"));

    await expect(
      readTextAttachment({ cwd: "/repo", attachmentId: "att-1", diskPath }),
    ).resolves.toBe("pasted body");
    expect(listContextGraph).not.toHaveBeenCalled();
  });

  it("falls back to the id lookup when the supplied path is not a graph path", async () => {
    readWorkspaceFile.mockResolvedValue(
      textFile(
        ".context-graph/local/attachments/att-1/pasted-text.txt",
        "pasted body",
      ),
    );

    await expect(
      readTextAttachment({
        cwd: "/repo",
        attachmentId: "att-1",
        diskPath: "../../etc/passwd",
      }),
    ).resolves.toBe("pasted body");
    expect(readWorkspaceFile).toHaveBeenCalledWith(
      "/repo",
      ".context-graph/local/attachments/att-1/pasted-text.txt",
    );
  });

  it("follows the record after the share toggle moved its scope", async () => {
    const shared = ".context-graph/shared/attachments/att-1/pasted-text.txt";
    readWorkspaceFile.mockImplementation(async (_cwd: string, path: string) =>
      path === shared
        ? textFile(shared, "pasted body")
        : { kind: "error", path, bytes: 0, error: "file no longer exists" },
    );

    await expect(
      readTextAttachment({ cwd: "/repo", attachmentId: "att-1" }),
    ).resolves.toBe("pasted body");
  });

  it("answers null for an id the graph no longer holds", async () => {
    await expect(
      readTextAttachment({ cwd: "/repo", attachmentId: "gone" }),
    ).resolves.toBeNull();
    expect(readWorkspaceFile).not.toHaveBeenCalled();
  });

  it("answers null when the record is no longer readable as text", async () => {
    readWorkspaceFile.mockResolvedValue({
      kind: "too-large",
      path: ".context-graph/local/attachments/att-1/pasted-text.txt",
      bytes: 99,
      error: "file is too large to preview",
    });

    await expect(
      readTextAttachment({ cwd: "/repo", attachmentId: "att-1" }),
    ).resolves.toBeNull();
  });
});
