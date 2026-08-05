// Edit-card diff + line-count extraction (tool-edit.tsx pure helpers).
//
// Focus: the Cursor SDK edit/write tools carry only `{ path }` (edit) or
// `{ path, fileText }` (write) in their ARGS; the diff + line counts live on
// the RESULT (`rawOutput.value.{linesAdded,linesRemoved,diffString,linesCreated}`).
// These tests pin that the renderer reads the authoritative counts and
// reconstructs a diff from the result's `diffString`, while Claude/Codex edits
// (before/after in the input) keep computing counts by diffing.

import { describe, it, expect } from "vitest";
import {
  extractDiffSource,
  outputLineCounts,
  countLineDelta,
  computeEditBaselines,
  buildUnifiedDiffPatch,
  resolveEditCounts,
  contentLineCount,
  editFallbackText,
  ensureFileHeaders,
} from "../renderers/tool-edit";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";

const tool = (over: Partial<AgentToolMessage>): AgentToolMessage =>
  ({
    id: "t",
    kind: "tool",
    toolCallId: "c",
    title: "",
    toolKind: "edit",
    status: "completed",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as AgentToolMessage;

describe("outputLineCounts — authoritative counts from the tool result", () => {
  it("reads Cursor edit linesAdded/linesRemoved from rawOutput.value", () => {
    const m = tool({
      rawInput: { path: "/abs/test.md" },
      rawOutput: { status: "success", value: { linesAdded: 3, linesRemoved: 0 } },
    });
    expect(outputLineCounts(m)).toEqual({ added: 3, removed: 0 });
  });

  it("keeps a no-op edit (0/0) as a real count, not null", () => {
    const m = tool({
      rawInput: { path: "/abs/test.md" },
      rawOutput: { status: "success", value: { linesAdded: 0, linesRemoved: 0 } },
    });
    expect(outputLineCounts(m)).toEqual({ added: 0, removed: 0 });
  });

  it("maps a Cursor write's linesCreated to added (removed 0)", () => {
    const m = tool({
      rawInput: { path: "/abs/new.ts", fileText: "a\nb\nc" },
      rawOutput: { status: "success", value: { path: "/abs/new.ts", linesCreated: 5, fileSize: 120 } },
    });
    expect(outputLineCounts(m)).toEqual({ added: 5, removed: 0 });
  });

  it("tolerates the nested { result: { value } } protobuf shape", () => {
    const m = tool({
      rawOutput: { result: { value: { linesAdded: 2, linesRemoved: 1 } } },
    });
    expect(outputLineCounts(m)).toEqual({ added: 2, removed: 1 });
  });

  it("returns null for Claude-style content-array output (so it falls back to diffing)", () => {
    const m = tool({
      rawInput: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      rawOutput: [{ type: "content", content: { type: "text", text: "ok" } }],
    });
    expect(outputLineCounts(m)).toBeNull();
  });

  it("returns null for string output and for absent output", () => {
    expect(outputLineCounts(tool({ rawOutput: "File created." }))).toBeNull();
    expect(outputLineCounts(tool({}))).toBeNull();
  });
});

describe("extractDiffSource — Cursor result-side diff + write content", () => {
  it("reconstructs before/after from the edit result's unified diffString", () => {
    const m = tool({
      rawInput: { path: "/abs/foo.ts" },
      rawOutput: {
        status: "success",
        value: {
          linesAdded: 2,
          linesRemoved: 1,
          diffString: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,2 +1,3 @@\n line1\n-old\n+new1\n+new2",
        },
      },
    });
    const src = extractDiffSource(m);
    expect(src).not.toBeNull();
    // Path prefers the args path (the absolute on-disk path) over the diff header.
    expect(src!.path).toBe("/abs/foo.ts");
    expect(src!.before).toBe("line1\nold");
    expect(src!.after).toBe("line1\nnew1\nnew2");
  });

  it("renders a Cursor write (fileText in args) as an all-added diff", () => {
    const m = tool({
      rawInput: { path: "/abs/new.ts", fileText: "line a\nline b" },
    });
    const src = extractDiffSource(m);
    expect(src).toMatchObject({ path: "/abs/new.ts", before: "", after: "line a\nline b" });
  });

  it("ignores a non-diff output string (no @@ hunk marker)", () => {
    const m = tool({
      rawInput: { path: "/abs/foo.ts" },
      rawOutput: { status: "success", value: { diffString: "just a message, no hunks" } },
    });
    expect(extractDiffSource(m)).toBeNull();
  });

  it("still diffs Claude old_string/new_string input (counts computed, not from output)", () => {
    const m = tool({
      rawInput: { file_path: "/a.ts", old_string: "a\nb", new_string: "a\nB\nc" },
    });
    const src = extractDiffSource(m);
    expect(src).toMatchObject({ path: "/a.ts", before: "a\nb", after: "a\nB\nc" });
    expect(outputLineCounts(m)).toBeNull(); // → EditCard falls back to countLineDelta
    expect(countLineDelta(src)).toEqual({ added: 2, removed: 1 });
  });
});

describe("extractDiffSource — Codex apply_patch (changes[])", () => {
  // Codex's fileChange tool: rawInput.changes[] of FileUpdateChange
  // ({ path, kind:{type}, diff }). `diff` is full content for add/delete, a
  // unified diff for update. Before the fix these rendered "No diff available".

  it("renders a Codex 'add' as an all-added diff", () => {
    const m = tool({
      rawInput: {
        changes: [
          { path: "/abs/greeting.md", kind: { type: "add" }, diff: "# Greeting\n\nHello, world!\n" },
        ],
      },
    });
    const src = extractDiffSource(m);
    expect(src).toMatchObject({ path: "/abs/greeting.md", before: "", after: "# Greeting\n\nHello, world!\n" });
    // → +3 −0: an 'add' counts every line of the new file as added.
    expect(countLineDelta(src)).toEqual({ added: 3, removed: 0 });
  });

  it("renders a Codex 'delete' as an all-removed diff", () => {
    const m = tool({
      rawInput: { changes: [{ path: "/abs/old.ts", kind: { type: "delete" }, diff: "gone line 1\ngone line 2\n" }] },
    });
    const src = extractDiffSource(m);
    expect(src).toMatchObject({ path: "/abs/old.ts", before: "gone line 1\ngone line 2\n", after: "" });
    expect(countLineDelta(src)).toEqual({ added: 0, removed: 2 });
  });

  it("reconstructs a Codex 'update' from its unified diff", () => {
    const m = tool({
      rawInput: {
        changes: [
          { path: "/abs/foo.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n line1\n-old\n+new" },
        ],
      },
    });
    const src = extractDiffSource(m);
    expect(src).toMatchObject({ path: "/abs/foo.ts", before: "line1\nold", after: "line1\nnew" });
    expect(countLineDelta(src)).toEqual({ added: 1, removed: 1 });
  });

  it("uses the first path-bearing change for a multi-file patch", () => {
    const m = tool({
      rawInput: {
        changes: [
          { path: "/abs/a.ts", kind: { type: "add" }, diff: "one\n" },
          { path: "/abs/b.ts", kind: { type: "add" }, diff: "two\n" },
        ],
      },
    });
    expect(extractDiffSource(m)).toMatchObject({ path: "/abs/a.ts", after: "one\n" });
  });
});

describe("extractDiffSource — Claude MultiEdit (edits[])", () => {
  it("renders a single-edit MultiEdit identically to a plain Edit", () => {
    const m = tool({
      rawInput: { file_path: "/a.ts", edits: [{ old_string: "a\nb", new_string: "a\nB" }] },
    });
    expect(extractDiffSource(m)).toMatchObject({ path: "/a.ts", before: "a\nb", after: "a\nB" });
  });

  it("stacks multiple edits — all old text vs all new text", () => {
    const m = tool({
      rawInput: {
        file_path: "/a.ts",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "baz", new_string: "qux" },
        ],
      },
    });
    const src = extractDiffSource(m);
    expect(src).toMatchObject({ path: "/a.ts", before: "foo\nbaz", after: "bar\nqux" });
    expect(countLineDelta(src)).toEqual({ added: 2, removed: 2 });
  });

  it("accepts camelCase edit fields and skips malformed entries", () => {
    const m = tool({
      rawInput: {
        file_path: "/a.ts",
        edits: [{ oldString: "x", newString: "y" }, { note: "no strings here" }],
      },
    });
    expect(extractDiffSource(m)).toMatchObject({ path: "/a.ts", before: "x", after: "y" });
  });
});

describe("computeEditBaselines — Write-overwrite diff baseline", () => {
  const write = (
    id: string,
    path: string,
    content: string,
    status: AgentToolMessage["status"] = "completed",
  ): AgentToolMessage =>
    tool({ id: `tool-${id}`, toolCallId: id, toolKind: "edit", status, rawInput: { file_path: path, content } });
  const edit = (
    id: string,
    path: string,
    status: AgentToolMessage["status"] = "completed",
  ): AgentToolMessage =>
    tool({ id: `tool-${id}`, toolCallId: id, toolKind: "edit", status, rawInput: { file_path: path, old_string: "x", new_string: "y" } });

  it("gives a 2nd write to the same path the 1st write's content as baseline", () => {
    const msgs: AgentMessage[] = [write("w1", "/a.md", "A"), write("w2", "/a.md", "B")];
    const b = computeEditBaselines(msgs);
    expect(b.get("w1")).toBeUndefined(); // first write = new file, no baseline
    expect(b.get("w2")).toBe("A"); // overwrite diffs against the prior content
  });

  it("chains across three writes (each diffs against its predecessor)", () => {
    const msgs: AgentMessage[] = [write("w1", "/a", "A"), write("w2", "/a", "B"), write("w3", "/a", "C")];
    const b = computeEditBaselines(msgs);
    expect(b.get("w2")).toBe("A");
    expect(b.get("w3")).toBe("B");
  });

  it("does not cross paths", () => {
    const msgs: AgentMessage[] = [write("w1", "/a", "A"), write("w2", "/b", "B")];
    expect(computeEditBaselines(msgs).size).toBe(0);
  });

  it("an intervening Edit invalidates the baseline (we lose the full file)", () => {
    const msgs: AgentMessage[] = [write("w1", "/a", "A"), edit("e1", "/a"), write("w2", "/a", "C")];
    // After the Edit we can't reconstruct the file, so w2 falls back to all-additions.
    expect(computeEditBaselines(msgs).get("w2")).toBeUndefined();
  });

  it("a FAILED write neither records its content nor breaks the chain (2026-08-01)", () => {
    // w2 never touched the disk, so w3's real "before" is still w1's content.
    // Before the status guard, w3 diffed against w2's phantom body.
    const msgs: AgentMessage[] = [
      write("w1", "/a.md", "A"),
      write("w2", "/a.md", "B", "failed"),
      write("w3", "/a.md", "C"),
    ];
    const b = computeEditBaselines(msgs);
    expect(b.get("w3")).toBe("A");
    // The failed write still RECEIVES the prior baseline — its card truthfully
    // shows "what this would have changed" against the file's real content.
    expect(b.get("w2")).toBe("A");
  });

  it("a FAILED snippet Edit does not invalidate a baseline that is still true", () => {
    const msgs: AgentMessage[] = [
      write("w1", "/a.md", "A"),
      edit("e1", "/a.md", "failed"),
      write("w2", "/a.md", "C"),
    ];
    expect(computeEditBaselines(msgs).get("w2")).toBe("A");
  });

  it("an in-flight write gets the prior baseline but invalidates for successors", () => {
    // Mid-stream, w2's card already diffs against w1 (its "before" is certain);
    // but until w2 completes its own content isn't trustworthy as a baseline —
    // an aborted turn can strand it in_progress forever.
    const msgs: AgentMessage[] = [
      write("w1", "/a.md", "A"),
      write("w2", "/a.md", "B", "in_progress"),
      write("w3", "/a.md", "C"),
    ];
    const b = computeEditBaselines(msgs);
    expect(b.get("w2")).toBe("A");
    expect(b.get("w3")).toBeUndefined();
  });

  it("end-to-end: the 2nd write renders a real diff (the claude-test.md case)", () => {
    const before = "# Claude\n\nClaude is honest.\n";
    const after = "# Claude: The Companion\n\nClaude is brilliant.\n\n- New bullet\n";
    const msgs: AgentMessage[] = [write("w1", "/c.md", before), write("w2", "/c.md", after)];
    const baseline = computeEditBaselines(msgs).get("w2");
    const src = extractDiffSource(msgs[1] as AgentToolMessage, baseline);
    expect(src).toMatchObject({ path: "/c.md", before, after });
    // Real diff with removals — NOT all-additions.
    const counts = countLineDelta(src);
    expect(counts!.removed).toBeGreaterThan(0);
    expect(counts!.added).toBeGreaterThan(0);
  });
});

describe("extractDiffSource — write baseline param", () => {
  it("uses the baseline as `before` for a full-content write", () => {
    const m = tool({ rawInput: { file_path: "/a.md", content: "new\nbody" } });
    expect(extractDiffSource(m, "old\nbody")).toMatchObject({ before: "old\nbody", after: "new\nbody" });
  });

  it("falls back to empty before (all-additions) when no baseline is given", () => {
    const m = tool({ rawInput: { file_path: "/a.md", content: "new\nbody" } });
    expect(extractDiffSource(m)).toMatchObject({ before: "", after: "new\nbody" });
  });

  it("ignores the baseline for an Edit (old/new snippet keeps its own before)", () => {
    const m = tool({ rawInput: { file_path: "/a.md", old_string: "a", new_string: "b" } });
    expect(extractDiffSource(m, "SHOULD-BE-IGNORED")).toMatchObject({ before: "a", after: "b" });
  });
});

describe("buildUnifiedDiffPatch — git patch string fed to <PatchDiff>", () => {
  it("builds a new-file (all-additions) patch with /dev/null + @@ -0,0", () => {
    const patch = buildUnifiedDiffPatch("a/new.md", "", "# Hi\n\nbody\n");
    expect(patch).toContain("diff --git a/a/new.md b/a/new.md");
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/a/new.md");
    expect(patch).toContain("@@ -0,0 +1,3 @@");
    expect(patch).toContain("+# Hi");
    expect(patch).not.toMatch(/\n-[^-]/); // no removal lines (the `--- ` header doesn't count)
  });

  it("builds a modify patch with both removals and additions", () => {
    const patch = buildUnifiedDiffPatch("foo.ts", "line1\nold\nline3\n", "line1\nnew\nline3\n");
    expect(patch).toContain("diff --git a/foo.ts b/foo.ts");
    expect(patch).toContain("--- a/foo.ts");
    expect(patch).toContain("+++ b/foo.ts");
    expect(patch).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
    expect(patch).toContain(" line1"); // context line (leading space)
  });

  it("returns '' when there is no change (caller renders 'No changes')", () => {
    expect(buildUnifiedDiffPatch("foo.ts", "same\n", "same\n")).toBe("");
  });
});

describe("resolveEditCounts — header-chip count precedence (EditCard)", () => {
  it("prefers the agent's authoritative counts over the reconstructed-diff counts", () => {
    // Cursor reports linesAdded:1/linesRemoved:1 for an empty→content edit, but a
    // diff reconstructed from `-\n+# Test` would count 1/0. Authoritative wins.
    const m = tool({
      rawInput: { path: "/abs/test.md" },
      rawOutput: {
        status: "success",
        value: {
          linesAdded: 1,
          linesRemoved: 1,
          diffString: "--- /dev/null\n+++ b//abs/test.md\n@@ -1 +1 @@\n-\n+# Test",
        },
      },
    });
    expect(resolveEditCounts(m, extractDiffSource(m), undefined)).toEqual({ added: 1, removed: 1 });
  });

  it("falls back to diffing before/after when the agent reports no count (Claude/Codex)", () => {
    const m = tool({ rawInput: { file_path: "/a.ts", old_string: "a\nb", new_string: "a\nB\nc" } });
    expect(resolveEditCounts(m, extractDiffSource(m), undefined)).toEqual({ added: 2, removed: 1 });
  });

  it("uses the baseline DIFF for an overwriting Cursor write — not the whole-file linesCreated", () => {
    // The bug: a Cursor write that overwrites a file the agent wrote earlier this
    // session reports linesCreated = the whole new file (e.g. 3) as all-additions,
    // but the card renders a real before→after diff against the baseline. Without
    // the baseline gate the badge would read "+3 −0" over a body showing a removal.
    const baseline = "line one\nold line\nline three";
    const after = "line one\nnew line\nline three";
    const m = tool({
      rawInput: { path: "/abs/foo.ts", fileText: after },
      rawOutput: { status: "success", value: { path: "/abs/foo.ts", linesCreated: 3, fileSize: 40 } },
    });
    // outputLineCounts alone would mislead (+3 −0)…
    expect(outputLineCounts(m)).toEqual({ added: 3, removed: 0 });
    // …but resolveEditCounts honors the baseline diff: 1 added, 1 removed.
    const src = extractDiffSource(m, baseline);
    expect(resolveEditCounts(m, src, baseline)).toEqual({ added: 1, removed: 1 });
  });

  it("still uses linesCreated for a NEW Cursor write (no baseline → all-additions agree)", () => {
    const m = tool({
      rawInput: { path: "/abs/new.ts", fileText: "a\nb\nc" },
      rawOutput: { status: "success", value: { path: "/abs/new.ts", linesCreated: 3, fileSize: 10 } },
    });
    expect(resolveEditCounts(m, extractDiffSource(m), undefined)).toEqual({ added: 3, removed: 0 });
  });

  it("treats an empty-string baseline as a real baseline (overwrite of an empty file)", () => {
    // baseline "" is still a baseline: diff "" → content is all-additions, which
    // happens to equal linesCreated, but the gate must fire on `!== undefined`.
    const m = tool({
      rawInput: { path: "/abs/e.ts", fileText: "x\ny" },
      rawOutput: { status: "success", value: { linesCreated: 99, fileSize: 4 } },
    });
    expect(resolveEditCounts(m, extractDiffSource(m, ""), "")).toEqual({ added: 2, removed: 0 });
  });
});

describe("write-mode detection — the \"Write N lines\" row (2026-07-05)", () => {
  // Whole-file writes read "Write N lines" (like "Read N lines") with no ±
  // badge; snippet edits/patches stay "Edit <file> +N −M". The renderer keys
  // off DiffSource.write, set only by the full-content branches.

  it("flags a Claude Write (content) as write", () => {
    const m = tool({ rawInput: { file_path: "/a.md", content: "1\n2\n3" } });
    expect(extractDiffSource(m)).toMatchObject({ path: "/a.md", write: true });
  });

  it("flags a Cursor write (fileText) as write", () => {
    const m = tool({ rawInput: { path: "/a.md", fileText: "1\n2" } });
    expect(extractDiffSource(m)).toMatchObject({ path: "/a.md", write: true });
  });

  it("flags a Codex apply_patch 'add' as write", () => {
    const m = tool({
      rawInput: { changes: [{ path: "/a.md", kind: { type: "add" }, diff: "1\n2\n" }] },
    });
    expect(extractDiffSource(m)).toMatchObject({ path: "/a.md", write: true });
  });

  it("keeps a baseline overwrite as write (still a whole-file replace)", () => {
    const m = tool({ rawInput: { file_path: "/a.md", content: "new\nbody" } });
    const src = extractDiffSource(m, "old\nbody");
    expect(src).toMatchObject({ before: "old\nbody", after: "new\nbody", write: true });
  });

  it("does NOT flag snippet edits, MultiEdit, Codex update/delete, or Cursor result diffs", () => {
    const edit = tool({ rawInput: { file_path: "/a.ts", old_string: "x", new_string: "y" } });
    expect(extractDiffSource(edit)?.write).not.toBe(true);
    const multi = tool({
      rawInput: { file_path: "/a.ts", edits: [{ old_string: "x", new_string: "y" }] },
    });
    expect(extractDiffSource(multi)?.write).not.toBe(true);
    const update = tool({
      rawInput: {
        changes: [
          { path: "/a.ts", kind: { type: "update" }, diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y" },
        ],
      },
    });
    expect(extractDiffSource(update)?.write).not.toBe(true);
    const del = tool({
      rawInput: { changes: [{ path: "/a.ts", kind: { type: "delete" }, diff: "x\n" }] },
    });
    expect(extractDiffSource(del)?.write).not.toBe(true);
    const cursorEdit = tool({
      rawInput: { path: "/a.ts" },
      rawOutput: {
        status: "success",
        value: { diffString: "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y" },
      },
    });
    expect(extractDiffSource(cursorEdit)?.write).not.toBe(true);
  });
});

describe("contentLineCount — the N in \"Write N lines\"", () => {
  it("counts lines, stripping ONE trailing newline (matches the Read row)", () => {
    expect(contentLineCount("a\nb\nc")).toBe(3);
    expect(contentLineCount("a\nb\nc\n")).toBe(3); // not 4 — the RSCiEM off-by-one
    expect(contentLineCount("a\n\n")).toBe(2);
    expect(contentLineCount("a")).toBe(1);
    expect(contentLineCount("")).toBe(0);
  });
});

describe("real-patch rendering — actual file line numbers (2026-07-05)", () => {
  // The diff body should render the agent's OWN patch when one exists (real
  // hunk headers → real gutter line numbers),
  // falling back to snippet re-diffing only when it doesn't.

  const HUNK = {
    oldStart: 40,
    oldLines: 3,
    newStart: 40,
    newLines: 4,
    lines: [" ctx", "-old", "+new1", "+new2"],
  };

  it("Claude structuredPatch (translator rawOutput) wins over input snippets", () => {
    const m = tool({
      rawInput: { file_path: "/x.ts", old_string: "old", new_string: "new1\nnew2" },
      rawOutput: { structuredPatch: [HUNK] },
    });
    const src = extractDiffSource(m);
    expect(src?.patch).toContain("@@ -40,3 +40,4 @@"); // real line numbers
    expect(src?.patch).toContain("+++ b//x.ts"); // headers present
    expect(src?.write).toBe(false);
    // Counts come from the patch sigils, matching the rendered body exactly.
    expect(resolveEditCounts(m, src, undefined)).toEqual({ added: 2, removed: 1 });
  });

  it("Claude Write with structuredPatch keeps the write flag (row still 'Write N lines')", () => {
    const m = tool({
      rawInput: { file_path: "/x.md", content: "a\nb\nc\n" },
      rawOutput: {
        structuredPatch: [
          { oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ["+a", "+b", "+c"] },
        ],
      },
    });
    const src = extractDiffSource(m);
    expect(src?.write).toBe(true);
    expect(src?.patch).toContain("--- /dev/null"); // new-file form
    expect(src?.patch).toContain("@@ -1,0 +1,3 @@");
  });

  it("Cursor result diffString is carried as the render patch", () => {
    const m = tool({
      rawInput: { path: "/abs/foo.ts" },
      rawOutput: {
        status: "success",
        value: {
          diffString: "--- a/foo.ts\n+++ b/foo.ts\n@@ -7,2 +7,3 @@\n line1\n-old\n+new1\n+new2",
        },
      },
    });
    const src = extractDiffSource(m);
    expect(src?.patch).toContain("@@ -7,2 +7,3 @@");
    expect(resolveEditCounts(m, src, undefined)).toEqual({ added: 2, removed: 1 });
  });

  it("Codex 'update' unified diff is carried as the render patch", () => {
    const m = tool({
      rawInput: {
        changes: [
          {
            path: "/a.ts",
            kind: { type: "update" },
            diff: "--- a/a.ts\n+++ b/a.ts\n@@ -12,1 +12,1 @@\n-x\n+y",
          },
        ],
      },
    });
    const src = extractDiffSource(m);
    expect(src?.patch).toContain("@@ -12,1 +12,1 @@");
  });

  it("snippet edits (no agent patch) carry no patch — renderer re-diffs", () => {
    const m = tool({
      rawInput: { file_path: "/a.ts", old_string: "a\nb", new_string: "a\nB" },
    });
    expect(extractDiffSource(m)?.patch).toBeUndefined();
  });
});

describe("editFallbackText — the failed edit's error line (2026-08-01)", () => {
  // A failed edit's tool_call_update carries the error as a content text block
  // (Claude translator strips the <tool_use_error> wrapper). EditCard renders
  // it above the attempted diff so an expanded failed row answers WHY.

  it("reads the error from the result's content text block", () => {
    const m = tool({
      status: "failed",
      rawInput: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      content: [
        {
          type: "content",
          content: { type: "text", text: "String to replace not found in file." },
        },
      ] as never,
    });
    expect(editFallbackText(m)).toBe("String to replace not found in file.");
  });

  it("falls back to a STRING rawOutput, and never JSON-dumps an object one", () => {
    expect(editFallbackText(tool({ rawOutput: "File has not been read yet." }))).toBe(
      "File has not been read yet.",
    );
    expect(editFallbackText(tool({ rawOutput: { jsonrpc: "2.0", error: {} } }))).toBeNull();
  });
});

describe("ensureFileHeaders — parser-safe patches", () => {
  it("prepends ---/+++ headers to a bare @@ patch", () => {
    const p = ensureFileHeaders("@@ -1,1 +1,1 @@\n-x\n+y", "/a.ts");
    expect(p.startsWith("--- a//a.ts\n+++ b//a.ts\n@@")).toBe(true);
  });

  it("passes through patches that already have headers", () => {
    const withUnified = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-x\n+y";
    expect(ensureFileHeaders(withUnified, "/a.ts")).toBe(withUnified);
    const withGit = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y";
    expect(ensureFileHeaders(withGit, "/a.ts")).toBe(withGit);
  });
});

describe("buildUnifiedDiffPatch — no spurious 'No newline' markers (2026-07-05)", () => {
  it("normalizes snippet inputs so jsdiff adds no \\ No-newline marker", () => {
    // Claude Edit snippets rarely end with \n; the marker is an extraction
    // artifact, not a fact about the file.
    const patch = buildUnifiedDiffPatch("a.ts", "line1\nold", "line1\nnew");
    expect(patch).not.toContain("No newline at end of file");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
  });
});
