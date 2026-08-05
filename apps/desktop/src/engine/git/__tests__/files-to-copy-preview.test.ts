// `previewFilesToCopy` — everything the "Files to copy" settings pane renders
// in one read. The contract that matters is that it answers questions a raw
// textarea can't: which source won, what those patterns resolve to ON DISK,
// which rows need a warning (not gitignored / already tracked / matches
// nothing), and how big the whole thing is.
//
// Plus the seeding regressions the preview surface exists to make visible:
//   • a `..` pattern used to make `git ls-files` fail FATALLY, killing the
//     whole scan — one typo'd line stopped every file from being seeded,
//   • an unreadable `.worktreeinclude` silently disabled seeding entirely.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { previewFilesToCopy } from "../files-to-copy";

const execFileAsync = promisify(execFile);

describe("previewFilesToCopy", () => {
  let workdir: string;
  let repoRoot: string;
  let userDir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-ftcp-"));
    repoRoot = path.join(workdir, "repo");
    userDir = path.join(workdir, "user");
    await mkdir(userDir, { recursive: true });
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "t@t"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, ".gitignore"), ".env*\ncerts/\n");
    await writeFile(path.join(repoRoot, "README.md"), "# init\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: repoRoot,
    });
  });
  afterEach(async () => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    await rm(workdir, { recursive: true, force: true });
  });

  const write = (rel: string, body = "x") =>
    writeFile(path.join(repoRoot, rel), body);

  it("reports the resolved files, their sizes and the folder they come from", async () => {
    await write(".env", "SECRET=1234567890");
    await write(".env.local", "A=1");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.complete).toBe(true);
    expect(r.rootPath).toBe(repoRoot);
    expect(r.files.map((f) => f.path).sort()).toEqual([".env", ".env.local"]);
    expect(r.totalCount).toBe(2);
    expect(r.totalBytes).toBe(20); // 17 + 3
    expect(r.files.every((f) => f.ignored)).toBe(true);
  });

  it("flags a matched file that git is NOT ignoring", async () => {
    // The row that needs a warning: it IS copied (the user named it), but it
    // lands in the new workspace's Changes tab where an agent could commit it.
    await write("config.local.json", "{}");
    await write(".worktreeinclude", "config.local.json\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files).toEqual([
      { path: "config.local.json", bytes: 2, ignored: false },
    ]);
    expect(r.warnings.some((w) => w.includes("not gitignored"))).toBe(true);
  });

  it("reports TRACKED matches separately instead of silently dropping them", async () => {
    // "Already in every workspace" — copying is a no-op, but hiding the row
    // makes the pattern look broken.
    await write(".env.example", "TEMPLATE=1");
    await execFileAsync("git", ["add", "-f", ".env.example"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "track example"], {
      cwd: repoRoot,
    });
    await write(".env", "real");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    expect(r.trackedMatches).toEqual([".env.example"]);
  });

  it("counts matches per pattern so a typo shows up as 0", async () => {
    await write(".env");
    await mkdir(path.join(repoRoot, "certs"), { recursive: true });
    await write("certs/server.pem");
    await write(".worktreeinclude", ".env*\ncerts/**\nkeys/*.pem\n");
    const r = await previewFilesToCopy(repoRoot);
    const byPattern = Object.fromEntries(
      r.patterns.map((p) => [p.raw, p.matchCount]),
    );
    expect(byPattern[".env*"]).toBe(1);
    expect(byPattern["certs/**"]).toBe(1);
    expect(byPattern["keys/*.pem"]).toBe(0); // the typo signal
  });

  it("reports a negation line by how many files it takes back out", async () => {
    await write(".env");
    await write(".env.production");
    await write(".worktreeinclude", ".env*\n!.env.production\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    const neg = r.patterns.find((p) => p.negate);
    expect(neg?.pattern).toBe(".env.production");
    expect(neg?.matchCount).toBe(1);
  });

  it("a negation that removes nothing reports 0, not its raw glob count", async () => {
    // `!*.pem` next to positives that never selected a .pem removes nothing.
    // Counting every hit missing from the FINAL set credits it with files no
    // positive ever selected — so a defensive line reads as load-bearing.
    await mkdir(path.join(repoRoot, "certs"), { recursive: true });
    await write("certs/a.pem");
    await write("certs/b.pem");
    await write(".env");
    await write(".worktreeinclude", ".env*\n!*.pem\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    expect(r.patterns.find((p) => p.negate)?.matchCount).toBe(0);
  });

  it("per-pattern counts agree with the file list under the .env* default", async () => {
    // The default source seeds GITIGNORED matches only. Counting all untracked
    // matches printed "2 matches" beside a one-row list — in the most common
    // configuration there is, on the row whose whole job is to explain why a
    // file was or wasn't copied.
    await write(".env", "real");
    await write(".env.sample", "template"); // untracked, NOT gitignored
    await writeFile(path.join(repoRoot, ".gitignore"), ".env\ncerts/\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    expect(r.totalCount).toBe(1);
    expect(r.patterns[0].matchCount).toBe(1);
  });

  it("warns when the list has no pattern that includes anything", async () => {
    await write(".env");
    await write(".worktreeinclude", "!.env\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.warnings.some((w) => w.includes("no pattern that INCLUDES"))).toBe(
      true,
    );
  });

  it("returns the .worktreeinclude text so the UI can show it read-only", async () => {
    const text = "# team list\n.env\n";
    await write(".env");
    await write(".worktreeinclude", text);
    const r = await previewFilesToCopy(repoRoot);
    expect(r.source).toBe("worktreeinclude");
    expect(r.sourceText).toBe(text);
    expect(r.sourcePath).toBe(path.join(repoRoot, ".worktreeinclude"));
  });

  it("previews an UNSAVED draft", async () => {
    await write(".env");
    await write("other.key");
    await writeFile(
      path.join(repoRoot, ".gitignore"),
      ".env*\ncerts/\nother.key\n",
    );
    const draft = await previewFilesToCopy(repoRoot, {
      patterns: ["other.key"],
    });
    expect(draft.files.map((f) => f.path)).toEqual(["other.key"]);
  });

  it("a CLEARED draft previews as 'copy nothing', exactly as saving it would", async () => {
    // The pane writes the array it is showing, including an empty one, and a
    // present-but-empty list means "copy nothing" at create. Previewing the
    // built-in `.env*` for it promised a file create would not copy — and
    // re-ticked, 400ms after the click, the box the user had just cleared.
    await write(".env");
    const cleared = await previewFilesToCopy(repoRoot, { patterns: [] });
    expect(cleared.source).toBe("file_include_globs");
    expect(cleared.files).toEqual([]);
    expect(cleared.warnings.some((w) => w.includes("list is empty"))).toBe(
      true,
    );
    // Only an ABSENT list falls back to the default — which is what the
    // "Reset to default" action writes, and it sends no patterns at all.
    const saved = await previewFilesToCopy(repoRoot);
    expect(saved.source).toBe("default");
    expect(saved.files.map((f) => f.path)).toEqual([".env"]);
  });

  it("a draft entry with leading whitespace is trimmed, as a saved one is", async () => {
    // The saved path trims each TOML entry; the draft path kept the space, so
    // the pane said "matches nothing" about a pattern create would honour.
    await write(".env");
    const r = await previewFilesToCopy(repoRoot, { patterns: ["  .env"] });
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    expect(r.patterns[0].raw).toBe(".env");
  });

  it("ignores a draft when .worktreeinclude wins — previewing it would be a lie", async () => {
    await write(".env");
    await write("other.key");
    await write(".worktreeinclude", ".env\n");
    const r = await previewFilesToCopy(repoRoot, { patterns: ["other.key"] });
    expect(r.source).toBe("worktreeinclude");
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
  });

  it("names the settings layer the patterns came from", async () => {
    // "This project" vs "All projects" in the scope control is exactly this.
    await write(".env");
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.local.toml"),
      `file_include_globs = [".env"]\n`,
    );
    const r = await previewFilesToCopy(repoRoot);
    expect(r.source).toBe("file_include_globs");
    expect(r.sourceLayer).toBe("repo-local");
  });

  it("warns instead of failing when a pattern points outside the project", async () => {
    await write(".env");
    await write(".worktreeinclude", "../shared/.env\n.env\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.complete).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    expect(r.warnings.some((w) => w.includes("outside the project"))).toBe(
      true,
    );
  });

  it("offers every ignored entry as a candidate, not just the matched ones", async () => {
    // The tick-box universe. Without it the pane could only ever show what is
    // already selected, so nothing new would ever be discoverable.
    await write(".env");
    await write("debug.log");
    await writeFile(
      path.join(repoRoot, ".gitignore"),
      ".env*\ncerts/\n*.log\n",
    );
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files.map((f) => f.path)).toEqual([".env"]);
    expect(r.candidates.map((c) => c.path).sort()).toEqual([
      ".env",
      "debug.log",
    ]);
  });

  it("COLLAPSES an ignored directory to one candidate row", async () => {
    // `node_modules/` must arrive as a single row a human can read. Listing it
    // file-by-file is both unreadable and the walk the whole feature avoids.
    await mkdir(path.join(repoRoot, "certs", "sub"), { recursive: true });
    await write("certs/a.pem");
    await write("certs/sub/b.pem");
    const r = await previewFilesToCopy(repoRoot);
    const certs = r.candidates.filter((c) => c.path.startsWith("certs"));
    expect(certs).toEqual([{ path: "certs", isDir: true, bytes: -1 }]);
  });

  it("sizes candidate FILES and leaves directories unmeasured", async () => {
    await write(".env", "0123456789");
    await mkdir(path.join(repoRoot, "certs"), { recursive: true });
    await write("certs/a.pem");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.candidates.find((c) => c.path === ".env")?.bytes).toBe(10);
    // -1 is "not measured", which is a different claim from "0 bytes".
    expect(r.candidates.find((c) => c.path === "certs")?.bytes).toBe(-1);
  });

  it("offers a matched file git is NOT ignoring as a candidate row", async () => {
    // `ls-files -i --exclude-standard` only reports IGNORED entries, so the
    // one row the preview most wants to flag had nowhere to appear: the pane
    // rendered "Nothing needs copying" directly above "1 file will be copied",
    // and the "Git isn't ignoring this" badge was unreachable.
    await write("config.local.json", "{}");
    await write(".worktreeinclude", "config.local.json\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.files).toEqual([
      { path: "config.local.json", bytes: 2, ignored: false },
    ]);
    expect(r.candidates).toContainEqual({
      path: "config.local.json",
      isDir: false,
      bytes: 2,
    });
  });

  it("says so when the CANDIDATE scan fails, rather than reporting no ignored files", async () => {
    // `complete` only ever covered the match scan, so a failed candidate scan
    // came back as `candidates: []` — which the pane renders as "Zeros found
    // no ignored files in this project".
    const notARepo = path.join(workdir, "plain2");
    await mkdir(notARepo, { recursive: true });
    await writeFile(path.join(notARepo, ".worktreeinclude"), "!.env\n");
    const r = await previewFilesToCopy(notARepo);
    expect(r.candidates).toEqual([]);
    expect(r.warnings.some((w) => w.includes("couldn't list"))).toBe(true);
  });

  it("still offers candidates when the MATCH scan came up short", async () => {
    // The tick-boxes are what make the failure recoverable — a pane with no
    // rows and an error is a dead end.
    await write(".env");
    await write(".worktreeinclude", "../outside\n");
    const r = await previewFilesToCopy(repoRoot);
    expect(r.candidates.map((c) => c.path)).toContain(".env");
  });

  it("says the scan was cut short rather than reporting zero files", async () => {
    // Zero and unknown are different answers; a UI that shows "0 files" for a
    // failed scan tells the user their config is broken when it isn't.
    const notARepo = path.join(workdir, "plain");
    await mkdir(notARepo, { recursive: true });
    const r = await previewFilesToCopy(notARepo);
    expect(r.complete).toBe(false);
    expect(r.files).toEqual([]);
  });
});
