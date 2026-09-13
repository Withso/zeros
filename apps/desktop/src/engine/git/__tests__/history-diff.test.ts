import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeState, createWorkspace, setStateRootForTesting } from "..";
import { startTurn, finishTurn, type TurnRow } from "../../db/turns";
import {
  historyDiff,
  selectHistoryTurns,
  turnHistoryGroups,
} from "../history-diff";
import { snapshotWorkingTree, snapshotRef } from "../turns-git";
import { diff, log } from "../diff";

const exec = promisify(execFile);
describe("Changes history comparisons", () => {
  let root: string;
  let temp: string;
  let workspaceId: string;
  let seed: string;
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root })).stdout.trim();
  const write = (file: string, value: string) =>
    writeFile(path.join(root, file), value);
  const commit = async (message: string) => {
    await git("add", ".");
    await git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const snapshot = async (id: string) =>
    (await snapshotWorkingTree(root, snapshotRef("chat", id, "post")))!;
  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "zeros-history-"));
    root = path.join(temp, "repo");
    await mkdir(root);
    setStateRootForTesting(path.join(temp, "state"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git(
      "remote",
      "add",
      "origin",
      "https://example.com/test/history.git",
    );
    await write(".gitignore", ".state/\n");
    await write("a.txt", "original\n");
    await write("b.txt", "original\n");
    seed = await commit("initial");
    const workspace = await createWorkspace({ repoRoot: root });
    workspaceId = workspace.workspaceId;
    root = workspace.path;
  });
  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(temp, { recursive: true, force: true });
  });

  it("includes both commit endpoints, cancels intermediate edits and excludes working changes", async () => {
    await write("a.txt", "first\n");
    const from = await commit("first");
    await write("a.txt", "original\n");
    await write("b.txt", "last\n");
    const to = await commit("last");
    await write("b.txt", "uncommitted\n");
    const options = { workspaceId, rawPatch: true, summaryLimit: 1000 };
    const range = await historyDiff(options, {
      kind: "commit-range",
      from,
      to,
    });
    expect(range.patch).toContain("+last");
    expect(range.patch).not.toContain("a.txt");
    expect(range.patch).not.toContain("uncommitted");
    expect((await historyDiff(options, { kind: "commits" })).patch).toBe(
      range.patch,
    );
    const differentBase = await historyDiff({ ...options, base: from }, { kind: "commits" });
    expect(differentBase.patch).toContain("-first");
    const single = await historyDiff(options, {
      kind: "commit-range",
      from,
      to: from,
    });
    expect(single.patch).toContain("+first");
    expect(single.patch).not.toContain("b.txt");
    const summary = await historyDiff(
      { ...options, summaryLimit: 0 },
      { kind: "commit-range", from, to },
    );
    expect(summary).toMatchObject({
      summary: true,
      files: [{ path: "b.txt", additions: 1, deletions: 1 }],
    });
  });

  it("can start a range at the root commit without a parent", async () => {
    const result = await historyDiff(
      { workspaceId, rawPatch: true },
      { kind: "commit-range", from: seed, to: seed },
    );
    expect(result.patch).toContain("new file mode");
    expect(result.patch).toContain("+original");
  });

  it("uses literal file names for per-file working and commit comparisons", async () => {
    await write("[x].txt", "literal before\n");
    await write("x.txt", "other before\n");
    await commit("paths");
    await write("[x].txt", "literal after\n");
    await write("x.txt", "other after\n");
    const working = await diff({
      workspaceId,
      filePath: "[x].txt",
      mode: "worktree-vs-head",
      rawPatch: true,
      summaryLimit: 1000,
    });
    expect(working.patch).toContain("+literal after");
    expect(working.patch).not.toContain("+other after");
    const sha = await commit("literal change");
    const historical = await historyDiff(
      { workspaceId, filePath: "[x].txt", rawPatch: true },
      { kind: "commit-range", from: sha, to: sha },
    );
    expect(historical.patch).toBe(working.patch);
  });

  it("reports an unavailable pinned history instead of claiming no commits exist", async () => {
    await write("a.txt", "branch work\n");
    await commit("branch work");
    await expect(
      log({ workspaceId, base: "main", ref: "f".repeat(40) }),
    ).rejects.toThrow();
  });

  it("combines only authored paths across overlapping turns, including renames", async () => {
    const pre = await snapshot("pre");
    await write("a.txt", "agent-a\n");
    const aPost = await snapshot("a-post");
    await rename(path.join(root, "a.txt"), path.join(root, "renamed.txt"));
    await write("b.txt", "agent-b\n");
    await write("noise.txt", "unrelated\n");
    const bPost = await snapshot("b-post");
    const record = (
      id: string,
      startedAt: number,
      preSnapshot: string,
      postSnapshot: string,
      files: TurnRow["files"],
    ) => {
      startTurn({
        chatId: "chat",
        turnId: id,
        workspaceId,
        folder: root,
        agentId: null,
        summary: id,
        startedAt,
        preSnapshot,
      });
      finishTurn("chat", id, {
        endedAt: startedAt + 100,
        status: "completed",
        stopReason: "end_turn",
        postSnapshot,
        files,
      });
    };
    record("a", 1, pre, aPost, [
      { path: "a.txt", status: "modified", additions: 1, deletions: 1 },
    ]);
    record("b", 2, pre, bPost, [
      { path: "b.txt", status: "modified", additions: 1, deletions: 1 },
      {
        path: "renamed.txt",
        oldPath: "a.txt",
        status: "renamed",
        additions: 1,
        deletions: 1,
      },
    ]);
    const options = { workspaceId, rawPatch: true };
    const all = await historyDiff(options, { kind: "turns" });
    expect(all.patch).toContain("+agent-a");
    expect(all.patch).toContain("+agent-b");
    expect(all.patch).not.toContain("noise.txt");
    expect(
      (
        await historyDiff(options, {
          kind: "turn-range",
          from: { chatId: "chat", turnId: "a" },
          to: { chatId: "chat", turnId: "b" },
        })
      ).patch,
    ).toBe(all.patch);
    const one = await historyDiff(
      { ...options, filePath: "b.txt" },
      { kind: "turns" },
    );
    expect(one.patch).toContain("+agent-b");
    expect(one.patch).not.toContain("renamed.txt");
    const last = await historyDiff(options, { kind: "last-turn" });
    expect(last.patch).toContain("+agent-b");
    await write("c.txt", "third turn\n");
    const cPost = await snapshot("c-post");
    record("c", 3, bPost, cPost, [
      { path: "c.txt", status: "added", additions: 1, deletions: 0 },
    ]);
    const large = await historyDiff(
      { ...options, summaryLimit: 3 },
      { kind: "turns" },
    );
    expect(large.summary).toBe(true);
    expect(large.files).toHaveLength(4);
    expect(large.patch).toBeUndefined();
    await expect(
      historyDiff(options, {
        kind: "turn-range",
        from: { chatId: "elsewhere", turnId: "a" },
        to: { chatId: "chat", turnId: "b" },
      }),
    ).rejects.toThrow("no longer available");
  });
});

describe("turn range planning", () => {
  const turns = Array.from(
    { length: 230 },
    (_, index) =>
      ({
        chatId: "chat",
        turnId: `${index}`,
        preSnapshot: `pre-${index}`,
        postSnapshot: `post-${index}`,
        files: [
          {
            path: `file-${index}`,
            status: "modified",
            additions: 1,
            deletions: 0,
          },
        ],
      }) as TurnRow,
  );
  it("selects inclusive endpoints beyond the old 200-turn limit", () => {
    expect(selectHistoryTurns(turns, { kind: "turns" })).toBe(turns);
    expect(selectHistoryTurns(turns, { kind: "last-turn" })).toEqual([
      turns[0],
    ]);
    expect(
      selectHistoryTurns(turns, {
        kind: "turn-range",
        from: turns[225],
        to: turns[200],
      }),
    ).toEqual(turns.slice(200, 226));
  });
  it("does not emit a renamed path twice when a later turn recreates its old name", () => {
    const original = {
      ...turns[2],
      files: [{ ...turns[2].files[0], path: "a.txt" }],
    };
    const renamed = {
      ...turns[1],
      files: [
        {
          ...turns[1].files[0],
          path: "b.txt",
          oldPath: "a.txt",
          status: "renamed" as const,
        },
      ],
    };
    const recreated = {
      ...turns[0],
      files: [
        { ...turns[0].files[0], path: "a.txt", status: "added" as const },
      ],
    };
    expect(turnHistoryGroups([recreated, renamed, original])).toEqual([
      {
        base: original.preSnapshot,
        head: recreated.postSnapshot,
        paths: ["a.txt", "b.txt"],
      },
    ]);
  });
  it("keeps each overlapping chat file's actual snapshot boundaries", () => {
    const older = { ...turns[1], files: [{ ...turns[1].files[0], path: "a" }] };
    const newer = { ...turns[0], files: [{ ...turns[0].files[0], path: "b" }] };
    expect(turnHistoryGroups([newer, older])).toEqual([
      { base: older.preSnapshot, head: older.postSnapshot, paths: ["a"] },
      { base: newer.preSnapshot, head: newer.postSnapshot, paths: ["b"] },
    ]);
    expect(() => turnHistoryGroups([{ ...older, preSnapshot: null }])).toThrow(
      "snapshots are unavailable",
    );
  });
  it("uses the last completed snapshot when concurrent turns finish out of start order", () => {
    const first = {
      ...turns[1],
      startedAt: 1,
      endedAt: 4,
      files: [{ ...turns[1].files[0], path: "a" }],
    };
    const second = {
      ...turns[0],
      startedAt: 2,
      endedAt: 3,
      files: [{ ...turns[0].files[0], path: "a" }],
    };
    expect(turnHistoryGroups([second, first])).toEqual([
      { base: first.preSnapshot, head: first.postSnapshot, paths: ["a"] },
    ]);
  });
  it("merges rename lineages without duplicating an existing destination", () => {
    const a = { ...turns[2], files: [{ ...turns[2].files[0], path: "a" }] };
    const b = { ...turns[1], files: [{ ...turns[1].files[0], path: "b" }] };
    const rename = {
      ...turns[0],
      files: [
        {
          ...turns[0].files[0],
          path: "b",
          oldPath: "a",
          status: "renamed" as const,
        },
      ],
    };
    expect(turnHistoryGroups([rename, b, a])).toEqual([
      { base: a.preSnapshot, head: rename.postSnapshot, paths: ["a", "b"] },
    ]);
  });
  it("can still read an available file when another selected file's snapshots expired", () => {
    const available = {
      ...turns[0],
      files: [{ ...turns[0].files[0], path: "a" }],
    };
    const unavailable = {
      ...turns[1],
      preSnapshot: null,
      files: [{ ...turns[1].files[0], path: "b" }],
    };
    expect(turnHistoryGroups([available, unavailable], "a")).toEqual([
      {
        base: available.preSnapshot,
        head: available.postSnapshot,
        paths: ["a"],
      },
    ]);
  });
});
