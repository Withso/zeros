import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function publication(statuses: number[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-edit-workflow-")); temporary.push(directory);
  const bin = path.join(directory, "bin"), release = path.join(directory, "release");
  await mkdir(bin); await mkdir(release);
  const version = "0.1.0-alpha.123", sha = "a".repeat(40), calls = path.join(directory, "calls.jsonl");
  await writeFile(path.join(directory, "count"), "0");
  for (const file of [`Zeros-Alpha-${version}-arm64.dmg`, `Zeros-Alpha-${version}-arm64-mac.zip`,
    `Zeros-Alpha-${version}-arm64-mac.zip.blockmap`, "alpha-mac.yml"]) await writeFile(path.join(release, file), "synthetic");
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(['gh', ...args]) + '\\n');
if (args[0] === 'release' && args[1] === 'edit') {
  const file = process.env.TEST_COUNT;
  const count = Number(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, String(count + 1));
  const statuses = JSON.parse(process.env.TEST_STATUSES);
  const status = statuses[Math.min(count, statuses.length - 1)];
  if (status !== 200) {
    process.stderr.write('HTTP ' + status + ' (https://api.github.com/repos/fixture/zeros/releases/123)\\n');
    process.exit(1);
  }
} else if (args[0] === 'api' && args.includes('--jq')) {
  process.stdout.write(process.env.GITHUB_SHA + '\\n');
}
`, { mode: 0o700 });
  await writeFile(path.join(bin, "pnpm"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(['pnpm', ...args]) + '\\n');
if (args.join(' ') === 'exec tsx scripts/release/alpha-release-edit-cli.ts') {
  const result = require('node:child_process').spawnSync(process.execPath,
    [process.env.TEST_TSX, process.env.TEST_EDIT_HELPER], { env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`, { mode: 0o700 });
  const workflow: any = load(await readFile(path.join(checkout, ".github/workflows/alpha-publication.yml"), "utf8"));
  const step = workflow.jobs.publish.steps.find((row: any) => row.name === 'Publish rolling "alpha" prerelease');
  let code = 0, stderr = "";
  try {
    const isolated = 'export PATH="$TEST_BIN:/usr/bin:/bin"\nhash -r\n'
      + 'test "$(command -v gh)" = "$TEST_BIN/gh" || exit 96\n'
      + 'test "$(command -v pnpm)" = "$TEST_BIN/pnpm" || exit 96\n' + step.run;
    ({ stderr } = await promisify(execFile)("/bin/bash", ["-c", isolated], { cwd: directory, timeout: 10_000,
      // Never inherit credentials or Git routing into a synthetic publisher.
      env: { PATH: `${bin}:/usr/bin:/bin`, VERSION: version, GITHUB_REPOSITORY: "fixture/zeros", GITHUB_SHA: sha,
        TEST_BIN: bin, TEST_CALLS: calls, TEST_COUNT: path.join(directory, "count"), TEST_STATUSES: JSON.stringify(statuses),
        TEST_TSX: createRequire(import.meta.url).resolve("tsx/cli"),
        TEST_EDIT_HELPER: path.join(checkout, "scripts/release/alpha-release-edit-cli.ts") } }));
  } catch (error) {
    code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1;
    stderr = String((error as { stderr?: unknown }).stderr ?? "");
  }
  const operations: string[][] = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { code, stderr, operations };
}

describe("actual Alpha feed publication with synthetic GitHub", () => {
  it("retries a release-object HTTP 500 before uploading assets or advancing the tag", async () => {
    const result = await publication([500, 200]);
    expect(result.code, `${result.stderr}\n${JSON.stringify(result.operations)}`).toBe(0);
    const edits = result.operations.filter(row => row[0] === "gh" && row[1] === "release" && row[2] === "edit");
    expect(edits).toHaveLength(2); expect(edits[1]).toEqual(edits[0]);
    expect(edits[0]).toContain("--target"); expect(edits[0]).toContain("a".repeat(40));
    const upload = result.operations.findIndex(row => row[2] === "upload");
    const tag = result.operations.findIndex(row => row.includes("PATCH"));
    expect(upload).toBeGreaterThan(result.operations.indexOf(edits[1]!)); expect(tag).toBeGreaterThan(upload);
    expect(result.operations.at(-1)).toEqual(["pnpm", "exec", "tsx", "scripts/release/release-ledger-cli.ts", "--verify"]);
  });

  it("stops before uploads and tag mutation on a terminal edit refusal", async () => {
    const result = await publication([403, 200]);
    expect(result.code).toBe(1);
    expect(result.operations.filter(row => row[0] === "gh" && row[2] === "edit")).toHaveLength(1);
    expect(result.operations.some(row => row[2] === "upload" || row.includes("PATCH"))).toBe(false);
    expect(result.stderr).toContain("publication stopped");
    expect(result.stderr).not.toContain("https://api.github.com");
  });
});
