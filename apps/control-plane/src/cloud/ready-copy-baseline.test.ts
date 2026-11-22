// A project build's ignored-file baseline, run for real (bash, git, node) at a
// temporary home: what every fork of the build inherits, and what retention's
// stop probe then judges against.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupProbeCommand, parseBackupProbe } from "./checkpoint.js";
import { READY_COPY_SCRUB_COMMAND, readyCopyBaselineCommand, readyCopyLayout } from "./ready-copies.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const project = { name: "Zeros", repositories: [{ repository: "withso/zeros" }, { repository: "withso/web" }] };

/** A build machine's home after cloning the project's repositories at its layout and running their setups. */
function built() {
  const root = mkdtempSync(join(tmpdir(), "zeros-ready-copy-baseline-"));
  roots.push(root);
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, "");
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@example.test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@example.test" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const home = join(root, "home");
  const checkouts = readyCopyLayout(project).map(folder => join(home, folder));
  for (const [index, checkout] of checkouts.entries()) {
    const origin = join(root, `origin-${index}.git`), seed = join(root, `seed-${index}`);
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, seed);
    write(join(seed, ".gitignore"), "node_modules/\n.env*\n*.log\n");
    write(join(seed, "README.md"), "hello\n");
    git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "base"); git(seed, "push", "-q", "origin", "main");
    mkdirSync(dirname(checkout), { recursive: true });
    git(root, "clone", "-q", origin, checkout);
    // What a setup leaves: an ignored file a backup would capture, and an ignored directory it never does.
    write(join(checkout, "build.log"), `made by setup ${index}\n`);
    write(join(checkout, "node_modules/pkg/index.js"), "dependency\n");
  }
  const run = (name: string, command: string) => spawnSync("bash", ["-c", `eval "$1"`, name, command], { env, encoding: "utf8" });
  const probe = () => { const result = run("probe", backupProbeCommand(checkouts, home)); expect(result.status).toBe(0); return parseBackupProbe(result.stdout); };
  const baselines = () => { const dir = join(home, ".local/share/zeros/retention-baseline"); return readdirSync(dir).sort().map(name => readFileSync(join(dir, name), "utf8")); };
  return { root, home, checkouts, write, run, probe, baselines };
}

describe("a project build's ignored-file baseline", () => {
  it("is recorded once per repository, at the paths a fork's workspace has", () => {
    const b = built();
    expect(b.checkouts).toEqual(["zeros/zeros", "zeros/web"].map(folder => join(b.home, folder)));
    expect(b.run("baseline", readyCopyBaselineCommand(project, b.home)).stdout).toBe("zeros-baseline recorded\n");
    expect(b.baselines()).toHaveLength(2);
  });

  it("survives the build's scrub, which only clears command inputs and job files", () => {
    const b = built();
    b.run("baseline", readyCopyBaselineCommand(project, b.home));
    const before = b.baselines();
    // The scrub, pointed at this test's own /tmp so nothing outside it is touched.
    const tmp = join(b.root, "tmp");
    b.write(join(tmp, "zeros-command-input-1/stdin"), "secret\n");
    b.write(join(tmp, "zeros-job-1/out"), "x\n");
    expect(b.run("scrub", READY_COPY_SCRUB_COMMAND.replaceAll("/tmp/", `${tmp}/`)).status).toBe(0);
    expect(readdirSync(tmp)).toEqual([]);
    expect(b.baselines()).toEqual(before);
    expect(READY_COPY_SCRUB_COMMAND).not.toMatch(/home|\.local|retention-baseline/);
  });

  it("lets a fork probe clean with the setup's ignored files untouched, and dirty once one changes", () => {
    const b = built();
    // Without a baseline the setup's own ignored file would count as work nobody can rebuild.
    expect(b.probe()).toBe("dirty");
    b.run("baseline", readyCopyBaselineCommand(project, b.home));
    // A fork has the build's disk: the same files at the same paths.
    expect(b.probe()).toBe("clean");
    b.write(join(b.checkouts[1]!, "build.log"), "edited in the workspace\n");
    expect(b.probe()).toBe("dirty");
  });

  it("is not replaced by a later build on a machine that already has one", () => {
    const b = built();
    b.run("baseline", readyCopyBaselineCommand(project, b.home));
    const first = b.baselines();
    // A rebuild of the project forks the previous copy: its setup leaves other files, and the build records again.
    b.write(join(b.checkouts[0]!, "build.log"), "made by the next setup\n");
    expect(b.run("baseline", readyCopyBaselineCommand(project, b.home)).stdout).toBe("zeros-baseline recorded\n");
    expect(b.baselines()).toEqual(first);
    expect(b.probe()).toBe("dirty");
  });
});
