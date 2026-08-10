import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveFilesToCopy } from "../files-to-copy";

const execFileAsync = promisify(execFile);

async function initRepo(repoRoot: string, gitignore: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, ".gitignore"), gitignore);
  await writeFile(path.join(repoRoot, "README.md"), "# init\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

describe("resolveFilesToCopy", () => {
  let workdir: string;
  let repoRoot: string;
  let userDir: string;
  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-ftc-"));
    repoRoot = path.join(workdir, "repo");
    userDir = path.join(workdir, "user");
    await mkdir(userDir, { recursive: true });
    // Isolate the user settings layer (opSettingsResolve reads it).
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
  });
  afterEach(async () => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    await rm(workdir, { recursive: true, force: true });
  });

  const write = (rel: string, body = "x") => writeFile(path.join(repoRoot, rel), body);

  it("defaults to .env* — seeds gitignored .env files, not other ignored files", async () => {
    await initRepo(repoRoot, ".env*\n*.log\n");
    await write(".env");
    await write(".env.local");
    await write("debug.log"); // gitignored, but does NOT match .env*
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.paths.sort()).toEqual([".env", ".env.local"]);
  });

  it("returns nothing when no gitignored file matches (tracked + non-ignored excluded)", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write("plain.txt"); // untracked but NOT ignored → excluded
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual([]);
  });

  it("DEFAULT source seeds gitignored matches only — an untracked-not-ignored .env is skipped", async () => {
    // Nobody named this file: seeding it would surface it in the worktree's
    // Changes tab (it isn't ignored there either), where an agent could
    // commit the secret. The implicit default stays conservative.
    await initRepo(repoRoot, "*.log\n"); // .env NOT gitignored
    await write(".env", "SECRET=1");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.paths).toEqual([]);
  });

  it(".worktreeinclude seeds an untracked-not-ignored match (explicit intent wins)", async () => {
    // The user NAMED the path; "listed in .worktreeinclude but missing from
    // .gitignore" must not silently skip — that read as "the feature is
    // broken" in the field.
    await initRepo(repoRoot, "*.log\n"); // .env NOT gitignored
    await write(".env", "SECRET=1");
    await write(".worktreeinclude", ".env\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("worktreeinclude");
    expect(r.paths).toEqual([".env"]);
  });

  it("directory pattern in .worktreeinclude seeds the dir's contents at any depth", async () => {
    // Gitignore-style dir patterns (`secrets/`) used to match nothing at
    // depth: git's leading-directory pathspec rule is off once the pathspec
    // contains a wildcard, so `**/secrets` never matched nested/secrets/*.
    await initRepo(repoRoot, "secrets/\n");
    await mkdir(path.join(repoRoot, "secrets"), { recursive: true });
    await mkdir(path.join(repoRoot, "nested", "secrets"), { recursive: true });
    await write("secrets/root.key");
    await write("nested/secrets/deep.key");
    await write(".worktreeinclude", "secrets/\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths.sort()).toEqual(["nested/secrets/deep.key", "secrets/root.key"]);
  });

  it("anchored dir-with-slash pattern seeds nested contents", async () => {
    await initRepo(repoRoot, "config/certs/\n");
    await mkdir(path.join(repoRoot, "config", "certs", "sub"), { recursive: true });
    await write("config/certs/server.pem");
    await write("config/certs/sub/chain.pem");
    await write(".worktreeinclude", "config/certs\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths.sort()).toEqual([
      "config/certs/server.pem",
      "config/certs/sub/chain.pem",
    ]);
  });

  it("excludes a TRACKED file even if it matches the pattern (only gitignored seeded)", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write(".env.example", "template");
    await execFileAsync("git", ["add", "-f", ".env.example"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "track example"], { cwd: repoRoot });
    await write(".env", "real");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual([".env"]); // .env.example is tracked → already in the worktree
  });

  it("does not turn an ignored nested Git worktree into an implicit .env seed", async () => {
    // A linked worktree is an opaque repository boundary to the outer
    // checkout. When an inner tracked `.env.example` matches the `.env*`
    // pathspec, `git ls-files -o -i` reports the WHOLE nested worktree path
    // with a trailing slash instead of the inner file. Treating that row as a
    // seed recursively copied every file in every Claude worktree.
    await initRepo(repoRoot, ".env*\n.claude/worktrees/\n");
    await write(".env.example", "template");
    await execFileAsync("git", ["add", "-f", ".env.example"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "track env template"], {
      cwd: repoRoot,
    });
    await mkdir(path.join(repoRoot, ".claude", "worktrees"), {
      recursive: true,
    });
    await execFileAsync(
      "git",
      [
        "worktree",
        "add",
        "-q",
        "-b",
        "test/nested-env-template",
        path.join(repoRoot, ".claude", "worktrees", "nested"),
        "main",
      ],
      { cwd: repoRoot },
    );

    const r = await resolveFilesToCopy(repoRoot);

    expect(r.source).toBe("default");
    expect(r.paths).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringContaining(
        "skipped 1 opaque nested Git worktree/repository",
      ),
    ]);
  });

  it("matches gitignored files in subdirectories (basename pattern, any depth)", async () => {
    await initRepo(repoRoot, ".env*\n");
    await mkdir(path.join(repoRoot, "packages", "app"), { recursive: true });
    await write("packages/app/.env", "nested");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual(["packages/app/.env"]);
  });

  it(".worktreeinclude overrides the default and matches its own globs", async () => {
    await initRepo(repoRoot, ".env*\n*.log\n");
    await write(".env");
    await write("debug.log");
    await write(".worktreeinclude", "*.log\n# a comment\n\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("worktreeinclude");
    expect(r.paths).toEqual(["debug.log"]); // .env NOT seeded — pattern is *.log
  });

  it("honors negation lines in .worktreeinclude", async () => {
    // `!` used to be skipped with a warning, so a .worktreeinclude written for
    // any other tool silently seeded MORE than it asked for.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".env.local");
    await write(".worktreeinclude", ".env*\n!.env.local\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual([".env"]);
    expect(r.warnings).toEqual([]);
  });

  it("applies negation in gitignore ORDER — a later line wins", async () => {
    // `!x` BEFORE the broad pattern does NOT exclude: gitignore is last-match.
    // Anything that models `!` as a set-subtraction gets this backwards.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".env.local");
    await write(".worktreeinclude", "!.env.local\n.env*\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths.sort()).toEqual([".env", ".env.local"]);
  });

  it("honors negation in file_include_globs too", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".env.production");
    await writeFile(
      path.join(userDir, "settings.toml"),
      `file_include_globs = [".env*", "!.env.production"]\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("file_include_globs");
    expect(r.paths).toEqual([".env"]);
  });

  it("negation-only patterns seed nothing (never 'everything'), and SAY so", async () => {
    // Two failure modes in one. A pathspec list that ends up EMPTY means
    // "match everything" to git, so this must not become "copy the whole
    // repo". And because `!` used to be rejected outright, people learned it
    // subtracts from the built-in default — so "just `!.env.local`" is exactly
    // what someone writes expecting ".env* minus .env.local", and getting a
    // silent "nothing to seed" is the worst possible answer.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".env.local");
    await write(".worktreeinclude", "!.env.local\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.warnings.some((w) => w.includes("no pattern that INCLUDES"))).toBe(
      true,
    );
  });

  it("a pattern ending in a TAB still matches (git strips only trailing spaces)", async () => {
    // JS trimEnd() eats tabs; git's gitignore parser strips only 0x20. The
    // prune must not be narrower than the matcher, or the named file is
    // silently never seeded.
    await initRepo(repoRoot, "*.txt\n");
    await write("tabend\t");
    await write(".worktreeinclude", "tabend\t\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual(["tabend\t"]);
  });

  it("trims whitespace around a file_include_globs entry", async () => {
    // A `.worktreeinclude` LINE keeps leading whitespace (gitignore says so),
    // but a TOML array entry is a discrete value — `" .env"` is a typo, and
    // honouring it would match nothing with the space invisible in the UI.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await writeFile(
      path.join(userDir, "settings.toml"),
      `file_include_globs = [" .env "]\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("file_include_globs");
    expect(r.paths).toEqual([".env"]);
  });

  it("a pattern pointing outside the repo warns instead of killing the scan", async () => {
    // `:(glob)../x` is FATAL to git ls-files, which failed the whole call — one
    // typo'd line stopped every file from being seeded, in every workspace.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".worktreeinclude", "../outside\n.env\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.complete).toBe(true);
    expect(r.paths).toEqual([".env"]); // the VALID line still seeds
    expect(r.warnings.some((w) => w.includes("outside the project"))).toBe(true);
  });

  it("an unreadable .worktreeinclude falls back instead of seeding nothing", async () => {
    // A DIRECTORY named .worktreeinclude passes existsSync; readFileSync threw,
    // the pattern list came back empty, and the workspace silently got NO .env.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await mkdir(path.join(repoRoot, ".worktreeinclude"), { recursive: true });
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.paths).toEqual([".env"]);
    expect(r.warnings.some((w) => w.includes("could not be read"))).toBe(true);
  });

  it("NO .worktreeinclude is silent — absence is not an unreadable file", async () => {
    // The pair to the test above. Both land here through one failed open(), and
    // only the errno separates them: ENOENT is the ordinary "this repo has no
    // .worktreeinclude" and must fall through WITHOUT a warning, while anything
    // else is genuinely unreadable and must warn. Collapse the two — drop the
    // errno check while removing the check-then-use race — and every repo in
    // the common case starts reporting a file it never had.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.paths).toEqual([".env"]);
    expect(r.warnings.filter((w) => w.includes("could not be read"))).toEqual(
      [],
    );
  });

  it("an EMPTY .worktreeinclude seeds nothing, and says so", async () => {
    // Distinct from unreadable: the file parsed fine and asks for nothing. The
    // file replaces the default, so this really is "copy nothing" — but it is
    // surprising enough to warrant a warning.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".worktreeinclude", "# nothing here\n\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("worktreeinclude");
    expect(r.paths).toEqual([]);
    expect(r.warnings.some((w) => w.includes("no patterns"))).toBe(true);
  });

  it("matches case-insensitively when the filesystem does (core.ignorecase)", async () => {
    // macOS/Windows default. Git's EXCLUDE engine honors core.ignorecase; the
    // PATHSPEC engine does not unless told to — so the pathspec prune, which is
    // only ever meant to speed the scan up, silently dropped files git itself
    // said matched. Reproducible on Linux by setting the flag by hand.
    await initRepo(repoRoot, ".env*\n");
    await execFileAsync("git", ["config", "core.ignorecase", "true"], {
      cwd: repoRoot,
    });
    await write(".env");
    await write(".worktreeinclude", ".ENV\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual([".env"]);
  });

  it("leading whitespace in a pattern still matches (prune must not trim it)", async () => {
    // gitignore strips only TRAILING space; a leading space is part of the
    // pattern. Trimming it in the prune pruned away the file it named.
    await initRepo(repoRoot, "*.txt\n");
    await write("  lead.txt");
    await write(".worktreeinclude", "  lead.txt\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual(["  lead.txt"]);
  });

  it("uses file_include_globs from USER settings when no .worktreeinclude", async () => {
    await initRepo(repoRoot, "secret.key\n.env*\n");
    await write("secret.key");
    await write(".env");
    await writeFile(
      path.join(userDir, "settings.toml"),
      `file_include_globs = ["secret.key"]\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("file_include_globs");
    expect(r.paths).toEqual(["secret.key"]); // .env NOT seeded — glob is secret.key only
  });

  it("reports complete:true with no deferrals in the normal case", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.complete).toBe(true);
    expect(r.deferredPaths).toEqual([]);
  });

  it("defers matches beyond the sync cap instead of dropping them", async () => {
    await initRepo(repoRoot, "seed-*.txt\n");
    await write(".worktreeinclude", "seed-*.txt\n");
    // 510 matches — 10 past the 500 sync cap. The overflow must be RETURNED
    // (deferredPaths) for the background pass, never silently truncated:
    // user-configured seeding is a guarantee, not best-effort.
    for (let i = 0; i < 510; i++) {
      await write(`seed-${String(i).padStart(3, "0")}.txt`);
    }
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.complete).toBe(true);
    expect(r.paths.length).toBe(500);
    expect(r.deferredPaths.length).toBe(10);
    // Nothing lost across the two lists.
    expect(new Set([...r.paths, ...r.deferredPaths]).size).toBe(510);
    expect(r.warnings.some((w) => w.includes("background"))).toBe(true);
  });

  it("reports complete:false when enumeration fails (caller retries in background)", async () => {
    // Not a git repo → ls-files fails → the result must SAY the scan was cut
    // short, so the caller re-runs it unbounded instead of assuming no seeds.
    await mkdir(repoRoot, { recursive: true });
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.complete).toBe(false);
    expect(r.paths).toEqual([]);
    expect(r.warnings.some((w) => w.includes("retry in background"))).toBe(true);
  });

  it("timeoutMs: 0 runs unbounded and completes", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    const r = await resolveFilesToCopy(repoRoot, { timeoutMs: 0 });
    expect(r.complete).toBe(true);
    expect(r.paths).toEqual([".env"]);
  });

  it("IGNORES file_include_globs from the COMMITTED repo settings file", async () => {
    // The committed `.zeros/settings.toml` carries scripts config; a
    // clone-borne file naming host paths to copy buys nothing over
    // `.worktreeinclude`, which is the committed mechanism and outranks the
    // key anyway. The sanitizer drops it, so the DEFAULT (.env*) applies.
    await initRepo(repoRoot, "secret.key\n.env*\n");
    await write("secret.key");
    await write(".env");
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.toml"),
      `file_include_globs = ["secret.key"]\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.paths).toEqual([".env"]); // secret.key NOT seeded — repo glob is inert
  });

  it("READS file_include_globs from the personal repo-local file (per-project scope)", async () => {
    // `.zeros/settings.local.toml` is gitignored and per-machine — the same
    // trust as the user file, scoped to one repo. This is what the settings
    // pane's "This project" scope writes.
    await initRepo(repoRoot, "secret.key\n.env*\n");
    await write("secret.key");
    await write(".env");
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.local.toml"),
      `file_include_globs = ["secret.key"]\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("file_include_globs");
    expect(r.paths).toEqual(["secret.key"]);
  });

  it("an EXPLICITLY EMPTY list copies nothing — it is not 'use the default'", async () => {
    // "I unticked everything" has to be expressible. Treating an empty list as
    // "unset" brought the built-in `.env*` back, so the file the user had just
    // said no to was seeded anyway — the exact opposite of the instruction.
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.local.toml"),
      `file_include_globs = []\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("file_include_globs");
    expect(r.paths).toEqual([]);
    expect(r.warnings.some((w) => w.includes("list is empty"))).toBe(true);
  });

  it("an ABSENT key still means the default", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.local.toml"),
      `[git]\nbase_branch = "main"\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("default");
    expect(r.paths).toEqual([".env"]);
  });

  it("this project REPLACES all projects — the lists never merge", async () => {
    await initRepo(repoRoot, "secret.key\n.env*\n");
    await write("secret.key");
    await write(".env");
    await writeFile(
      path.join(userDir, "settings.toml"),
      `file_include_globs = [".env*"]\n`,
    );
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.local.toml"),
      `file_include_globs = ["secret.key"]\n`,
    );
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths).toEqual(["secret.key"]); // .env NOT seeded
  });

  it(".worktreeinclude outranks BOTH settings layers", async () => {
    await initRepo(repoRoot, "secret.key\n.env*\n*.log\n");
    await write("secret.key");
    await write(".env");
    await write("debug.log");
    await writeFile(
      path.join(userDir, "settings.toml"),
      `file_include_globs = [".env*"]\n`,
    );
    await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".zeros", "settings.local.toml"),
      `file_include_globs = ["secret.key"]\n`,
    );
    await write(".worktreeinclude", "*.log\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.source).toBe("worktreeinclude");
    expect(r.paths).toEqual(["debug.log"]);
  });
});
