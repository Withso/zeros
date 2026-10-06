import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const ROOT = path.resolve(import.meta.dirname, "../..");
const STEP = "Fetch origin/main (for the migration forward-only guard)";
const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function baselineStep(file: string) {
  const workflow = load(
    readFileSync(path.join(ROOT, ".github/workflows", file), "utf8"),
  ) as Workflow;
  const step = workflow.jobs["test-shard"].steps.find(
    (candidate) => candidate.name === STEP,
  );
  if (!step?.run) throw new Error(`${file} lacks the baseline step`);
  return step;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function commit(cwd: string, migration: string) {
  writeFileSync(path.join(cwd, migration), `-- ${migration}\n`);
  git(cwd, "add", migration);
  git(cwd, "commit", "-q", "-m", migration);
  return git(cwd, "rev-parse", "HEAD");
}

// The checkout is at `tested`, pushed onto `before`. The remote main has since
// advanced to `later`, which adds a migration the tested commit lacks.
function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-migration-baseline-"));
  temporary.push(root);
  const remote = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", checkout);
  git(checkout, "config", "user.email", "ci@example.com");
  git(checkout, "config", "user.name", "CI");
  const before = commit(checkout, "0001_first.sql");
  const tested = commit(checkout, "0002_tested.sql");
  const later = commit(checkout, "0003_later.sql");
  git(checkout, "remote", "add", "origin", remote);
  git(checkout, "push", "-q", "origin", "main");
  git(checkout, "reset", "-q", "--hard", tested);
  git(checkout, "update-ref", "-d", "refs/remotes/origin/main");
  return { checkout, before, tested, later };
}

function runStep(
  file: string,
  cwd: string,
  context: { EVENT_NAME: string; GITHUB_REF: string; PUSH_BEFORE: string },
) {
  execFileSync("bash", ["-e", "-c", baselineStep(file).run!], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...context },
    encoding: "utf8",
  });
  return git(cwd, "rev-parse", "refs/remotes/origin/main");
}

describe("migration guard baseline", () => {
  it("keeps the identical step in CI and Preflight", () => {
    expect(baselineStep("ci.yml")).toEqual(baselineStep("preflight.yml"));
    expect(baselineStep("preflight.yml").env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      PUSH_BEFORE: "${{ github.event.before }}",
    });
  });

  it("compares a delayed main push with the main it was pushed onto", () => {
    const { checkout, before } = repository();
    expect(
      runStep("preflight.yml", checkout, {
        EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        PUSH_BEFORE: before,
      }),
    ).toBe(before);
  });

  it.each(["0".repeat(40), "", "not-a-sha", "f".repeat(40)])(
    "falls back to the first parent when the push base %j is unusable",
    (base) => {
      const { checkout, before } = repository();
      expect(
        runStep("preflight.yml", checkout, {
          EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          PUSH_BEFORE: base,
        }),
      ).toBe(before);
    },
  );

  it("compares a pull request's merge commit with the main it merged", () => {
    const { checkout, before, tested } = repository();
    // GitHub checks out a merge commit whose first parent is the base.
    git(checkout, "checkout", "-q", "-b", "feature", before);
    commit(checkout, "0002_feature.sql");
    git(checkout, "checkout", "-q", "--detach", before);
    git(checkout, "merge", "-q", "--no-ff", "-m", "merge", "feature");
    expect(git(checkout, "rev-parse", "HEAD^1")).toBe(before);
    expect(tested).not.toBe(before);
    expect(
      runStep("ci.yml", checkout, {
        EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/7/merge",
        PUSH_BEFORE: "",
      }),
    ).toBe(before);
  });

  it.each([
    { EVENT_NAME: "push", GITHUB_REF: "refs/heads/release/1.2.3" },
    { EVENT_NAME: "merge_group", GITHUB_REF: "refs/heads/main" },
  ])(
    "keeps fetching the current main for $EVENT_NAME on $GITHUB_REF",
    (context) => {
      const { checkout, before, later } = repository();
      expect(
        runStep("ci.yml", checkout, { ...context, PUSH_BEFORE: before }),
      ).toBe(later);
    },
  );
});
