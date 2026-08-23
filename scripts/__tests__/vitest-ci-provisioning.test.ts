// The Vitest suite has TWO kinds of host prerequisite, and this guard used to
// check only the first — for only one workflow file:
//
//   1. Chromium. The suite includes two real-browser design-runtime contracts.
//      Package installation intentionally does not download Playwright browsers,
//      so every CI job that invokes `pnpm test:git` must provision Chromium
//      first. Without this the unit suite can pass locally from a warm
//      Playwright cache while a clean GitHub runner fails before either
//      browser-backed assertion executes.
//
//   2. The contained-execution runtime. Other tests drive real
//      bubblewrap/seccomp containment, which needs bubblewrap and socat
//      installed AND Ubuntu's unprivileged-userns restriction lifted for the
//      command. preflight.yml provisioned both; release.yml, release-alpha.yml
//      and release-beta.yml provisioned neither. So the IDENTICAL
//      `pnpm test:git` passed the PR gate and failed every release gate —
//      3 test files on unprovisioned Ubuntu with "[zsr-supervisor] absolute
//      bwrap unavailable", and 18 on macOS, where bubblewrap cannot exist at
//      all. Alpha stayed red for 5 consecutive runs and both the Beta and
//      Production gates for v0.1.10 failed on it.
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
  /^\s+(?:run:\s*)?(?:bash scripts\/ci\/with-userns\.sh )?pnpm test:git\s*$/m;
const CONTAINMENT_ACTION = "./.github/actions/contained-execution-runtime";
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
    expect(jobs.map(({ file, job }) => `${file}:${job}`).sort()).toEqual([
      "preflight.yml:test",
      "release-alpha.yml:test",
      "release-beta.yml:test",
      "release.yml:test",
    ]);
  });

  it("runs the suite on Linux, the only host that can host the runtime", () => {
    // bubblewrap does not exist on macOS. A macOS Vitest job cannot pass the
    // containment tests at any provisioning level, so pinning the runner is
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
    "provisions the contained-execution runtime before $file:$job runs Vitest",
    ({ body }) => {
      const runtime = body.indexOf(CONTAINMENT_ACTION);
      const test = body.search(VITEST_COMMAND);

      expect(runtime).toBeGreaterThanOrEqual(0);
      expect(runtime).toBeLessThan(test);
      // The action verifies a seccomp helper vendored under node_modules, so it
      // cannot run before the install that puts it there.
      expect(body.indexOf("pnpm install --frozen-lockfile")).toBeLessThan(
        runtime,
      );
    },
  );

  it.each(jobs)(
    "lifts the userns restriction for $file:$job's Vitest command",
    ({ body }) => {
      // Installing bubblewrap is not sufficient: the containment tests nest a
      // second capability-bearing user namespace that Ubuntu's bwrap AppArmor
      // profile strips by default.
      expect(body).toContain(USERNS_WRAPPER);
    },
  );
});
