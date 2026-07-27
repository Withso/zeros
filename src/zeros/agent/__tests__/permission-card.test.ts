// Pure-function coverage for the permission card's request → copy mapping
// (§3.2 Task 3 — path-aware permission copy).
//
// The card renders ONE detail row: [icon] [tool label] [detail]. For file
// tools we want the file path (the "file ref") in the detail — shown
// workspace-relative (Claude's file_path is absolute) and fg2/truncated by
// the JSX. These tests lock in:
//   - relativizePath: absolute → repo-relative, with the tricky edge cases
//   - describePermission: Read/Write now yield the path (+ file icon); Bash,
//     Codex edits, and no-path tools are unchanged (no cross-agent regression)
//   - multi-file approvals (Codex applies one patch across several files in a
//     single gate): a count summary — "Apply changes to N files?" / "Edit N
//     files" — replaces a misleading single path; one file keeps the path row

import { describe, it, expect } from "vitest";
import { FilePen, FileText, Terminal, Wrench } from "lucide-react";

import { describePermission, relativizePath } from "../permission-card";
import type { RequestPermissionRequest } from "../../bridge/agent-events";

const CWD = "/Users/x/repos/ws-feverfew";

/** Minimal permission request — only the fields describePermission reads. */
const req = (
  kind: string | null,
  title: string,
  rawInput: Record<string, unknown>,
): RequestPermissionRequest =>
  ({
    sessionId: "s",
    toolCall: { toolCallId: "t", title, kind, status: "pending", rawInput },
    options: [],
  }) as unknown as RequestPermissionRequest;

describe("relativizePath", () => {
  it("strips the cwd prefix to reveal the in-repo path", () => {
    expect(relativizePath(`${CWD}/src/engine/adapter.ts`, CWD)).toBe(
      "src/engine/adapter.ts",
    );
  });

  it("tolerates a trailing slash on the cwd", () => {
    expect(relativizePath(`${CWD}/src/a.ts`, `${CWD}/`)).toBe("src/a.ts");
  });

  it("leaves a path that is exactly the cwd untouched", () => {
    expect(relativizePath(CWD, CWD)).toBe(CWD);
  });

  it("does not strip a sibling dir that merely shares the prefix", () => {
    // `${CWD}-other` starts with `${CWD}` textually but is NOT under it.
    const sibling = `${CWD}-other/a.ts`;
    expect(relativizePath(sibling, CWD)).toBe(sibling);
  });

  it("returns absolute paths outside the cwd unchanged", () => {
    expect(relativizePath("/etc/hosts", CWD)).toBe("/etc/hosts");
  });

  it("returns the path unchanged when no cwd is known", () => {
    expect(relativizePath("/etc/hosts", null)).toBe("/etc/hosts");
    expect(relativizePath("/etc/hosts", undefined)).toBe("/etc/hosts");
  });
});

describe("describePermission", () => {
  it("shows a Read's file (relative) + file icon — the Task 3 fix", () => {
    // Claude Read: kind arrives as "other", file_path is ABSOLUTE.
    const d = describePermission(
      req("other", "Read", { file_path: `${CWD}/src/engine/adapter.ts` }),
      CWD,
    );
    expect(d.detail).toBe("src/engine/adapter.ts");
    expect(d.label).toBe("Read");
    expect(d.Icon).toBe(FileText);
  });

  it("shows a Write's file even though its kind arrives as \"other\"", () => {
    const d = describePermission(
      req("other", "Write", { file_path: `${CWD}/notes.txt`, content: "hi" }),
      CWD,
    );
    expect(d.detail).toBe("notes.txt");
    expect(d.Icon).toBe(FileText);
  });

  it("reads NotebookEdit's file from notebook_path", () => {
    const d = describePermission(
      req("other", "NotebookEdit", { notebook_path: `${CWD}/nb.ipynb` }),
      CWD,
    );
    expect(d.detail).toBe("nb.ipynb");
    expect(d.Icon).toBe(FileText);
  });

  it("keeps Bash on the command branch (path change does not touch it)", () => {
    const d = describePermission(
      req("execute", "Bash", { command: "rm -rf build" }),
      CWD,
    );
    expect(d.detail).toBe("rm -rf build");
    expect(d.command).toBe("rm -rf build");
    expect(d.Icon).toBe(Terminal);
  });

  it("falls back to no detail when a Codex edit carries no file list", () => {
    // Degradation case: the approval couldn't be correlated to a streamed
    // item (no filePaths), so kind "edit" with only reason/grantRoot → pen,
    // no path. Must stay quiet rather than invent a file.
    const d = describePermission(
      req("edit", "Apply file changes", { reason: "why", grantRoot: "/r" }),
      CWD,
    );
    expect(d.detail).toBeNull();
    expect(d.title).toBe("Do you want to apply this change?");
    expect(d.Icon).toBe(FilePen);
  });

  it("shows the lone file's path for a one-file Codex patch", () => {
    // filePaths of length 1 stands in for the (absent) file_path. No reason
    // here, so the label is the default "Edit"; a supplied reason would win.
    const d = describePermission(
      req("edit", "Apply file changes", {
        filePaths: [`${CWD}/src/only.ts`],
      }),
      CWD,
    );
    expect(d.detail).toBe("src/only.ts");
    expect(d.title).toBe("Do you want to apply this change?");
    expect(d.label).toBe("Edit");
    expect(d.Icon).toBe(FilePen);
  });

  it("summarizes a multi-file Codex patch by count, not a single path", () => {
    const d = describePermission(
      req("edit", "Apply file changes", {
        reason: "why",
        filePaths: [`${CWD}/src/a.ts`, `${CWD}/src/b.ts`, `${CWD}/src/c.ts`],
      }),
      CWD,
    );
    expect(d.title).toBe("Apply changes to 3 files?");
    expect(d.label).toBe("Edit 3 files");
    expect(d.detail).toBeNull();
    expect(d.Icon).toBe(FilePen);
  });

  it("summarizes a multi-file non-edit tool with the tool's verb", () => {
    // e.g. a batched read/grep naming several files in one gate.
    const d = describePermission(
      req("other", "Read", { filePaths: [`${CWD}/a.ts`, `${CWD}/b.ts`] }),
      CWD,
    );
    expect(d.label).toBe("Read 2 files");
    expect(d.detail).toBeNull();
    expect(d.Icon).toBe(FileText);
  });

  it("keeps the neutral wrench for a tool with no file target", () => {
    const d = describePermission(req("other", "mcp__x__do", {}), CWD);
    expect(d.detail).toBeNull();
    expect(d.Icon).toBe(Wrench);
    expect(d.label).toBe("mcp__x__do");
  });
});
