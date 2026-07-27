// Roadmap 03a follow-up C: background-rename hook.
//
// Two suites:
//   1. `deriveBranchNameFromPrompt` — pure function, covers the
//      heuristic's edge cases (stop words / length caps / empty
//      prompts / valid-name validation).
//   2. `proposeBranchRename` — integration against a real workspace,
//      covers idempotence + on-disk rename + workspace_meta marking.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  closeState,
  createWorkspace,
  deriveBranchNameFromPrompt,
  getWorkspace,
  proposeBranchRename,
  setStateRootForTesting,
} from "..";

const execFileAsync = promisify(execFile);

describe("deriveBranchNameFromPrompt", () => {
  it("turns a verbose prompt into a tight slug", () => {
    expect(deriveBranchNameFromPrompt("Add canvas zoom support")).toBe(
      "add-canvas-zoom-support",
    );
  });

  it("drops stop words", () => {
    expect(
      deriveBranchNameFromPrompt("Please add the canvas zoom feature"),
    ).toBe("add-canvas-zoom-feature");
  });

  it("preserves verbs", () => {
    expect(deriveBranchNameFromPrompt("Fix the auth bug in login flow")).toBe(
      "fix-auth-bug-login-flow",
    );
  });

  it("caps at 5 significant words", () => {
    const long = "Implement the new login modal with dark mode and animated transitions";
    const result = deriveBranchNameFromPrompt(long);
    expect(result).not.toBeNull();
    expect(result!.split("-").length).toBeLessThanOrEqual(5);
  });

  it("returns null when prompt is empty / whitespace", () => {
    expect(deriveBranchNameFromPrompt("")).toBeNull();
    expect(deriveBranchNameFromPrompt("   ")).toBeNull();
  });

  it("returns null when prompt is all stop words", () => {
    expect(deriveBranchNameFromPrompt("the and or but is")).toBeNull();
  });

  it("returns null when prompt has no alphanumerics", () => {
    expect(deriveBranchNameFromPrompt("?? !!! ...")).toBeNull();
  });

  it("returns null when derived name matches a reserved branch", () => {
    expect(deriveBranchNameFromPrompt("the main")).toBeNull();
  });

  it("hyphen-joins multi-token outputs", () => {
    expect(deriveBranchNameFromPrompt("add canvas mode")).toBe(
      "add-canvas-mode",
    );
  });

  it("hard-caps total length to fit the regex", () => {
    const veryLong = "supercalifragilisticexpialidociousjustaverylongwordwithloreipsumtext";
    const result = deriveBranchNameFromPrompt(veryLong);
    if (result !== null) {
      expect(result.length).toBeLessThanOrEqual(49);
    }
  });

  it("normalises uppercase + punctuation", () => {
    expect(deriveBranchNameFromPrompt("Add Canvas, Zoom & Pan!")).toBe(
      "add-canvas-zoom-pan",
    );
  });

  it("ignores 1-letter words", () => {
    expect(deriveBranchNameFromPrompt("a b add cd canvas")).toBe(
      "add-cd-canvas",
    );
  });
});

describe("proposeBranchRename (integration)", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;
  let workspaceId: string;
  let originalBranch: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-rename-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);

    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", [
      "remote",
      "add",
      "origin",
      "https://example.com/r/h.git",
    ], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# init\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    const created = await createWorkspace({ repoRoot });
    workspaceId = created.workspaceId;
    originalBranch = created.branch;
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

  it("renames the branch and marks workspace_meta on first call", async () => {
    const result = await proposeBranchRename({
      workspaceId,
      prompt: "Add canvas zoom support",
    });
    expect(result.renamed).toBe(true);
    expect(result.branch).toBe("zeros/add-canvas-zoom-support");
    // DB row reflects the new branch.
    const ws = getWorkspace(workspaceId);
    expect(ws.branch).toBe("zeros/add-canvas-zoom-support");
    // The ref store has the new name.
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      "zeros/add-canvas-zoom-support",
    ]);
    expect(stdout.includes("zeros/add-canvas-zoom-support")).toBe(true);
  });

  it("is idempotent — second call returns already-renamed", async () => {
    await proposeBranchRename({
      workspaceId,
      prompt: "Add canvas zoom",
    });
    const second = await proposeBranchRename({
      workspaceId,
      prompt: "Different prompt entirely",
    });
    expect(second.renamed).toBe(false);
    expect(second.reason).toBe("already-renamed");
    // Branch should still be the first-prompt-derived name.
    const ws = getWorkspace(workspaceId);
    expect(ws.branch).toBe("zeros/add-canvas-zoom");
  });

  it("force=true bypasses the idempotence guard", async () => {
    await proposeBranchRename({
      workspaceId,
      prompt: "first prompt name",
    });
    const second = await proposeBranchRename({
      workspaceId,
      prompt: "second different name",
      force: true,
    });
    expect(second.renamed).toBe(true);
    expect(second.branch).toBe("zeros/second-different-name");
  });

  it("returns no-keywords (no rename) when prompt yields no slug", async () => {
    const result = await proposeBranchRename({
      workspaceId,
      prompt: "?? !!! ...",
    });
    expect(result.renamed).toBe(false);
    expect(result.reason).toBe("no-keywords");
    expect(result.branch).toBe(originalBranch); // unchanged
  });

  it("returns no-keywords when prompt is all stop words", async () => {
    const result = await proposeBranchRename({
      workspaceId,
      prompt: "the and or but is",
    });
    expect(result.renamed).toBe(false);
    expect(result.reason).toBe("no-keywords");
  });

  it("throws WORKSPACE_NOT_FOUND for unknown workspace ids", async () => {
    await expect(
      proposeBranchRename({
        workspaceId: "ws_does_not_exist",
        prompt: "anything",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("no-ops when the derived name matches the existing slug", async () => {
    // First rename to "canvas-zoom".
    await proposeBranchRename({
      workspaceId,
      prompt: "canvas zoom",
    });
    // Now manually clear the marker so the idempotence path doesn't
    // skip us — we want to test the slug-matches-current branch.
    const { setWorkspaceMeta } = await import("../state");
    // Clear by setting to a future date — only force matters now.
    // Better: re-fetch and reset; but for the test, force=true is
    // the cleanest.
    const second = await proposeBranchRename({
      workspaceId,
      prompt: "canvas zoom",
      force: true,
    });
    // The derived name matches the *current* branch, so no rename
    // happens but it's reported as already-renamed.
    expect(second.renamed).toBe(false);
    expect(second.reason).toBe("already-renamed");
    expect(setWorkspaceMeta).toBeDefined();
  });
});
