// Focused test for the gateway's cwd resolution. Lives under
// src/engine/git/__tests__/ because vitest.config.ts is scoped there —
// the test imports the gateway helper directly.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createWorkspace,
  setStateRootForTesting,
} from "..";
import { resolveAgentCwd } from "../../agents/gateway";

const execFileAsync = promisify(execFile);

describe("gateway resolveAgentCwd", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-gw-cwd-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);

    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", [
      "remote",
      "add",
      "origin",
      "https://example.com/g/cwd.git",
    ], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# x\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
    workspacePath = created.path;
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("cwd wins when both cwd and workspaceId are supplied", () => {
    // repoRoot exists on disk; precedence (cwd over workspaceId) is
    // what's under test. A nonexistent explicit path is now rejected
    // by the existence guard (see the deleted-folder test below).
    const result = resolveAgentCwd(repoRoot, "newSession", workspaceId);
    expect(result).toBe(repoRoot);
  });

  it("resolves workspaceId to the workspace path when cwd is missing", () => {
    const result = resolveAgentCwd(undefined, "newSession", workspaceId);
    expect(result).toBe(workspacePath);
  });

  it("resolves workspaceId when cwd is an empty string", () => {
    const result = resolveAgentCwd("", "newSession", workspaceId);
    expect(result).toBe(workspacePath);
  });

  it("throws when neither cwd nor a valid workspaceId is given", () => {
    expect(() => resolveAgentCwd(undefined, "newSession")).toThrow();
  });

  it("throws when workspaceId is unknown and cwd is missing", () => {
    expect(() =>
      resolveAgentCwd(undefined, "newSession", "ws_does_not_exist"),
    ).toThrow();
  });

  it("cwd alone (no workspaceId) still works", () => {
    const result = resolveAgentCwd(repoRoot, "loadSession");
    expect(result).toBe(repoRoot);
  });

  it("throws when the supplied cwd no longer exists on disk", () => {
    // S2: a chat bound to a since-deleted worktree must fail loud with
    // a clear "folder no longer exists" error rather than spawning the
    // CLI in a nonexistent dir (which surfaced as a bogus "CLI not
    // installed" message downstream).
    const gone = path.join(workdir, "deleted-worktree");
    expect(() => resolveAgentCwd(gone, "newSession")).toThrow(
      /no longer exists/i,
    );
  });

  it("self-heals a stale cwd via the workspaceId when the workspace path still exists", () => {
    // The chat's folder is gone (e.g. the worktree was archived and RESTORED to
    // a different path), but the workspaceId still resolves to a live worktree.
    // Rather than failing, spawn there — this is what keeps a restored chat
    // working when its stored cwd is stale.
    const stale = path.join(workdir, "old-archived-path");
    const result = resolveAgentCwd(stale, "loadSession", workspaceId);
    expect(result).toBe(workspacePath);
  });
});
