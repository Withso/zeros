// The Vitest suite includes two real-browser design-runtime contracts. Package
// installation intentionally does not download Playwright browsers, so every CI
// job that invokes `pnpm test:git` must provision Chromium first. Without this
// guard, the unit suite can pass locally from a warm Playwright cache while a
// clean GitHub runner fails before either browser-backed assertion executes.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS_DIR = path.join(ROOT, ".github", "workflows");
const VITEST_COMMAND = /^\s+(?:run:\s*)?pnpm test:git\s*$/m;

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

describe("Playwright-backed Vitest CI provisioning", () => {
  const jobs = workflowTestJobs();

  it("finds every workflow job that runs the Vitest suite", () => {
    expect(jobs.map(({ file, job }) => `${file}:${job}`).sort()).toEqual([
      "preflight.yml:test",
      "release-alpha.yml:alpha",
      "release-beta.yml:beta",
      "release.yml:test",
    ]);
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
});
