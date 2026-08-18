import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getWorkingDirectories,
  setWorkingDirectories,
} from "../sparse-checkout";
import { listWorkspaceFiles } from "../workspace-files";

const execFileAsync = promisify(execFile);

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

describe("working directories (sparse-checkout)", () => {
  let workdir: string;
  let repo: string;

  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync("git", args, { cwd: repo });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-sparse-test-"));
    repo = path.join(workdir, "repo");
    await mkdir(path.join(repo, "keep"), { recursive: true });
    await mkdir(path.join(repo, "drop"), { recursive: true });
    await mkdir(path.join(repo, "nested", "deep"), { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(repo, "keep", "a.txt"), "a\n");
    await writeFile(path.join(repo, "drop", "b.txt"), "b\n");
    await writeFile(path.join(repo, "nested", "deep", "d.txt"), "d\n");
    await writeFile(path.join(repo, "root.txt"), "r\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("lists top-level tracked dirs and reports non-sparse by default", async () => {
    const state = await getWorkingDirectories(repo);
    expect(state.supported).toBe(true);
    expect(state.sparse).toBe(false);
    expect(state.all).toEqual(["drop", "keep", "nested"]);
    // Not sparse ⇒ everything is included.
    expect(state.included).toEqual(state.all);
  });

  it("removes a deselected directory from disk and restores it on reselect", async () => {
    const applied = await setWorkingDirectories(repo, ["keep"]);
    expect(applied.sparse).toBe(true);
    expect(applied.included).toEqual(["keep"]);
    expect(applied.leftBehind).toEqual([]);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(false);
    expect(await exists(path.join(repo, "nested"))).toBe(false);
    // Root files are always materialized — cone mode cannot exclude them.
    expect(await exists(path.join(repo, "root.txt"))).toBe(true);

    const restored = await setWorkingDirectories(repo, [
      "keep",
      "drop",
      "nested",
    ]);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
    // Selecting everything returns the worktree to plain, non-sparse git.
    expect(restored.sparse).toBe(false);
  });

  it("never lets a Design root leave the checkout, whatever the caller asks", async () => {
    // Hiding Design territory takes the canvas off disk: Design mode would
    // open onto nothing, and the on-disk marker every code-side write guard
    // recognizes would go with it.
    const designRoots = ["drop"];
    const listed = await getWorkingDirectories(repo, { designRoots });
    expect(listed.locked).toEqual(["drop"]);

    // Deselecting it explicitly — a stale renderer, an older client, or a
    // direct op — is corrected by the engine rather than honoured.
    const applied = await setWorkingDirectories(repo, ["keep"], {
      designRoots,
    });
    expect(applied.locked).toEqual(["drop"]);
    expect(applied.included).toEqual(["drop", "keep"]);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
    expect(await exists(path.join(repo, "nested"))).toBe(false);

    // "Deselect all" keeps it too, and cannot strip the worktree bare.
    const emptied = await setWorkingDirectories(repo, [], { designRoots });
    expect(emptied.included).toEqual(["drop"]);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
  });

  it("locks the TOP-LEVEL segment of a nested Design folder", async () => {
    // Excluding `nested` would take `nested/deep` with it, so the ancestor is
    // what has to be locked.
    const designRoots = ["nested/deep"];
    const state = await getWorkingDirectories(repo, { designRoots });
    expect(state.locked).toEqual(["nested"]);
    const applied = await setWorkingDirectories(repo, ["keep"], {
      designRoots,
    });
    expect(applied.included).toEqual(["keep", "nested"]);
    expect(await exists(path.join(repo, "nested", "deep", "d.txt"))).toBe(true);
  });

  it("locks nothing when no Design root is a tracked top-level candidate", async () => {
    // A Design pointer naming a folder this feature cannot reach needs no
    // protection here, and must not invent a phantom row.
    const state = await getWorkingDirectories(repo, {
      designRoots: ["Zeros Design"],
    });
    expect(state.locked).toEqual([]);
    const applied = await setWorkingDirectories(repo, ["keep"], {
      designRoots: ["Zeros Design"],
    });
    expect(applied.included).toEqual(["keep"]);
  });

  it("can preserve a sparse cone when every tracked directory is selected", async () => {
    const applied = await setWorkingDirectories(
      repo,
      ["drop", "keep", "nested"],
      { forceSparse: true },
    );

    expect(applied.sparse).toBe(true);
    expect(applied.included).toEqual(["drop", "keep", "nested"]);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
    expect(await exists(path.join(repo, "keep", "a.txt"))).toBe(true);
  });

  it("hides excluded files from the Files tab listing", async () => {
    // Regression: excluded paths keep their index rows (with skip-worktree),
    // so `ls-files -c` still reports them. Without the skip-worktree filter
    // the tree shows rows for files that are not on disk.
    await setWorkingDirectories(repo, ["keep"]);
    const files = await listWorkspaceFiles(repo);
    expect(files).toContain("keep/a.txt");
    expect(files).toContain("root.txt");
    expect(files).not.toContain("drop/b.txt");
    expect(files).not.toContain("nested/deep/d.txt");
  });

  it("keeps a dirty file on disk and reports it as left behind", async () => {
    await writeFile(path.join(repo, "drop", "b.txt"), "LOCAL EDIT\n");
    const applied = await setWorkingDirectories(repo, ["keep"]);
    // git refuses to delete uncommitted work — no data loss.
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
    expect(applied.leftBehind).toContain("drop/b.txt");
    // It is still really on disk, so it must still be listed.
    expect(await listWorkspaceFiles(repo)).toContain("drop/b.txt");
  });

  it("leaves untracked files inside an excluded directory alone", async () => {
    await writeFile(path.join(repo, "drop", "untracked.txt"), "u\n");
    const applied = await setWorkingDirectories(repo, ["keep"]);
    expect(applied.leftBehind).toEqual([]);
    expect(await exists(path.join(repo, "drop", "untracked.txt"))).toBe(true);
    expect(await listWorkspaceFiles(repo)).toContain("drop/untracked.txt");
  });

  it("supports selecting nothing (root files only)", async () => {
    const applied = await setWorkingDirectories(repo, []);
    expect(applied.included).toEqual([]);
    expect(applied.sparse).toBe(true);
    expect(await exists(path.join(repo, "keep"))).toBe(false);
    expect(await exists(path.join(repo, "root.txt"))).toBe(true);
  });

  it("applies every selected directory, not just the first", async () => {
    // Regression: a NUL-delimited `--stdin` payload is silently parsed by git
    // as one entry, which would drop every directory after the first.
    const applied = await setWorkingDirectories(repo, ["keep", "drop"]);
    expect(applied.included).toEqual(["drop", "keep"]);
    expect(await exists(path.join(repo, "keep", "a.txt"))).toBe(true);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
    expect(await exists(path.join(repo, "nested"))).toBe(false);
  });

  it("includes dotted directories such as .github", async () => {
    // Regression: the name guard rejected the whole `.git*` PREFIX, so
    // `.github` never reached the candidate list. It was therefore missing
    // from every cone written, git deleted it on the first save, and with no
    // checkbox for it there was no way back short of the git CLI.
    await mkdir(path.join(repo, ".github", "workflows"), { recursive: true });
    await writeFile(
      path.join(repo, ".github", "workflows", "ci.yml"),
      "on: []\n",
    );
    await git("add", "-A");
    await git("commit", "-q", "-m", "add .github");

    const state = await getWorkingDirectories(repo);
    expect(state.all).toContain(".github");

    // Excluding something else must leave .github on disk.
    await setWorkingDirectories(repo, [".github", "keep"]);
    expect(
      await exists(path.join(repo, ".github", "workflows", "ci.yml")),
    ).toBe(true);
    expect(await exists(path.join(repo, "drop"))).toBe(false);
  });

  it("includes directories whose names git C-quotes", async () => {
    // Regression: `ls-tree --format=%(path)` C-QUOTES a name needing escapes —
    // and `-z` does NOT suppress that, unlike `--name-only`. `café` arrived as
    // `"caf\303\251"` and `back\slash` as `"back\\slash"`, neither of which
    // matches disk or `sparse-checkout list`, so the folder never reached the
    // candidate list, was absent from every cone written, and git deleted it on
    // the first save with no checkbox left to restore it — the `.github` bug in
    // a different disguise.
    for (const odd of ["café", "back\\slash", "-dash", "sp ace"]) {
      await mkdir(path.join(repo, odd), { recursive: true });
      await writeFile(path.join(repo, odd, "f.txt"), "x\n");
    }
    await git("add", "-A");
    await git("commit", "-q", "-m", "odd names");

    const state = await getWorkingDirectories(repo);
    expect(state.all).toEqual(
      expect.arrayContaining(["café", "back\\slash", "-dash", "sp ace"]),
    );

    // They must round-trip through a save: selected ⇒ still on disk, and
    // reported back as included (the cone is read via `sparse-checkout list`,
    // which quotes them differently again).
    const applied = await setWorkingDirectories(repo, [
      "café",
      "back\\slash",
      "-dash",
      "sp ace",
      "keep",
    ]);
    expect(applied.included).toEqual(
      expect.arrayContaining(["café", "back\\slash", "-dash", "sp ace"]),
    );
    for (const odd of ["café", "back\\slash", "-dash", "sp ace"]) {
      expect(await exists(path.join(repo, odd, "f.txt"))).toBe(true);
    }
    expect(await exists(path.join(repo, "drop"))).toBe(false);
  });

  it("declines the feature rather than deleting an unrepresentable folder", async () => {
    // A newline in a directory name cannot be written as a `--stdin` cone entry
    // (it would split one pattern into two). Dropping it from the candidate list
    // would delete it on the first save with no way back, so the whole worktree
    // is declared unsupported instead and left untouched.
    const odd = "line\nbreak";
    await mkdir(path.join(repo, odd), { recursive: true });
    await writeFile(path.join(repo, odd, "f.txt"), "x\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "newline name");

    const state = await getWorkingDirectories(repo);
    expect(state.supported).toBe(false);
    await expect(setWorkingDirectories(repo, ["keep"])).rejects.toThrow();
    // Untouched: nothing was excluded, so every folder is still on disk.
    expect(await exists(path.join(repo, odd, "f.txt"))).toBe(true);
    expect(await exists(path.join(repo, "drop", "b.txt"))).toBe(true);
  });

  it("does not strip and recreate the folders it keeps", async () => {
    // Regression: a separate `sparse-checkout init --cone` ran first, and that
    // applies a root-files-only cone of its own — deleting EVERY top-level
    // folder, including the ones staying selected, before `set` re-materialized
    // them. Same inode after the save proves the kept file was never unlinked.
    const kept = path.join(repo, "keep", "a.txt");
    const before = await stat(kept);
    const applied = await setWorkingDirectories(repo, ["keep"]);
    expect(applied.included).toEqual(["keep"]);
    const after = await stat(kept);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await exists(path.join(repo, "drop"))).toBe(false);
  });

  it("treats a non-cone sparse worktree as unsupported", async () => {
    // Non-cone patterns are hand-written gitignore-style rules that do not map
    // to directory names. Reading them as a folder list would render every
    // folder unchecked, and saving would overwrite the user's patterns.
    // `init` alone defaults to cone mode on modern git — non-cone is an
    // explicit opt-in, which is exactly the hand-rolled setup we must not touch.
    await git("sparse-checkout", "init", "--no-cone");
    const state = await getWorkingDirectories(repo);
    expect(state.sparse).toBe(true);
    expect(state.supported).toBe(false);
    await expect(setWorkingDirectories(repo, ["keep"])).rejects.toThrow();
  });

  it("rejects a directory that is not a top-level tracked dir", async () => {
    await expect(
      setWorkingDirectories(repo, ["keep", "../escape"]),
    ).rejects.toThrow(/not a top-level tracked directory/i);
    await expect(setWorkingDirectories(repo, ["nope"])).rejects.toThrow(
      /not a top-level tracked directory/i,
    );
    // A rejected call must not have changed anything.
    expect((await getWorkingDirectories(repo)).sparse).toBe(false);
  });

  it("reports unsupported for a repo with no commits", async () => {
    const fresh = path.join(workdir, "fresh");
    await mkdir(fresh, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
    const state = await getWorkingDirectories(fresh);
    expect(state.supported).toBe(false);
    expect(state.all).toEqual([]);
    await expect(setWorkingDirectories(fresh, [])).rejects.toThrow(
      /at least one commit/i,
    );
  });

  it("reports unsupported outside a git repo", async () => {
    const plain = path.join(workdir, "plain");
    await mkdir(plain, { recursive: true });
    expect((await getWorkingDirectories(plain)).supported).toBe(false);
    expect((await getWorkingDirectories("")).supported).toBe(false);
  });

  describe("names the actual obstacle", () => {
    // All three unsupported states used to surface one line — "Needs a git
    // repository with at least one commit" — which is false for two of them
    // and leaves the user with nothing to act on.
    it("distinguishes no-commits from non-cone from unrepresentable", async () => {
      const fresh = path.join(workdir, "fresh");
      await mkdir(fresh, { recursive: true });
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
      expect((await getWorkingDirectories(fresh)).unsupportedReason).toBe(
        "no-commits",
      );
      expect(
        (await getWorkingDirectories(path.join(workdir, "nope")))
          .unsupportedReason,
      ).toBe("no-commits");

      const odd = path.join(workdir, "odd");
      await mkdir(path.join(odd, "line\nbreak"), { recursive: true });
      await writeFile(path.join(odd, "line\nbreak", "f.txt"), "x\n");
      await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: odd });
      for (const [k, v] of [
        ["user.email", "t@t"],
        ["user.name", "t"],
      ]) {
        await execFileAsync("git", ["config", k, v], { cwd: odd });
      }
      await execFileAsync("git", ["add", "-A"], { cwd: odd });
      await execFileAsync("git", ["commit", "-q", "-m", "x"], { cwd: odd });
      expect((await getWorkingDirectories(odd)).unsupportedReason).toBe(
        "unrepresentable-name",
      );

      await git("sparse-checkout", "init", "--no-cone");
      expect((await getWorkingDirectories(repo)).unsupportedReason).toBe(
        "non-cone",
      );
    });

    it("carries the same distinction into the rejection message", async () => {
      await git("sparse-checkout", "init", "--no-cone");
      // Not "needs at least one commit" — this repo has one.
      await expect(setWorkingDirectories(repo, ["keep"])).rejects.toThrow(
        /hand-written sparse-checkout patterns/i,
      );
    });

    it("omits the reason when the worktree IS supported", async () => {
      expect(
        (await getWorkingDirectories(repo)).unsupportedReason,
      ).toBeUndefined();
    });
  });

  it("scopes the cone to ONE worktree of a shared repo", async () => {
    // The feature is per-workspace, and workspaces are linked worktrees of one
    // repo. `git sparse-checkout` writes to `config.worktree` (turning on the
    // repo-wide `extensions.worktreeConfig`), so this asserts the promise the
    // UI makes: hiding a folder in one workspace must not touch a sibling's
    // checkout, and must not leave the sibling reporting phantom deletions.
    await git("branch", "sibling");
    const sibling = path.join(workdir, "sibling");
    await git("worktree", "add", "-q", sibling, "sibling");

    await setWorkingDirectories(repo, ["keep"]);
    expect(await exists(path.join(repo, "drop"))).toBe(false);

    expect(await exists(path.join(sibling, "drop", "b.txt"))).toBe(true);
    const siblingState = await getWorkingDirectories(sibling);
    expect(siblingState.sparse).toBe(false);
    expect(siblingState.included).toEqual(siblingState.all);
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: sibling },
    );
    expect(stdout).toBe("");
  });

  it("serializes concurrent saves on one worktree", async () => {
    // Each save is a read-modify-write across several git invocations: read the
    // candidate set, validate the selection against it, write a cone. Two
    // racing in one worktree each validate against a snapshot the other has
    // already invalidated, and both drive `sparse-checkout set` at the same
    // index — so a call could report back a cone the OTHER one wrote.
    const selections = [["keep"], ["drop"], ["keep", "drop"], ["nested"], []];
    const results = await Promise.all(
      selections.map((sel) => setWorkingDirectories(repo, sel)),
    );
    // Every call reports exactly what IT applied, not what a neighbour did.
    results.forEach((result, i) => {
      expect(result.included.sort()).toEqual([...selections[i]].sort());
    });
    // Last writer wins, and the worktree matches it.
    const final = await getWorkingDirectories(repo);
    expect(final.included).toEqual([]);
    expect(await exists(path.join(repo, "keep"))).toBe(false);
    expect(await exists(path.join(repo, "root.txt"))).toBe(true);
  });
});
