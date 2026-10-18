import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Workspace } from "../types";

const fixture = vi.hoisted(() => ({ workspaces: new Map<string, Workspace>() }));
vi.mock("../worktree", () => ({ resolveRepoForGitOp: async (id: string) => fixture.workspaces.get(id)! }));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));

import { changeCounts, changeLineCounts, diff, hasWorkspaceChanges, log, stampChangeState, status } from "../diff";
import { engineGitBinary } from "../git-exec";

const exec = promisify(execFile);
let directory: string;
let spawnLog: string;
let realGit: string;

async function createFixture(id: string): Promise<Workspace> {
  const root = path.join(directory, id);
  await mkdir(root);
  const git = (args: string[]) => exec(realGit, args, { cwd: root });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "fixture@example.com"]);
  await git(["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "tracked.txt"), "initial\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "initial"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(["checkout", "-qb", "feature"]);
  await writeFile(path.join(root, "tracked.txt"), "committed\n");
  await git(["commit", "-qam", "feature"]);
  await writeFile(path.join(root, "tracked.txt"), "working\n");
  const workspace: Workspace = {
    id, repoRoot: root, repoSlug: id, path: root, branch: "feature", baseBranch: "main", createdAt: 1,
    archivedAt: null, stashRef: null, status: "in-progress", prNumber: null, prState: null,
    prUrl: null, agentId: null, lastActiveAt: null, placement: "local", organizationId: null,
  };
  fixture.workspaces.set(id, workspace);
  return workspace;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "zeros-change-snapshot-test-"));
  realGit = engineGitBinary();
  spawnLog = path.join(directory, "git-spawns");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"),
    '#!/bin/sh\nprintf "%s\\t%s\\n" "${GIT_OPTIONAL_LOCKS:-unset}" "$*" >> "$ZEROS_TEST_GIT_SPAWNS"\nexec "$ZEROS_TEST_GIT_BINARY" "$@"\n', { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("ZEROS_TEST_GIT_SPAWNS", spawnLog);
  vi.stubEnv("ZEROS_TEST_GIT_BINARY", realGit);
  await writeFile(spawnLog, "");
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fixture.workspaces.clear();
  await rm(directory, { recursive: true, force: true });
});

async function spawns(): Promise<string[]> {
  return (await readFile(spawnLog, "utf8")).split("\n").filter(Boolean);
}

describe("Local change snapshot process budget", () => {
  it("shares exact comparisons across one four-workspace refresh", async () => {
    const workspaces = await Promise.all(Array.from({ length: 4 }, (_, index) => createFixture(`workspace-${index}`)));
    const startedAt = performance.now();
    const results = await Promise.all(workspaces.map(async (workspace) => Promise.all([
      hasWorkspaceChanges(workspace.id), changeCounts(workspace.id), changeLineCounts(workspace.id), status(workspace.id),
      stampChangeState([workspace]),
    ])));
    const calls = await spawns();
    console.info(JSON.stringify({ scenario: "four-workspace-refresh", gitSpawns: calls.length, elapsedMs: Math.round(performance.now() - startedAt) }));
    for (const [hasChanges, counts, lines, state, stamped] of results) {
      expect(hasChanges).toBe(true);
      expect(counts).toEqual({ all: 1, uncommitted: 1, staged: 0, unstaged: 1 });
      expect(lines).toEqual({ additions: 1, deletions: 1 });
      expect(state.unstaged).toEqual([{ path: "tracked.txt", status: "modified" }]);
      expect(stamped[0]?.hasChanges).toBe(true);
    }
    // Four comparisons, one porcelain+tracking read, three fork-point probes,
    // and one cold policy read per workspace. Later refreshes can reuse graph state.
    expect(calls.length).toBeLessThanOrEqual(36);
  });

  it("keeps every observation from refreshing the index", async () => {
    const workspace = await createFixture("workspace");
    await Promise.all([changeCounts(workspace.id), changeLineCounts(workspace.id), status(workspace.id)]);
    const calls = await spawns();
    expect(calls.filter((call) => !call.includes("\tconfig ") && !call.includes(" config ")).every((call) => call.startsWith("0\t"))).toBe(true);
  });

  it("reuses unchanged graph state while immediately observing a worktree edit", async () => {
    const workspace = await createFixture("workspace");
    await changeLineCounts(workspace.id);
    await writeFile(spawnLog, "");
    await writeFile(path.join(workspace.path, "tracked.txt"), "next\nedit\n");
    const startedAt = performance.now();
    expect(await changeLineCounts(workspace.id)).toEqual({ additions: 2, deletions: 1 });
    const calls = await spawns();
    console.info(JSON.stringify({ scenario: "warm-graph-worktree-edit", gitSpawns: calls.length, elapsedMs: Math.round(performance.now() - startedAt) }));
    expect(calls).toHaveLength(2);

    // A ref move must re-read the graph even without a watcher notification.
    await exec(realGit, ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: workspace.path });
    await writeFile(spawnLog, "");
    await changeLineCounts(workspace.id);
    expect((await spawns()).some((call) => call.includes(" merge-base "))).toBe(true);
  });

  it("shares a fingerprinted graph between patch and branch-log reads", async () => {
    const workspace = await createFixture("workspace");
    await diff({ workspaceId: workspace.id, mode: "worktree-vs-base", rawPatch: true });
    await writeFile(spawnLog, "");
    const [patch, commits] = await Promise.all([
      diff({ workspaceId: workspace.id, mode: "worktree-vs-base", rawPatch: true }),
      log({ workspaceId: workspace.id, base: "main" }),
    ]);
    expect(patch.patch).toContain("+working");
    expect(commits).toHaveLength(1);
    expect(await spawns()).toHaveLength(2);
  });

  it.each(["idle-minute", "agent-turn"])("bounds process launches for a simulated %s", async (scenario) => {
    const workspaces = await Promise.all(Array.from({ length: 4 }, (_, index) => createFixture(`workspace-${index}`)));
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = Date.now();
    const startedAt = performance.now();
    const generations = scenario === "idle-minute" ? 12 : 10;
    for (let generation = 0; generation < generations; generation += 1) {
      vi.setSystemTime(clock + generation * (scenario === "idle-minute" ? 5_000 : 1_000));
      if (scenario === "agent-turn") {
        await writeFile(path.join(workspaces[generation % 2]!.path, "tracked.txt"), `generation ${generation}\n`);
      }
      await Promise.all(workspaces.map((workspace) => Promise.all([
        hasWorkspaceChanges(workspace.id), changeCounts(workspace.id), changeLineCounts(workspace.id), status(workspace.id),
      ])));
    }
    const calls = await spawns();
    console.info(JSON.stringify({ scenario, workspaces: 4, generations, gitSpawns: calls.length, elapsedMs: Math.round(performance.now() - startedAt) }));
    expect(calls.length).toBeLessThanOrEqual(scenario === "idle-minute" ? 300 : 220);
  });
});
