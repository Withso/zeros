import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceService } from "../service";
import { closeState, createWorkspace, setStateRootForTesting } from "../../git";
import { upsertRepoByRoot } from "../../db/projects";
import { finishTurn, startTurn } from "../../db/turns";
import { snapshotRef, snapshotWorkingTree } from "../../git/turns-git";
import {
  bridgeGitDiff,
  bridgeGitChangeCounts,
  bridgeGitLog,
  bridgeTurnsList,
} from "../../../renderer/platform/bridge/workspace-bridge";
import type { RuntimeClient } from "../../../renderer/platform/bridge/ws-client";

const exec = promisify(execFile);

// Exercise the actual renderer bridge → WorkspaceService → SQLite/Git path.
// Mocking useChangesModel or gitDiff would miss a dropped history argument.
describe("Changes history through the application boundary", () => {
  let temp: string;
  let root: string;
  let service: WorkspaceService;
  let bridge: RuntimeClient;
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root })).stdout.trim();
  const write = (name: string, body: string) =>
    writeFile(path.join(root, name), body);
  const commit = async (message: string) => {
    await git("add", ".");
    await git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const record = async (
    turnId: string,
    startedAt: number,
    name: string,
    body: string,
    workspaceId = "local-main",
  ) => {
    const preSnapshot = await snapshotWorkingTree(
      root,
      snapshotRef("chat", turnId, "pre"),
    );
    await write(name, body);
    const postSnapshot = await snapshotWorkingTree(
      root,
      snapshotRef("chat", turnId, "post"),
    );
    startTurn({
      chatId: "chat",
      turnId,
      workspaceId,
      folder: root,
      agentId: null,
      summary: turnId,
      startedAt,
      preSnapshot,
    });
    finishTurn("chat", turnId, {
      endedAt: startedAt + 1,
      status: "completed",
      stopReason: "end_turn",
      postSnapshot,
      files: [{ path: name, status: "modified", additions: 1, deletions: 1 }],
    });
  };

  beforeEach(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "zeros-history-service-"));
    setStateRootForTesting(path.join(temp, "state"));
    root = path.join(temp, "repo");
    await mkdir(root);
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("remote", "add", "origin", "https://example.com/history.git");
    await write("a.txt", "original\n");
    await write("b.txt", "original\n");
    await commit("initial");
    upsertRepoByRoot({ repoRoot: root, repoSlug: "history" });
    service = new WorkspaceService(root);
    bridge = {
      request: async ({
        op,
        params,
      }: {
        op: string;
        params: Record<string, unknown>;
      }) => ({
        type: "WORKSPACE_RESPONSE",
        op,
        result: await service.handle(op, params),
      }),
    } as unknown as RuntimeClient;
  });
  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(temp, { recursive: true, force: true });
  });

  it("retains both rename paths when loading full context through the bridge", async () => {
    const before = `${Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    await write("old[x].txt", before);
    await write("oldx.txt", "unrelated old path\n");
    await commit("rename source");
    const workspace = await createWorkspace({ repoRoot: root });
    root = workspace.path;
    await git("mv", "old[x].txt", "new[x].txt");
    await write("new[x].txt", before.replace("line 40\n", "changed\n"));
    await write("oldx.txt", "unrelated change\n");
    await git("add", ".");
    const options = {
      workspaceId: workspace.workspaceId,
      filePath: "new[x].txt",
      oldFilePath: "old[x].txt",
      rawPatch: true,
      fullContext: true,
    };
    for (const mode of [
      "worktree-vs-base",
      "worktree-vs-head",
      "index-vs-head",
    ] as const) {
      const result = await bridgeGitDiff(bridge, { ...options, mode });
      expect(result.patch).toContain("rename from old[x].txt");
      expect(result.patch).toContain("rename to new[x].txt");
      expect(result.patch).toContain(" line 80");
      expect(result.patch).not.toContain("unrelated");
    }
    const sha = await commit("rename and modify");
    const historical = await bridgeGitDiff(bridge, {
      ...options,
      history: { kind: "commit-range", from: sha, to: sha },
    });
    expect(historical.patch).toContain("rename from old[x].txt");
    expect(historical.patch).toContain(" line 80");
    expect(historical.patch).not.toContain("unrelated");
    await expect(
      service.handle(
        "git.diff",
        {
          ...options,
          oldFilePath: ".env",
          history: { kind: "commit-range", from: sha, to: sha },
        },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("shows primary-checkout turns by path or local-main without mixing repositories", async () => {
    await record("first", 1, "a.txt", "first turn\n");
    await record("second", 2, "b.txt", "second turn\n");
    // Another engine's primary checkout shares the legacy local-main id in
    // the unified DB. Its newer row must not become this repository's latest.
    startTurn({
      chatId: "other",
      turnId: "foreign",
      workspaceId: "local-main",
      folder: path.join(temp, "other"),
      agentId: null,
      summary: null,
      startedAt: 3,
      preSnapshot: null,
    });
    finishTurn("other", "foreign", {
      endedAt: 4,
      status: "completed",
      stopReason: null,
      postSnapshot: null,
      files: [
        { path: "foreign.txt", status: "added", additions: 1, deletions: 0 },
      ],
    });
    await write("b.txt", "later manual edit\n");
    for (const workspaceId of [root, "local-main"]) {
      expect(
        (await bridgeTurnsList(bridge, workspaceId)).map((turn) => turn.turnId),
      ).toEqual(["second", "first"]);
      const options = { workspaceId, rawPatch: true, summaryLimit: 1000 };
      const latest = await bridgeGitDiff(bridge, {
        ...options,
        history: { kind: "last-turn" },
      });
      expect(latest.patch).toContain("+second turn");
      expect(latest.patch).not.toContain("first turn");
      expect(latest.patch).not.toContain("manual edit");
      const all = await bridgeGitDiff(bridge, {
        ...options,
        history: { kind: "turns" },
      });
      expect(all.patch).toContain("+first turn");
      expect(all.patch).toContain("+second turn");
      expect(
        (
          await bridgeGitDiff(bridge, {
            ...options,
            history: {
              kind: "turn-range",
              from: { chatId: "chat", turnId: "first" },
              to: { chatId: "chat", turnId: "second" },
            },
          })
        ).patch,
      ).toBe(all.patch);
    }
  });

  it("routes every working and committed comparison independently", async () => {
    const workspace = await createWorkspace({ repoRoot: root });
    root = workspace.path;
    const workspaceId = workspace.workspaceId;
    await record("first", 1, "a.txt", "first turn\n", workspaceId);
    const from = await commit("first");
    await record("second", 2, "b.txt", "second turn\n", workspaceId);
    const to = await commit("second");
    await write("a.txt", "staged\n");
    await git("add", "a.txt");
    await write("a.txt", "working\n");
    const options = { workspaceId, rawPatch: true };
    expect(
      (
        await bridgeGitDiff(bridge, {
          ...options,
          history: { kind: "last-turn" },
        })
      ).patch,
    ).toContain("+second turn");
    const commits = await bridgeGitDiff(bridge, {
      ...options,
      history: { kind: "commits" },
    });
    expect(commits.patch).toContain("+first turn");
    expect(commits.patch).toContain("+second turn");
    expect(commits.patch).not.toContain("working");
    expect(
      (
        await bridgeGitDiff(bridge, {
          ...options,
          history: { kind: "commit-range", from, to },
        })
      ).patch,
    ).toBe(commits.patch);
    const single = await bridgeGitDiff(bridge, {
      ...options,
      history: { kind: "commit-range", from, to: from },
    });
    expect(single.patch).toContain("+first turn");
    expect(single.patch).not.toContain("second turn");
    expect(
      (await bridgeGitLog(bridge, { workspaceId, base: "main" })).map(
        (c) => c.sha,
      ),
    ).toEqual([to, from]);
    const branch = await bridgeGitDiff(bridge, {
      ...options,
      mode: "worktree-vs-base",
    });
    expect(branch.patch).toContain("+working");
    expect(branch.patch).toContain("+second turn");
    const uncommitted = await bridgeGitDiff(bridge, {
      ...options,
      mode: "worktree-vs-head",
    });
    expect(uncommitted.patch).toContain("-first turn");
    expect(uncommitted.patch).toContain("+working");
    const staged = await bridgeGitDiff(bridge, {
      ...options,
      mode: "index-vs-head",
    });
    expect(staged.patch).toContain("-first turn");
    expect(staged.patch).toContain("+staged");
    const unstaged = await bridgeGitDiff(bridge, {
      ...options,
      mode: "worktree-vs-index",
    });
    expect(unstaged.patch).toContain("-staged");
    expect(unstaged.patch).toContain("+working");
    expect(await bridgeGitChangeCounts(bridge, workspaceId)).toEqual({
      all: 2,
      uncommitted: 1,
      staged: 1,
      unstaged: 1,
    });
  });

  it("counts staged renames from the staged comparison even when status disables rename detection", async () => {
    await git("config", "status.renames", "false");
    await git("config", "diff.renames", "true");
    await git("mv", "a.txt", "renamed.txt");
    const staged = await bridgeGitDiff(bridge, {
      workspaceId: root,
      mode: "index-vs-head",
      rawPatch: true,
    });
    expect(staged.patch).toContain("rename from a.txt");
    expect((await bridgeGitChangeCounts(bridge, root)).staged).toBe(1);
  });
});
