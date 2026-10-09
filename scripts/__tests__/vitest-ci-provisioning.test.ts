// The Vitest suite has several host prerequisites, and this guard used to
// check only the first — for only one workflow file:
//
//   1. Chromium. The suite includes two real-browser design-runtime contracts.
//      Package installation intentionally does not download Playwright browsers,
//      so every CI job that invokes `pnpm test:git` must provision Chromium
//      first. Without this the unit suite can pass locally from a warm
//      Playwright cache while a clean GitHub runner fails before either
//      browser-backed assertion executes.
//
//   2. Offline archive closure. The shipped provider/ripgrep artifact tests
//      use bubblewrap and setpriv against a read-only archive with no ambient
//      dependencies. Ubuntu userns restrictions must be lifted only for that
//      command. This qualifies artifact completeness, not agent isolation.
//
//   3. The control-plane package graph. Contract tests under scripts/ import
//      control-plane sources, whose dependencies live in apps/control-plane's
//      own lockfile, not the root one. preflight.yml installed that graph; the
//      three release gates did not, so the same suite failed there with
//      "Cannot find package 'hono'".
//
//   4. The native PTY binding. A restored pnpm store can skip node-pty's build
//      while leaving its native module unavailable. Rebuild and load it before
//      the suite so real terminal and SSH tests have a working binding.
//
// Asserting the whole prerequisite set against EVERY job that runs the suite is
// what makes that class of drift impossible to reintroduce quietly.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");

// The suite is invoked either directly or through the userns wrapper. Both
// spellings must be recognised, or a job silently drops out of this guard's
// coverage — which is precisely how the release gates escaped it.
const VITEST_COMMAND =
  /^\s+(?:run:\s*)?(?:bash scripts\/ci\/with-userns\.sh )?pnpm test:git(?: --shard="\$\{VITEST_PART\}\/\d+")?\s*$/m;
const CLOSURE_ACTION = "./.github/actions/runtime-closure-tools";
const USERNS_WRAPPER = "bash scripts/ci/with-userns.sh pnpm test:git";

type TestJob = {
  file: string;
  job: string;
  body: string;
};

function workflowTestJobs(): TestJob[] {
  const jobs: TestJob[] = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((name) =>
    /\.ya?ml$/.test(name),
  )) {
    const source = readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
    const jobsStart = source.indexOf("\njobs:\n");
    if (jobsStart < 0) continue;
    const jobsSource = source.slice(jobsStart + "\njobs:\n".length);
    const headings = [...jobsSource.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index]!;
      const body = jobsSource.slice(
        heading.index,
        headings[index + 1]?.index ?? jobsSource.length,
      );
      if (VITEST_COMMAND.test(body)) {
        jobs.push({ file, job: heading[1]!, body });
      }
    }
  }
  return jobs;
}

describe("Vitest CI provisioning", () => {
  const jobs = workflowTestJobs();

  it("finds every workflow job that runs the Vitest suite", () => {
    // Releases require the exact commit's successful Preflight instead of
    // re-running the suite. Pull requests run the same job in CI. Its four
    // native shards are matrix legs of one job behind the `test` aggregate.
    expect(jobs.map(({ file, job }) => `${file}:${job}`).sort()).toEqual([
      "ci.yml:test-shard",
      "preflight.yml:test-shard",
    ]);
  });

  it("runs the artifact closure suite on Linux", () => {
    // bubblewrap does not exist on macOS. A macOS Vitest job cannot pass the
    // archive namespace tests at any provisioning level, so pinning the runner is
    // part of the contract rather than an incidental choice.
    for (const { file, job, body } of jobs) {
      expect(body, `${file}:${job}`).toContain("runs-on: ubuntu-latest");
    }
  });

  it.each(jobs)(
    "installs Chromium before $file:$job runs Vitest",
    ({ body }) => {
      const install = body.indexOf("playwright install");
      const test = body.search(VITEST_COMMAND);

      expect(install).toBeGreaterThanOrEqual(0);
      expect(install).toBeLessThan(test);
      expect(body.slice(install, test)).toContain("--only-shell chromium");
    },
  );

  it.each(jobs)(
    "provisions offline artifact tools before $file:$job runs Vitest",
    ({ body }) => {
      const runtime = body.indexOf(CLOSURE_ACTION);
      const test = body.search(VITEST_COMMAND);

      expect(runtime).toBeGreaterThanOrEqual(0);
      expect(runtime).toBeLessThan(test);
      // Keep the shared install/provision order before real artifact checks.
      expect(body.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
        runtime,
      );
    },
  );

  it.each(jobs)(
    "installs the control-plane package graph before $file:$job runs Vitest",
    ({ body }) => {
      const install = body.search(
        /working-directory: apps\/control-plane\n\s+run: pnpm install --frozen-lockfile/,
      );
      const test = body.search(VITEST_COMMAND);

      expect(install).toBeGreaterThanOrEqual(0);
      expect(install).toBeLessThan(test);
    },
  );

  it.each(jobs)(
    "rebuilds and verifies the native PTY binding before $file:$job runs Vitest",
    ({ body }) => {
      const install = body.indexOf("pnpm install --frozen-lockfile");
      const rebuild = body.indexOf("pnpm rebuild node-pty");
      const verify = body.indexOf("node -e \"require('node-pty')\"");
      const test = body.search(VITEST_COMMAND);

      expect(install).toBeGreaterThanOrEqual(0);
      expect(rebuild).toBeGreaterThan(install);
      expect(verify).toBeGreaterThan(rebuild);
      expect(verify).toBeLessThan(test);
    },
  );

  it.each(jobs)(
    "lifts the userns restriction for $file:$job's Vitest command",
    ({ body }) => {
      // Ubuntu may deny the offline artifact namespaces even with bwrap
      // installed. Permit them only for this command, then restore policy.
      expect(body).toContain(USERNS_WRAPPER);
    },
  );
});
