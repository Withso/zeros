import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/ci/retry.sh");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// A command that fails until its counter reaches `succeedOn`.
function flaky(succeedOn: number) {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-retry-"));
  directories.push(directory);
  const counter = path.join(directory, "count");
  writeFileSync(counter, "0");
  const command = `n=$(( $(cat ${counter}) + 1 )); echo $n > ${counter}; echo "Temporary failure resolving 'archive.ubuntu.com'" >&2; [ $n -ge ${succeedOn} ]`;
  return { counter, command };
}
const run = (args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, CI_RETRY_DELAY_SECONDS: "0" } });

describe("CI network install retry", () => {
  it("retries a transient failure and succeeds", () => {
    const { counter, command } = flaky(3);
    const result = run(["bash", "-c", command]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(counter, "utf8").trim()).toBe("3");
    expect(result.stderr).toContain("::warning::Attempt 1/3 failed");
  });

  it("fails with the command's status after the last attempt", () => {
    const { counter, command } = flaky(99);
    const result = run(["bash", "-c", command]);
    expect(result.status).toBe(1);
    expect(readFileSync(counter, "utf8").trim()).toBe("3");
    expect(result.stderr).toContain("::error::");
  });

  it("refuses to run without a command", () => {
    expect(run([]).status).toBe(2);
  });

  it("wraps every Playwright and apt network install in the workflows", () => {
    const files = [".github/workflows/ci.yml", ".github/workflows/preflight.yml", ".github/workflows/zstack-evals.yml",
      ".github/actions/runtime-closure-tools/action.yml"];
    const commands = files.flatMap((file) => {
      const doc = load(readFileSync(path.join(ROOT, file), "utf8")) as any;
      const jobs = doc.jobs ? Object.values(doc.jobs) as any[] : [{ steps: doc.runs.steps }];
      return jobs.flatMap((job) => (job.steps ?? []).map((step: any) => String(step.run ?? "")))
        .flatMap((script) => script.split("\n")).filter((line) => /playwright install|apt-get (update|install)/.test(line));
    });
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const line of commands) expect(line, line).toMatch(/scripts\/ci\/retry\.sh"? /);
  });
});
