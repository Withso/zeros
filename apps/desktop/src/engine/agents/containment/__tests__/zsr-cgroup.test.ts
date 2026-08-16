import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createZsrCgroupScope, wrapWithZsrCgroup } from "../zsr-cgroup.mjs";

const roots: string[] = [];
const limits = {
  memoryBytes: 3 * 1024 * 1024 * 1024,
  cpuQuotaMicros: 200_000,
  cpuPeriodMicros: 100_000,
  processes: 2_048,
};

async function fakeParent(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-cgroup-"));
  roots.push(root);
  return root;
}

function installFakeControls(scope: string, omit?: string): void {
  for (const [name, source] of [
    ["cgroup.events", "populated 0\n"],
    ["cgroup.kill", ""],
    ["cgroup.procs", ""],
    ["cpu.max", "max 100000\n"],
    ["memory.max", "max\n"],
    ["memory.oom.group", "0\n"],
    ["memory.swap.max", "max\n"],
    ["pids.max", "max\n"],
  ]) {
    if (name !== omit) writeFileSync(path.join(scope, name), source);
  }
}

describe("ZSR cloud cgroup scopes", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("writes exact per-execution cpu, memory, OOM, swap, and pid limits", async () => {
    if (process.platform !== "linux") return;
    const parent = await fakeParent();
    const scope = createZsrCgroupScope({
      parent,
      generation: "generation-secret-must-be-hashed",
      limits,
      onDirectoryCreatedForTesting: (directory: string) => {
        // The production cgroup filesystem materializes controller files when
        // mkdir returns. This test seam models only that kernel behavior.
        installFakeControls(directory);
      },
    });

    expect(path.basename(scope.path)).toMatch(/^zsr-agent-[a-f0-9]{24}$/);
    expect(scope.path).not.toContain("generation-secret");
    await expect(
      readFile(path.join(scope.path, "memory.max"), "utf8"),
    ).resolves.toBe(`${limits.memoryBytes}\n`);
    await expect(
      readFile(path.join(scope.path, "cpu.max"), "utf8"),
    ).resolves.toBe(`${limits.cpuQuotaMicros} ${limits.cpuPeriodMicros}\n`);
    await expect(
      readFile(path.join(scope.path, "pids.max"), "utf8"),
    ).resolves.toBe(`${limits.processes}\n`);
    await expect(
      readFile(path.join(scope.path, "memory.oom.group"), "utf8"),
    ).resolves.toBe("1\n");
    await expect(
      readFile(path.join(scope.path, "memory.swap.max"), "utf8"),
    ).resolves.toBe("0\n");
  });

  it("attaches the trusted outer command before exec without shell interpolation", async () => {
    const parent = await fakeParent();
    const scopePath = path.join(parent, "scope with spaces");
    await mkdir(scopePath);
    await writeFile(path.join(scopePath, "cgroup.procs"), "");
    const marker = "literal-$()-`-argument";
    const argv = wrapWithZsrCgroup({ path: scopePath, limits }, [
      process.execPath,
      "-e",
      "process.stdout.write(process.argv[1])",
      marker,
    ]);
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(marker);
    expect(
      await readFile(path.join(scopePath, "cgroup.procs"), "utf8"),
    ).toMatch(/^[1-9][0-9]*\n$/);
  });

  it("fails closed when a delegated controller is missing", async () => {
    if (process.platform !== "linux") return;
    const parent = await fakeParent();
    expect(() =>
      createZsrCgroupScope({
        parent,
        generation: "missing-controller",
        limits,
        onDirectoryCreatedForTesting: (scope: string) => {
          // Deliberately omit pids.max.
          installFakeControls(scope, "pids.max");
        },
      }),
    ).toThrow(/missing required controller|unavailable/);
  });
});
