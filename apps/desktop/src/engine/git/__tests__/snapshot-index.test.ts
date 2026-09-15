import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as gitCommands from "../git-exec";
import { snapshotWorkingTree } from "../turns-git";

const exec = promisify(execFile);

describe("snapshot index reuse", () => {
  let root: string;
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root })).stdout;
  const capture = (name: string, forceAddPaths?: string[]) =>
    snapshotWorkingTree(root, `refs/zeros/test/${name}`, { forceAddPaths });
  const contents = (commit: string | null, file: string) => {
    expect(commit).toMatch(/^[0-9a-f]{40,64}$/);
    return git("show", `${commit}:${file}`);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-snapshot-index-"));
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.test");
    await writeFile(path.join(root, "kept.txt"), "committed\n");
    await writeFile(path.join(root, "removed.txt"), "keep until deleted\n");
    await git("add", ".");
    await git("commit", "-qm", "seed");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("retains validated file metadata so a warm snapshot does not reread unchanged tracked contents", async () => {
    expect(await capture("first")).toBeTruthy();
    const runGit = gitCommands.runGit;
    let cachedSize: number | undefined;
    vi.spyOn(gitCommands, "runGit").mockImplementation(
      async (cwd, args, opts) => {
        if (args[0] === "add" && args[1] === "-A") {
          const debug = await runGit(
            cwd,
            ["ls-files", "--debug", "--", "kept.txt"],
            opts,
          );
          cachedSize = Number(/size: (\d+)/.exec(debug.stdout)?.[1]);
        }
        return runGit(cwd, args, opts);
      },
    );
    expect(await capture("warm")).toBeTruthy();
    // read-tree HEAD into a new index sets every stat field to zero and makes
    // git add read/hash the whole checkout. Assert actual Git metadata, not a
    // wall-clock threshold that varies with CI load.
    expect(cachedSize).toBe(Buffer.byteLength("committed\n"));
  });

  it("captures fresh edits, deletion, rename, and untracked files without touching staging", async () => {
    await capture("before");
    await writeFile(path.join(root, "kept.txt"), "staged\n");
    await git("add", "kept.txt");
    await writeFile(path.join(root, "kept.txt"), "latest on disk\n");
    await rm(path.join(root, "removed.txt"));
    await writeFile(path.join(root, "renamed.txt"), "keep until deleted\n");
    await writeFile(path.join(root, "untracked.txt"), "new\n");
    const beforeIndex = await readFile(path.join(root, ".git/index"));
    const snapshot = await capture("after");
    expect(await contents(snapshot, "kept.txt")).toBe("latest on disk\n");
    expect(await contents(snapshot, "renamed.txt")).toBe(
      "keep until deleted\n",
    );
    expect(await contents(snapshot, "untracked.txt")).toBe("new\n");
    expect(await git("ls-tree", "--name-only", snapshot!)).not.toContain(
      "removed.txt",
    );
    expect(await readFile(path.join(root, ".git/index"))).toEqual(beforeIndex);
  });

  it("reuses unchanged untracked and forced files under the same inclusion rules", async () => {
    await mkdir(path.join(root, "drafts"));
    await writeFile(path.join(root, "drafts/new.txt"), "untracked draft\n");
    await writeFile(path.join(root, ".private"), "private fixture\n");
    await writeFile(path.join(root, ".gitignore"), ".private\n");
    await capture("before", [".private"]);
    const runGit = gitCommands.runGit;
    let cachedSize: number | undefined;
    vi.spyOn(gitCommands, "runGit").mockImplementation(
      async (cwd, args, opts) => {
        if (args[0] === "add" && args[1] === "-A") {
          const debug = await runGit(
            cwd,
            ["ls-files", "--debug", "--", "drafts/new.txt"],
            opts,
          );
          cachedSize = Number(/size: (\d+)/.exec(debug.stdout)?.[1]);
        }
        return runGit(cwd, args, opts);
      },
    );
    const snapshot = await capture("after", [".private"]);
    expect(await contents(snapshot, ".private")).toBe("private fixture\n");
    expect(cachedSize).toBe(Buffer.byteLength("untracked draft\n"));
    vi.restoreAllMocks();
    // This directory was untracked in the real index. Its new ignore rule
    // must invalidate the cached snapshot's formerly untracked entry.
    await writeFile(path.join(root, "drafts/.gitignore"), "new.txt\n");
    const ignored = await capture("ignored", [".private"]);
    expect(await git("ls-tree", "-r", "--name-only", ignored!)).not.toContain(
      "drafts/new.txt",
    );
  });

  it("rechecks same-size rewrites with restored modification time", async () => {
    const file = await open(path.join(root, "kept.txt"), "r+");
    try {
      const previous = await file.stat();
      await capture("before");
      await file.writeFile("rewritten\n");
      await file.utimes(previous.atime, previous.mtime);
    } finally {
      await file.close();
    }
    expect(await contents(await capture("after"), "kept.txt")).toBe(
      "rewritten\n",
    );
  });

  it("reuses a turn checkpoint when archive adds private files and exclusions", async () => {
    await writeFile(path.join(root, "kept.txt"), "uncommitted work\n");
    await writeFile(path.join(root, ".gitignore"), ".private\n");
    await writeFile(path.join(root, ".private"), "archive companion\n");
    await capture("turn");
    const runGit = gitCommands.runGit;
    let cachedSize: number | undefined;
    vi.spyOn(gitCommands, "runGit").mockImplementation(
      async (cwd, args, opts) => {
        if (args[0] === "add" && args[1] === "-A") {
          const debug = await runGit(
            cwd,
            ["ls-files", "--debug", "--", "kept.txt"],
            opts,
          );
          cachedSize = Number(/size: (\d+)/.exec(debug.stdout)?.[1]);
        }
        return runGit(cwd, args, opts);
      },
    );
    const snapshot = await snapshotWorkingTree(
      root,
      "refs/zeros/test/archive",
      {
        forceAddPaths: [".private"],
        excludePaths: ["settings.local.toml"],
      },
    );
    expect(await contents(snapshot, ".private")).toBe("archive companion\n");
    expect(await contents(snapshot, "kept.txt")).toBe("uncommitted work\n");
    expect(cachedSize).toBe(Buffer.byteLength("uncommitted work\n"));
  });

  it("does not keep previously included files after ignore or force-add rules change", async () => {
    await writeFile(path.join(root, "extra.txt"), "ordinary untracked\n");
    await writeFile(path.join(root, ".private"), "private fixture\n");
    await writeFile(path.join(root, ".gitignore"), ".private\n");
    await capture("before", [".private"]);
    await writeFile(path.join(root, ".gitignore"), ".private\nextra.txt\n");
    const snapshot = await capture("after");
    const files = await git("ls-tree", "--name-only", snapshot!);
    expect(files).not.toContain("extra.txt");
    expect(files).not.toContain(".private");
    await writeFile(path.join(root, ".private"), "updated private fixture\n");
    expect(
      await contents(await capture("forced", [".private"]), ".private"),
    ).toBe("updated private fixture\n");
  });

  it("invalidates cached normalization when attributes change, including ignored attributes", async () => {
    await writeFile(path.join(root, "line.txt"), "one\r\ntwo\r\n");
    await git("add", "line.txt");
    await git("commit", "-qm", "raw line endings");
    await writeFile(path.join(root, ".gitignore"), ".gitattributes\n");
    expect(await contents(await capture("before"), "line.txt")).toBe(
      "one\r\ntwo\r\n",
    );
    await writeFile(path.join(root, ".gitattributes"), "*.txt text eol=lf\n");
    expect(await contents(await capture("after"), "line.txt")).toBe(
      "one\ntwo\n",
    );
  });

  it("can expand a warm turn snapshot into a new ignored attachment scope with its own rules", async () => {
    await writeFile(path.join(root, ".gitignore"), ".private-scope/\n");
    await capture("turn");
    await mkdir(path.join(root, ".private-scope/nested"), { recursive: true });
    await writeFile(path.join(root, ".private-scope/nested/.gitignore"), "*\n");
    await writeFile(
      path.join(root, ".private-scope/nested/.gitattributes"),
      "*.txt text eol=lf\n",
    );
    await writeFile(
      path.join(root, ".private-scope/nested/document.txt"),
      "attachment\r\n",
    );
    const snapshot = await capture("archive", [".private-scope"]);
    expect(await contents(snapshot, ".private-scope/nested/document.txt")).toBe(
      "attachment\n",
    );
  });

  it("ignores user assume-unchanged hints and falls back after stat checking is disabled", async () => {
    await capture("before");
    await git("update-index", "--assume-unchanged", "kept.txt");
    await git("config", "core.trustctime", "false");
    await writeFile(path.join(root, "kept.txt"), "must survive\n");
    expect(await contents(await capture("after"), "kept.txt")).toBe(
      "must survive\n",
    );
  });

  it("rebuilds against a changed HEAD and preserves newly sparse-excluded files", async () => {
    await capture("before");
    await mkdir(path.join(root, "hidden"));
    await writeFile(path.join(root, "hidden/file.txt"), "sparse content\n");
    await git("add", ".");
    await git("commit", "-qm", "new branch content");
    await git("sparse-checkout", "set", "--cone", "--", "visible");
    const snapshot = await capture("after");
    expect(await contents(snapshot, "hidden/file.txt")).toBe(
      "sparse content\n",
    );
  });

  it("captures an ignored tracked file recreated after an earlier checkpoint recorded its deletion", async () => {
    await writeFile(path.join(root, ".gitignore"), "kept.txt\n");
    await git("add", ".gitignore");
    await git("commit", "-qm", "ignore tracked file");
    await rm(path.join(root, "kept.txt"));
    await capture("deleted");
    await writeFile(path.join(root, "kept.txt"), "recreated work\n");
    expect(await contents(await capture("recreated"), "kept.txt")).toBe(
      "recreated work\n",
    );
  });

  it("invalidates after HEAD changes and matches a fresh capture when attributes are missing", async () => {
    await writeFile(path.join(root, "line.txt"), "line\r\n");
    await git("add", "line.txt");
    await git("commit", "-qm", "raw line endings");
    await capture("before");
    await writeFile(path.join(root, ".gitattributes"), "*.txt text eol=lf\n");
    await git("add", ".gitattributes");
    await git("commit", "-qm", "new normalization");
    await rm(path.join(root, ".gitattributes"));
    // Compare with the original fresh-index algorithm. In particular Git may
    // remove the missing attribute file before normalizing the remaining paths.
    const env = { GIT_INDEX_FILE: path.join(root, ".git/baseline-index") };
    await gitCommands.runGit(root, ["read-tree", "HEAD"], { env });
    await gitCommands.runGit(root, ["add", "-A"], { env });
    const baseline = await gitCommands.runGit(root, ["write-tree"], { env });
    let reused = true;
    const snapshot = await snapshotWorkingTree(root, "refs/zeros/test/after", {
      onTiming: (timing) => {
        reused = timing.reusedIndex;
      },
    });
    expect(await contents(snapshot, "line.txt")).toBe(
      await git("show", `${baseline.stdout.trim()}:line.txt`),
    );
    expect(reused).toBe(false);
  });

  it("does not reuse an index when a bare boolean Git setting disables stat checks", async () => {
    const config = path.join(root, ".git/config");
    await writeFile(
      config,
      `${await readFile(config, "utf8")}\n[core]\n\tignorestat\n`,
    );
    await capture("before");
    let reused = true;
    await snapshotWorkingTree(root, "refs/zeros/test/after", {
      onTiming: (timing) => {
        reused = timing.reusedIndex;
      },
    });
    expect(reused).toBe(false);
  });

  it("rejects a cache whose ignore rules change during the final scan", async () => {
    await writeFile(path.join(root, "extra.txt"), "must not use stale rules\n");
    await capture("before");
    const runGit = gitCommands.runGit;
    vi.spyOn(gitCommands, "runGit").mockImplementation(
      async (cwd, args, opts) => {
        if (args[0] === "add" && args[1] === "-A") {
          await writeFile(path.join(root, ".gitignore"), "extra.txt\n");
        }
        return runGit(cwd, args, opts);
      },
    );
    expect(await capture("racing")).toBeNull();
    await expect(
      git("rev-parse", "--verify", "refs/zeros/test/racing"),
    ).rejects.toThrow();
    expect(await readFile(path.join(root, "extra.txt"), "utf8")).toBe(
      "must not use stale rules\n",
    );
  });

  it("rebuilds if a cached tree was pruned and retains the last published snapshot on failure", async () => {
    const first = await capture("first");
    const runGit = gitCommands.runGit;
    vi.spyOn(gitCommands, "runGit").mockImplementation(
      async (cwd, args, opts) => {
        if (
          args[0] === "read-tree" &&
          /^[0-9a-f]{40,64}$/.test(args.at(-1) ?? "")
        ) {
          throw new Error("cached object was pruned");
        }
        if (args[0] === "update-ref" && args[1] === "refs/zeros/test/failed") {
          throw new Error("publication failed");
        }
        return runGit(cwd, args, opts);
      },
    );
    expect(await contents(await capture("rebuilt"), "kept.txt")).toBe(
      "committed\n",
    );
    expect(await capture("failed")).toBeNull();
    expect((await git("rev-parse", "refs/zeros/test/first")).trim()).toBe(
      first,
    );
  });

  it("keeps overlapping captures and sibling worktrees independent", async () => {
    await capture("warm");
    const sibling = path.join(root, "sibling");
    await git("worktree", "add", "-qb", "sibling", sibling);
    await writeFile(path.join(sibling, "kept.txt"), "sibling only\n");
    const [a, b, c] = await Promise.all([
      capture("a"),
      capture("b"),
      snapshotWorkingTree(sibling, "refs/zeros/test/sibling"),
    ]);
    expect(await contents(a, "kept.txt")).toBe("committed\n");
    expect(await contents(b, "kept.txt")).toBe("committed\n");
    expect(await contents(c, "kept.txt")).toBe("sibling only\n");
  });
});
