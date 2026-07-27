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

  it("skips negation lines in .worktreeinclude with a warning", async () => {
    await initRepo(repoRoot, ".env*\n");
    await write(".env");
    await write(".env.local");
    await write(".worktreeinclude", ".env*\n!.env.local\n");
    const r = await resolveFilesToCopy(repoRoot);
    expect(r.paths.sort()).toEqual([".env", ".env.local"]); // negation ignored in v1
    expect(r.warnings.some((w) => w.toLowerCase().includes("negation"))).toBe(true);
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

  it("IGNORES file_include_globs from a repo settings file (repo-file slimming 2026-07-17)", async () => {
    // Repo-scoped settings files carry scripts config only — the sanitizer
    // drops file_include_globs from repo layers, so the DEFAULT (.env*)
    // applies; the per-repo way to configure seeding is .worktreeinclude.
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
});
