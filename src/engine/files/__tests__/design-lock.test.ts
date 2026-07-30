import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canSkipPerFileRetry,
  denyAce,
  isInsideDir,
  lockableFiles,
  normalizeDesignDir,
  designLockSupported,
  lockCodebase,
  resolveDesignDirForLock,
  withUnlocked,
} from "../design-lock";
import { setWorkingDirectories } from "../../git/sparse-checkout";

const execFileAsync = promisify(execFile);

describe("denyAce", () => {
  it("names a principal before the deny clause", () => {
    // Regression: the ACE originally started at "deny …" with no principal.
    // chmod parses the first token as the identity, so every invocation failed
    // with "Unable to translate 'deny' to a UUID" and the lock silently did
    // nothing. Unit tests could not catch it (chmod +a is macOS-only), so this
    // asserts the shape instead.
    const ace = denyAce();
    expect(ace).toMatch(/^user:.+ deny /);
    expect(ace.startsWith("deny")).toBe(false);
    expect(ace).toContain("write,delete,append,writeattr,writeextattr");
  });
});

describe("canSkipPerFileRetry", () => {
  // Real macOS 26.3 stderr shapes.
  const noAcl =
    "chmod: No ACL present 'b.txt'\nchmod: No ACL present 'd.txt'\n";

  it("accepts a batch whose only errors are 'No ACL present'", () => {
    expect(canSkipPerFileRetry("-a", noAcl)).toBe(true);
  });

  it("forces a per-file retry when ANY other chmod error is present", () => {
    // The dangerous case: one real failure hidden among benign ones must not
    // let the whole batch be counted as unlocked.
    expect(
      canSkipPerFileRetry(
        "-a",
        `${noAcl}chmod: Operation not permitted 'x.txt'\n`,
      ),
    ).toBe(false);
    expect(
      canSkipPerFileRetry(
        "-a",
        "chmod: Unable to translate 'deny' to a UUID\n",
      ),
    ).toBe(false);
  });

  it("never short-circuits the lock path", () => {
    expect(canSkipPerFileRetry("+a", noAcl)).toBe(false);
  });

  it("does not treat an empty stderr as benign", () => {
    expect(canSkipPerFileRetry("-a", "")).toBe(false);
  });
});

describe("normalizeDesignDir", () => {
  it("strips separators and normalizes", () => {
    expect(normalizeDesignDir("designs")).toBe("designs");
    expect(normalizeDesignDir("a/b/")).toBe("a/b");
    expect(normalizeDesignDir("a\\b")).toBe("a/b");
    expect(normalizeDesignDir("a/./b")).toBe("a/b");
  });

  it("returns empty for anything that escapes or is not a dir", () => {
    // Empty must mean "no design dir", never "lock everything relative to /".
    expect(normalizeDesignDir("")).toBe("");
    expect(normalizeDesignDir(".")).toBe("");
    expect(normalizeDesignDir("/")).toBe("");
    expect(normalizeDesignDir("..")).toBe("");
    expect(normalizeDesignDir("../escape")).toBe("");
    expect(normalizeDesignDir("a/../..")).toBe("");
  });

  it("returns empty for an absolute path instead of rebasing it", () => {
    // Regression: the leading-slash strip ran BEFORE the escape check, so
    // `/Users/me/repo/designs` became the repo-relative
    // `Users/me/repo/designs` — truthy, past lockCodebase's guard, and matching
    // no tracked file. isInsideDir then exempted nothing, so the design folder
    // was locked with the rest of the tree and the call reported success:
    // design mode with nothing writable at all.
    expect(normalizeDesignDir("/abs/designs")).toBe("");
    expect(normalizeDesignDir("/Users/me/repo/styles/Designs")).toBe("");
    expect(normalizeDesignDir("//abs//designs//")).toBe("");
    // `/designs/` is refused too. Nothing distinguishes a repo-relative path
    // written with a decorative leading slash from a real absolute one, and the
    // failure is silent and total, so the ambiguous spelling is not accepted.
    expect(normalizeDesignDir("/designs/")).toBe("");
  });
});

describe("isInsideDir", () => {
  it("matches on segment boundaries only", () => {
    expect(isInsideDir("designs/a.css", "designs")).toBe(true);
    expect(isInsideDir("designs", "designs")).toBe(true);
    expect(isInsideDir("designs/deep/a.css", "designs")).toBe(true);
    // The bug this guards: a prefix match would wrongly exempt these.
    expect(isInsideDir("designs-old/a.css", "designs")).toBe(false);
    expect(isInsideDir("src/designs/a.css", "designs")).toBe(false);
    // No design dir ⇒ nothing is exempt (unlock sweeps the whole tree).
    expect(isInsideDir("designs/a.css", "")).toBe(false);
  });
});

describe("lockableFiles", () => {
  let workdir: string;
  let repo: string;

  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync("git", args, { cwd: repo });

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-design-lock-"));
    repo = path.join(workdir, "repo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "designs"), { recursive: true });
    await mkdir(path.join(repo, "designs-old"), { recursive: true });
    await mkdir(path.join(repo, "drop"), { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await writeFile(path.join(repo, ".gitignore"), "ignored/\n");
    await writeFile(path.join(repo, "src", "a.ts"), "a\n");
    await writeFile(path.join(repo, "designs", "d.css"), "d\n");
    await writeFile(path.join(repo, "designs-old", "o.css"), "o\n");
    await writeFile(path.join(repo, "drop", "b.ts"), "b\n");
    await writeFile(path.join(repo, "root.ts"), "r\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
    // Gitignored build output must never be locked — the dev server writes here.
    await mkdir(path.join(repo, "ignored"), { recursive: true });
    await writeFile(path.join(repo, "ignored", "build.js"), "x\n");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("locks tracked files outside the design dir, and nothing else", async () => {
    const files = await lockableFiles(repo, "designs");
    expect(files).toContain("src/a.ts");
    expect(files).toContain("root.ts");
    expect(files).toContain(".gitignore");
    // Exempt: the design folder itself.
    expect(files).not.toContain("designs/d.css");
    // Not exempt: a sibling whose name merely shares the prefix.
    expect(files).toContain("designs-old/o.css");
    // Never: gitignored build output stays writable so installs/dev servers work.
    expect(files).not.toContain("ignored/build.js");
    expect(files.some((f) => f.startsWith("ignored/"))).toBe(false);
  });

  it("sweeps everything when no design dir is given (the unlock path)", async () => {
    const files = await lockableFiles(repo, "");
    expect(files).toContain("designs/d.css");
    expect(files).toContain("src/a.ts");
  });

  it("skips files git tracks but that are absent from the worktree", async () => {
    // A folder excluded via Working directories keeps its index rows with the
    // skip-worktree bit. chmod would fail on those, so they must be filtered
    // out rather than reported as lock failures the user cannot act on.
    await setWorkingDirectories(repo, ["src", "designs"]);
    const files = await lockableFiles(repo, "designs");
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("drop/b.ts");
    expect(files).not.toContain("designs-old/o.css");
  });

  it("still locks a file pinned with --skip-worktree outside a sparse checkout", async () => {
    // Regression: the skip-worktree filter was unconditional, but the bit has a
    // second user — `git update-index --skip-worktree` pins a locally-modified
    // tracked config, and that file IS on disk. Treating it as absent left it
    // writable while design mode claimed the whole codebase was read-only.
    await git("update-index", "--skip-worktree", "src/a.ts");
    const files = await lockableFiles(repo, "designs");
    expect(files).toContain("src/a.ts");
  });

  it("also skips tracked files deleted from disk", async () => {
    await rm(path.join(repo, "src", "a.ts"));
    const files = await lockableFiles(repo, "designs");
    expect(files).not.toContain("src/a.ts");
    expect(files).toContain("root.ts");
  });

  // Validated platform-independently: every one of these inputs would otherwise
  // exempt NOTHING, so the lock would cover the design folder too and still
  // report a clean success — design mode with nothing writable at all. The
  // macOS-only `chmod` never gets a say, so the guard must be tested without it.
  describe("resolveDesignDirForLock", () => {
    it("accepts a real repo-relative folder", async () => {
      await expect(resolveDesignDirForLock(repo, "designs")).resolves.toBe(
        "designs",
      );
      await expect(resolveDesignDirForLock(repo, "/designs/")).rejects.toThrow(
        /repo-relative design folder/i,
      );
    });

    it("refuses a dir that collapses to the empty sentinel", async () => {
      for (const bad of ["", ".", "..", "../x", "/abs/designs"]) {
        await expect(resolveDesignDirForLock(repo, bad)).rejects.toThrow(
          /repo-relative design folder/i,
        );
      }
    });

    it("refuses a folder that isn't in the workspace", async () => {
      await expect(resolveDesignDirForLock(repo, "nope")).rejects.toThrow(
        /not in this workspace/i,
      );
      await expect(
        resolveDesignDirForLock(repo, "designs/missing"),
      ).rejects.toThrow(/not in this workspace/i);
    });

    it("refuses a case-mismatched spelling and names the real one", async () => {
      // macOS is case-INSENSITIVE by default, so `fs.stat("designs")` resolves
      // a folder actually called `Designs` — while isInsideDir compares git's
      // case-sensitive paths and exempts nothing. Segment-wise matching is what
      // catches it, and the message has to name the real spelling because the
      // caller has no other way to tell.
      await expect(resolveDesignDirForLock(repo, "Designs")).rejects.toThrow(
        /spelled exactly as on disk; got "Designs", found "designs"/,
      );
    });
  });

  it("refuses to lock on a platform without ACL support", async () => {
    if (designLockSupported()) return; // covered by the macOS probe instead
    await expect(lockCodebase(repo, { designDir: "designs" })).rejects.toThrow(
      /needs macOS/i,
    );
  });

  it("withUnlocked surfaces fn's error, not a failed relock", async () => {
    // The operations this wraps (checkout, merge, reset) can move the design
    // folder out from under the relock, which then legitimately refuses — and in
    // a `finally` that error REPLACES fn's, hiding why the git command failed.
    // The wrapper is a passthrough off macOS, so the platform is forced here to
    // exercise the unlock → fn → relock path. The chmod calls themselves fail on
    // Linux and are counted, not thrown, which is what makes this reachable.
    const real = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    try {
      const boom = new Error("checkout exploded");
      await expect(
        withUnlocked(repo, { designDir: "nope" }, () => Promise.reject(boom)),
      ).rejects.toBe(boom);
      // A relock failure after a SUCCESSFUL fn is the caller's problem, though:
      // the codebase is no longer locked and nothing else would say so.
      await expect(
        withUnlocked(repo, { designDir: "nope" }, () => Promise.resolve("ok")),
      ).rejects.toThrow(/not in this workspace/i);
    } finally {
      Object.defineProperty(process, "platform", {
        value: real,
        configurable: true,
      });
    }
  });

  it("refuses to lock with an unusable design dir", async () => {
    if (!designLockSupported()) return; // the macOS check fires first
    for (const bad of ["", "..", "/abs/designs"]) {
      await expect(lockCodebase(repo, { designDir: bad })).rejects.toThrow(
        /repo-relative design folder/i,
      );
    }
    await expect(lockCodebase(repo, { designDir: "nope" })).rejects.toThrow(
      /not in this workspace/i,
    );
  });
});
