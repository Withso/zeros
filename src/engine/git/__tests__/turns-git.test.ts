// Tests for the per-turn git plumbing (snapshots, attribution, reset). Uses a
// real temp git repo (mirrors detach.test.ts). Covers the concurrency crux: a
// reset must restore THIS chat's authored change, preserve a concurrent
// non-overlapping edit (3-way merge), and CONFLICT rather than clobber on an
// overlapping edit.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  snapshotWorkingTree,
  snapshotRef,
  blobOid,
  turnFileDiffs,
  turnPatch,
  authoredPathsFromMessages,
  repoToplevel,
  applyTurnReset,
  applyTurnSpanReset,
  undoTurnReset,
  treesIdentical,
  deleteAllChatSnapshotRefs,
  pruneResetSnapshots,
} from "../turns-git";
import type { AgentMessage } from "@zeros/core/agent-messages";

const exec = promisify(execFile);

async function initRepo(root: string): Promise<void> {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
  await exec("git", ["config", "user.email", "t@t"], { cwd: root });
  await exec("git", ["config", "user.name", "t"], { cwd: root });
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

function read(root: string, p: string): Promise<string> {
  return readFile(path.join(root, p), "utf8");
}

function toolMsg(
  toolKind: string,
  filePath: string,
  status: "completed" | "pending" = "completed",
): AgentMessage {
  return {
    id: `tool-${filePath}-${toolKind}`,
    kind: "tool",
    toolCallId: `${filePath}-${toolKind}`,
    title: toolKind,
    toolKind,
    status,
    rawInput: { file_path: filePath },
    createdAt: 1,
    updatedAt: 1,
  } as AgentMessage;
}

describe("turns-git", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-turns-test-"));
    await initRepo(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("snapshots the work tree to a hidden ref and resolves blobs", async () => {
    await writeFile(path.join(root, "a.txt"), "one\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c1", "t1", "pre"));
    expect(pre).toMatch(/^[0-9a-f]{40,64}$/);

    await writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n");
    const post = await snapshotWorkingTree(
      root,
      snapshotRef("c1", "t1", "post"),
    );
    expect(post).toBeTruthy();

    // Snapshot refs are hidden under refs/zeros and don't move HEAD/branch.
    const { stdout: branch } = await exec("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const { stdout: ref } = await exec(
      "git",
      ["rev-parse", snapshotRef("c1", "t1", "pre")],
      { cwd: root },
    );
    expect(ref.trim()).toBe(pre);
    expect(branch.trim()).not.toBe(pre); // HEAD is the init commit, not a snapshot

    const oidPre = await blobOid(root, pre!, "a.txt");
    const oidPost = await blobOid(root, post!, "a.txt");
    expect(oidPre).toBeTruthy();
    expect(oidPost).toBeTruthy();
    expect(oidPre).not.toBe(oidPost);
    expect(await blobOid(root, pre!, "missing.txt")).toBeNull();
  });

  it("computes per-turn ± counts and a patch restricted to authored paths", async () => {
    await writeFile(path.join(root, "a.txt"), "1\n2\n");
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "1\n2\n3\n4\n");
    await writeFile(path.join(root, "b.txt"), "noise\n"); // concurrent / unrelated
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t", "post"),
    ))!;

    const diffs = await turnFileDiffs(root, pre, post, ["a.txt"]);
    expect(diffs).toHaveLength(1); // b.txt excluded — not authored
    expect(diffs[0].path).toBe("a.txt");
    expect(diffs[0].additions).toBe(2);
    expect(diffs[0].deletions).toBe(0);

    const patch = await turnPatch(root, pre, post, ["a.txt"]);
    expect(patch).toContain("a.txt");
    expect(patch).not.toContain("b.txt");
  });

  it("keeps concurrent agents' different files in their own turns with no duplicates", async () => {
    await writeFile(path.join(root, "a.txt"), "before-a\n");
    await writeFile(path.join(root, "b.txt"), "before-b\n");
    const sharedPre = (await snapshotWorkingTree(
      root,
      snapshotRef("shared", "pre", "pre"),
    ))!;

    // Both agents overlap in wall-clock time and both changes are present by
    // the time either whole-tree post snapshot is captured.
    await writeFile(path.join(root, "a.txt"), "agent-a\n");
    await writeFile(path.join(root, "b.txt"), "agent-b\n");
    const postA = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t1", "post"),
    ))!;
    const postB = (await snapshotWorkingTree(
      root,
      snapshotRef("chatB", "t1", "post"),
    ))!;

    const filesA = await turnFileDiffs(root, sharedPre, postA, ["a.txt"]);
    const filesB = await turnFileDiffs(root, sharedPre, postB, ["b.txt"]);
    expect(filesA.map((file) => file.path)).toEqual(["a.txt"]);
    expect(filesB.map((file) => file.path)).toEqual(["b.txt"]);
    expect(new Set([...filesA, ...filesB].map((file) => file.path)).size).toBe(
      2,
    );
  });

  it("attributes authored files from edit/delete tool calls only", async () => {
    const msgs: AgentMessage[] = [
      toolMsg("read", "read-only.txt"), // not authored
      toolMsg("edit", "src/a.ts"),
      toolMsg("delete", "src/b.ts"),
      toolMsg("edit", "src/c.ts", "pending"), // never ran → excluded
    ];
    const authored = authoredPathsFromMessages(msgs, root);
    const paths = authored.map((a) => a.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(authored.find((a) => a.path === "src/b.ts")?.kind).toBe("delete");
  });

  it("attributes persisted shell deletions and reports their real removed lines", async () => {
    await writeFile(path.join(root, "victim.txt"), "one\ntwo\nthree\nfour\n");
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "shell-delete", "pre"),
    ))!;
    await rm(path.join(root, "victim.txt"));
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "shell-delete", "post"),
    ))!;
    const execute = {
      id: "tool-rm",
      kind: "tool",
      toolCallId: "rm",
      title: "Delete victim.txt",
      toolKind: "execute",
      status: "completed",
      rawInput: { command: `rm '${path.join(root, "victim.txt")}'`, cwd: root },
      createdAt: 1,
      updatedAt: 1,
    } as AgentMessage;

    const authored = authoredPathsFromMessages([execute], root);
    expect(authored).toEqual([{ path: "victim.txt", kind: "delete" }]);
    expect(
      await turnFileDiffs(
        root,
        pre,
        post,
        authored.map((a) => a.path),
      ),
    ).toEqual([
      {
        path: "victim.txt",
        status: "deleted",
        additions: 0,
        deletions: 4,
      },
    ]);
  });

  it("recovers shell redirections and cd-relative mutations without treating reads as edits", () => {
    const execute = (id: string, command: string): AgentMessage =>
      ({
        id: `tool-${id}`,
        kind: "tool",
        toolCallId: id,
        title: command,
        toolKind: "execute",
        status: "completed",
        rawInput: { command, cwd: root },
        createdAt: 1,
        updatedAt: 1,
      }) as AgentMessage;
    const authored = authoredPathsFromMessages(
      [
        execute(
          "write",
          "mkdir -p src && cd src && printf 'hello\\n' > made.txt",
        ),
        execute("delete", "cd src; rm -- old.txt"),
        execute("read", "cat seed.txt"),
      ],
      root,
    );
    expect(authored.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "src/made.txt", kind: "edit" },
      { path: "src/old.txt", kind: "delete" },
    ]);
  });

  it("never attributes the worktree root — a '.' pathspec would sweep in concurrent work", () => {
    const execute = (id: string, command: string): AgentMessage =>
      ({
        id: `tool-${id}`,
        kind: "tool",
        toolCallId: id,
        title: command,
        toolKind: "execute",
        status: "completed",
        rawInput: { command, cwd: root },
        createdAt: 1,
        updatedAt: 1,
      }) as AgentMessage;
    const authored = authoredPathsFromMessages(
      [
        execute("restore", "git restore ."),
        execute("checkout", "git checkout -- ."),
        execute("copy", `cp -r /tmp/seed ${root}`),
        execute("touch-root", "touch ."),
      ],
      root,
    );
    expect(authored).toEqual([]);
  });

  it("drops proposed or denied edits when the snapshots contain no persisted delta", async () => {
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "denied", "pre"),
    ))!;
    const deniedPreview = {
      ...toolMsg("write", "never-created.txt"),
      status: "failed",
    } as AgentMessage;
    const authored = authoredPathsFromMessages([deniedPreview], root);
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "denied", "post"),
    ))!;
    expect(authored).toEqual([]);
    expect(
      await turnFileDiffs(
        root,
        pre,
        post,
        authored.map((a) => a.path),
      ),
    ).toEqual([]);
  });

  it("attributes an edit across EVERY adapter's tool shape (fidelity contract)", async () => {
    // One representative edit per adapter, taken from each translator's tool
    // construction. This is the guard that the Codex `changes[].path` regression
    // (edits silently recording 0 files) can't come back via another adapter:
    // a NEW edit shape must be ADDED here AND taught to pathsFromTool, or this
    // test fails. Sources:
    //   • Claude   — claude/translator.ts: Write/Edit/MultiEdit → kind "edit",
    //                rawInput.file_path.
    //   • Codex    — codex/app-server-translator.ts: fileChange → kind "edit",
    //                rawInput.changes[].path (one-or-MANY files per call).
    //   • Cursor   — cursor-sdk/translator.ts: edit/write → kind "edit",
    //                rawInput.path (+ diff or content).
    //   • ACP      — cross-adapter `locations[].path`, present even sans rawInput.
    const cases: Array<{
      name: string;
      kind: string;
      rawInput?: unknown;
      locations?: Array<{ path: string }>;
      expect: string[];
    }> = [
      {
        name: "claude",
        kind: "edit",
        rawInput: { file_path: "src/a.ts" },
        expect: ["src/a.ts"],
      },
      {
        name: "claude-write",
        kind: "write",
        rawInput: { file_path: "src/w.ts" },
        expect: ["src/w.ts"],
      },
      {
        name: "codex",
        kind: "edit",
        rawInput: { changes: [{ path: "a.md" }, { path: "src/b.ts" }] },
        expect: ["a.md", "src/b.ts"],
      },
      {
        name: "cursor-diff",
        kind: "edit",
        rawInput: { path: "src/c.ts", diff: "@@ -1 +1 @@" },
        expect: ["src/c.ts"],
      },
      {
        name: "cursor-write",
        kind: "edit",
        rawInput: { path: "src/d.ts", content: "x" },
        expect: ["src/d.ts"],
      },
      {
        name: "acp-locations",
        kind: "edit",
        locations: [{ path: "src/e.ts" }],
        expect: ["src/e.ts"],
      },
    ];
    const got = cases.map((c) => {
      const msg = {
        id: `tool-${c.name}`,
        kind: "tool",
        toolCallId: c.name,
        title: c.name,
        toolKind: c.kind,
        status: "completed",
        ...(c.rawInput !== undefined ? { rawInput: c.rawInput } : {}),
        ...(c.locations ? { locations: c.locations } : {}),
        createdAt: 1,
        updatedAt: 1,
      } as AgentMessage;
      return {
        name: c.name,
        paths: authoredPathsFromMessages([msg], root)
          .map((a) => a.path)
          .sort(),
      };
    });
    const want = cases.map((c) => ({
      name: c.name,
      paths: c.expect.slice().sort(),
    }));
    // Asserting the whole table at once names the offending adapter in the diff.
    expect(got).toEqual(want);
  });

  it("reset (linear/fast path): restores the file to its pre-turn content", async () => {
    await writeFile(path.join(root, "a.txt"), "A\n");
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "A\nB\n"); // the turn's edit
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "post"),
    ))!;

    // current on disk == post (nobody else touched it) → exact restore.
    const res = await applyTurnReset(root, "c", ["a.txt"], pre, post);
    expect(res.conflicts).toHaveLength(0);
    expect(res.preResetSnapshot).toBeTruthy();
    expect(await read(root, "a.txt")).toBe("A\n");
  });

  it("reset (concurrent, non-overlapping): 3-way merge keeps the other edit", async () => {
    await writeFile(path.join(root, "a.txt"), "L1\nL2\nL3\n");
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "L1\nL2\nX\n"); // this chat changed L3
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "post"),
    ))!;
    // A concurrent chat then changes L1 (different line) on disk:
    await writeFile(path.join(root, "a.txt"), "Y\nL2\nX\n");

    const res = await applyTurnReset(root, "c", ["a.txt"], pre, post);
    expect(res.conflicts).toHaveLength(0);
    // This chat's L3 change reverted (X→L3); the concurrent L1 change (Y) kept.
    expect(await read(root, "a.txt")).toBe("Y\nL2\nL3\n");
  });

  it("reset (concurrent, overlapping): conflicts instead of clobbering", async () => {
    await writeFile(path.join(root, "a.txt"), "L1\n");
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "CHAT\n"); // this chat
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "post"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "OTHER\n"); // concurrent, SAME line

    const res = await applyTurnReset(root, "c", ["a.txt"], pre, post);
    expect(res.conflicts.map((c) => c.path)).toContain("a.txt");
    // The other chat's content is preserved, NOT clobbered.
    expect(await read(root, "a.txt")).toBe("OTHER\n");
  });

  it("span reset preserves another agent's edit interleaved between this chat's turns", async () => {
    await writeFile(path.join(root, "a.txt"), "L1\nL2\nL3\n");
    const pre1 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t1", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "L1\nL2\nA1\n");
    const post1 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t1", "post"),
    ))!;

    // Another agent changes a different line before chat A's next turn.
    await writeFile(path.join(root, "a.txt"), "OTHER\nL2\nA1\n");
    const pre2 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t2", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "OTHER\nA2\nA1\n");
    const post2 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t2", "post"),
    ))!;

    const res = await applyTurnSpanReset(root, "chatA", [
      { paths: ["a.txt"], preSnapshot: pre1, postSnapshot: post1 },
      { paths: ["a.txt"], preSnapshot: pre2, postSnapshot: post2 },
    ]);
    expect(res.conflicts).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.applied.map((item) => item.path)).toEqual(["a.txt"]);
    expect(await read(root, "a.txt")).toBe("OTHER\nL2\nL3\n");
  });

  it("span reset preflights pruned snapshots and never partially reverts a path", async () => {
    await writeFile(path.join(root, "a.txt"), "base\n");
    const pre2 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t2", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "later\n");
    const post2 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t2", "post"),
    ))!;

    const res = await applyTurnSpanReset(root, "chatA", [
      { paths: ["a.txt"], preSnapshot: null, postSnapshot: null },
      { paths: ["a.txt"], preSnapshot: pre2, postSnapshot: post2 },
    ]);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toMatchObject([
      { path: "a.txt", result: "skipped", reason: "no snapshot available" },
    ]);
    expect(await read(root, "a.txt")).toBe("later\n");
  });

  it("span reset rolls a path back to its starting state when an older inverse conflicts", async () => {
    await writeFile(path.join(root, "a.txt"), "BASE\n");
    const pre1 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t1", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "TURN-1\n");
    const post1 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t1", "post"),
    ))!;

    // A concurrent overlapping edit exists before the later turn. Reverting t2
    // can succeed, but reverting t1 from that state must conflict.
    await writeFile(path.join(root, "a.txt"), "OTHER\n");
    const pre2 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t2", "pre"),
    ))!;
    await writeFile(path.join(root, "a.txt"), "TURN-2\n");
    const post2 = (await snapshotWorkingTree(
      root,
      snapshotRef("chatA", "t2", "post"),
    ))!;

    const res = await applyTurnSpanReset(root, "chatA", [
      { paths: ["a.txt"], preSnapshot: pre1, postSnapshot: post1 },
      { paths: ["a.txt"], preSnapshot: pre2, postSnapshot: post2 },
    ]);
    expect(res.applied).toEqual([]);
    expect(res.conflicts.map((item) => item.path)).toEqual(["a.txt"]);
    // The successful t2 inverse was rolled back after t1 conflicted.
    expect(await read(root, "a.txt")).toBe("TURN-2\n");
  });

  it("reset deletes a file the turn created (when undisturbed since)", async () => {
    const pre = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "pre"),
    ))!;
    await writeFile(path.join(root, "new.txt"), "created by turn\n");
    const post = (await snapshotWorkingTree(
      root,
      snapshotRef("c", "t1", "post"),
    ))!;

    const res = await applyTurnReset(root, "c", ["new.txt"], pre, post);
    expect(res.conflicts).toHaveLength(0);
    await expect(read(root, "new.txt")).rejects.toThrow(); // gone
  });

  it("anchors snapshot/attribution/reset at the worktree TOP when the agent ran in a subdir", async () => {
    // The chat folder is a SUBDIR of the worktree (a chat opened in a monorepo
    // package). Snapshotting from there with the empty scratch index would
    // capture only the subdir (prefix-stripped) and `<rev>:<path>` lookups would
    // miss — so everything must anchor at the top.
    const top = (await repoToplevel(root))!;
    expect(top).toBeTruthy();
    const sub = path.join(top, "pkg");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "app.ts"), "A\n");
    const pre = (await snapshotWorkingTree(
      top,
      snapshotRef("c", "t1", "pre"),
    ))!;
    await writeFile(path.join(sub, "app.ts"), "A\nB\n"); // the turn's edit
    const post = (await snapshotWorkingTree(
      top,
      snapshotRef("c", "t1", "post"),
    ))!;

    // The agent (cwd = sub) reports a subdir-relative path; attribution must
    // root it at the worktree top, and the whole-tree snapshot keeps that path.
    const authored = authoredPathsFromMessages(
      [toolMsg("edit", "app.ts")],
      sub,
      top,
    );
    expect(authored.map((a) => a.path)).toEqual(["pkg/app.ts"]);
    expect(await blobOid(top, post, "pkg/app.ts")).toBeTruthy();

    const res = await applyTurnReset(top, "c", ["pkg/app.ts"], pre, post);
    expect(res.skipped).toHaveLength(0);
    expect(res.conflicts).toHaveLength(0);
    expect(res.applied.map((o) => o.path)).toEqual(["pkg/app.ts"]);
    expect(await readFile(path.join(sub, "app.ts"), "utf8")).toBe("A\n"); // reverted
  });

  async function refsUnder(prefix: string): Promise<string[]> {
    const { stdout } = await exec(
      "git",
      ["for-each-ref", "--format=%(refname)", prefix],
      { cwd: root },
    );
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it("deleteAllChatSnapshotRefs drops a chat's turn + reset refs (only that chat)", async () => {
    await writeFile(path.join(root, "a.txt"), "a\n");
    await snapshotWorkingTree(root, snapshotRef("chatA", "t1", "pre"));
    await snapshotWorkingTree(root, snapshotRef("chatA", "t1", "post"));
    await snapshotWorkingTree(root, snapshotRef("chatB", "t1", "pre")); // other chat
    // A reset ref for chatA (the pre-reset escape-hatch snapshot).
    await applyTurnReset(root, "chatA", [], null, null);

    expect((await refsUnder("refs/zeros/")).length).toBeGreaterThan(0);
    await deleteAllChatSnapshotRefs(root, "chatA");

    expect(await refsUnder("refs/zeros/turns/chatA/")).toHaveLength(0);
    expect(await refsUnder("refs/zeros/resets/chatA/")).toHaveLength(0);
    // chatB's refs are untouched.
    expect((await refsUnder("refs/zeros/turns/chatB/")).length).toBe(1);
  });

  it("pruneResetSnapshots keeps only the newest N reset snapshots", async () => {
    await writeFile(path.join(root, "a.txt"), "a\n");
    // Distinct ref names (the prod stamp is Date.now(); the helper just needs
    // unique, sortable names) — create 4, keep 2.
    for (const stamp of [
      "0000000000001",
      "0000000000002",
      "0000000000003",
      "0000000000004",
    ]) {
      await snapshotWorkingTree(root, `refs/zeros/resets/chatA/${stamp}`);
    }
    expect(await refsUnder("refs/zeros/resets/chatA/")).toHaveLength(4);
    await pruneResetSnapshots(root, "chatA", 2);
    const kept = await refsUnder("refs/zeros/resets/chatA/");
    expect(kept).toHaveLength(2);
    // The two NEWEST (lexicographically largest stamps) survive.
    expect(kept.sort()).toEqual([
      "refs/zeros/resets/chatA/0000000000003",
      "refs/zeros/resets/chatA/0000000000004",
    ]);
  });

  it("treesIdentical: true across a no-op span, false once the tree changed", async () => {
    const a = await snapshotWorkingTree(root, snapshotRef("cT", "t1", "pre"));
    const b = await snapshotWorkingTree(root, snapshotRef("cT", "t1", "post"));
    expect(await treesIdentical(root, a!, b!)).toBe(true);
    await writeFile(path.join(root, "seed.txt"), "changed\n");
    const c = await snapshotWorkingTree(root, snapshotRef("cT", "t2", "post"));
    expect(await treesIdentical(root, a!, c!)).toBe(false);
    // Errors (bogus rev) resolve false — the conservative keep-the-refs answer.
    expect(await treesIdentical(root, a!, "0".repeat(40))).toBe(false);
  });

  it("reset syncs the staged copy when the index holds exactly the reverted blob", async () => {
    await writeFile(path.join(root, "a.txt"), "base\n");
    await exec("git", ["add", "a.txt"], { cwd: root });
    await exec("git", ["commit", "-q", "-m", "base"], { cwd: root });
    const pre = await snapshotWorkingTree(root, snapshotRef("c", "t", "pre"));
    // Agent edits AND the edit gets staged verbatim; agent also creates + stages
    // a new file. Without the index sync, committing after the reset would
    // resurrect both.
    await writeFile(path.join(root, "a.txt"), "agent\n");
    await writeFile(path.join(root, "new.txt"), "brand new\n");
    await exec("git", ["add", "a.txt", "new.txt"], { cwd: root });
    const post = await snapshotWorkingTree(root, snapshotRef("c", "t", "post"));

    const res = await applyTurnSpanReset(root, "c", [
      { paths: ["a.txt", "new.txt"], preSnapshot: pre, postSnapshot: post },
    ]);
    expect(res.applied.map((o) => o.result).sort()).toEqual([
      "deleted",
      "restored",
    ]);
    expect(await read(root, "a.txt")).toBe("base\n");
    // Index synced: nothing staged vs HEAD, and the new file's entry is gone.
    const { stdout: cached } = await exec(
      "git",
      ["diff", "--cached", "--name-only"],
      { cwd: root },
    );
    expect(cached.trim()).toBe("");
    const { stdout: lsNew } = await exec("git", ["ls-files", "--", "new.txt"], {
      cwd: root,
    });
    expect(lsNew.trim()).toBe("");
  });

  it("reset leaves the user's OWN staged content alone (index ≠ reverted blob)", async () => {
    await writeFile(path.join(root, "a.txt"), "base\n");
    await exec("git", ["add", "a.txt"], { cwd: root });
    await exec("git", ["commit", "-q", "-m", "base"], { cwd: root });
    const pre = await snapshotWorkingTree(root, snapshotRef("c", "t", "pre"));
    // The user staged their own intermediate version, THEN the agent wrote the
    // worktree (unstaged). The staged copy is the user's work — hands off.
    await writeFile(path.join(root, "a.txt"), "user staged\n");
    await exec("git", ["add", "a.txt"], { cwd: root });
    const { stdout: stagedOid } = await exec("git", ["rev-parse", ":0:a.txt"], {
      cwd: root,
    });
    await writeFile(path.join(root, "a.txt"), "agent\n");
    const post = await snapshotWorkingTree(root, snapshotRef("c", "t", "post"));

    await applyTurnSpanReset(root, "c", [
      { paths: ["a.txt"], preSnapshot: pre, postSnapshot: post },
    ]);
    expect(await read(root, "a.txt")).toBe("base\n");
    const { stdout: stillStaged } = await exec(
      "git",
      ["rev-parse", ":0:a.txt"],
      { cwd: root },
    );
    expect(stillStaged.trim()).toBe(stagedOid.trim()); // untouched
  });

  it("span reset records a post-reset snapshot (undo's merge base)", async () => {
    await writeFile(path.join(root, "a.txt"), "before\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c", "t", "pre"));
    await writeFile(path.join(root, "a.txt"), "agent\n");
    const post = await snapshotWorkingTree(root, snapshotRef("c", "t", "post"));
    const res = await applyTurnSpanReset(root, "c", [
      { paths: ["a.txt"], preSnapshot: pre, postSnapshot: post },
    ]);
    expect(res.preResetSnapshot).toBeTruthy();
    expect(res.postResetSnapshot).toBeTruthy();
    // pre-reset snapshot holds the agent content (what undo restores)...
    expect(await blobOid(root, res.preResetSnapshot!, "a.txt")).not.toBe(
      await blobOid(root, res.postResetSnapshot!, "a.txt"),
    );
    // ...and the post-reset snapshot holds the tree the reset LEFT.
    expect(await blobOid(root, res.postResetSnapshot!, "a.txt")).toBe(
      await blobOid(root, pre!, "a.txt"),
    );
  });

  it("undo with a merge base preserves an edit made AFTER the reset (3-way)", async () => {
    await writeFile(path.join(root, "a.txt"), "l1\nl2\nl3\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c", "t", "pre"));
    await writeFile(path.join(root, "a.txt"), "l1 agent\nl2\nl3\n");
    const post = await snapshotWorkingTree(root, snapshotRef("c", "t", "post"));
    const res = await applyTurnSpanReset(root, "c", [
      { paths: ["a.txt"], preSnapshot: pre, postSnapshot: post },
    ]);
    expect(await read(root, "a.txt")).toBe("l1\nl2\nl3\n");
    // The user edits a DIFFERENT line between the reset and the undo.
    await writeFile(path.join(root, "a.txt"), "l1\nl2\nl3 user\n");

    const out = await undoTurnReset(
      root,
      res.preResetSnapshot!,
      ["a.txt"],
      res.postResetSnapshot,
    );
    expect(out[0].result).toBe("merged");
    // Agent line back AND the post-reset user edit kept.
    expect(await read(root, "a.txt")).toBe("l1 agent\nl2\nl3 user\n");
  });

  it("undo with a merge base CONFLICTS instead of clobbering an overlapping post-reset edit", async () => {
    await writeFile(path.join(root, "a.txt"), "l1\nl2\nl3\n");
    const pre = await snapshotWorkingTree(root, snapshotRef("c", "t", "pre"));
    await writeFile(path.join(root, "a.txt"), "l1 agent\nl2\nl3\n");
    const post = await snapshotWorkingTree(root, snapshotRef("c", "t", "post"));
    const res = await applyTurnSpanReset(root, "c", [
      { paths: ["a.txt"], preSnapshot: pre, postSnapshot: post },
    ]);
    // The user rewrites the SAME line the undo would bring back.
    await writeFile(path.join(root, "a.txt"), "l1 user\nl2\nl3\n");

    const out = await undoTurnReset(
      root,
      res.preResetSnapshot!,
      ["a.txt"],
      res.postResetSnapshot,
    );
    expect(out[0].result).toBe("conflict");
    // Disk untouched — the user's post-reset edit survives.
    expect(await read(root, "a.txt")).toBe("l1 user\nl2\nl3\n");
    // Legacy (no merge base) is the old blind restore — the documented fallback.
    const blind = await undoTurnReset(root, res.preResetSnapshot!, ["a.txt"]);
    expect(blind[0].result).toBe("restored");
    expect(await read(root, "a.txt")).toBe("l1 agent\nl2\nl3\n");
  });
});
