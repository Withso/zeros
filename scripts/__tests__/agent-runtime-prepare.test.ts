import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hash } from "../agent-runtime/contracts.mjs";
import {
  checkManualEdits,
  cleanProcessEnv,
  prepareUpdate,
} from "../agent-runtime/prepare.mjs";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const lock = (version: string) =>
  `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@cursor/sdk':\n        specifier: ${version}\n        version: ${version}\npackages: {}\nsnapshots: {}\n`;
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "zeros-runtime-prepare-"));
  directories.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.name", "Runtime test");
  git("config", "user.email", "runtime-fixture@example.invalid");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        dependencies: { "@cursor/sdk": "1.0.0" },
        scripts: { test: "unchanged" },
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), lock("1.0.0"));
  writeFileSync(join(root, "THIRD-PARTY-LICENSES.txt"), "old licenses\n");
  git("add", ".");
  git("commit", "-m", "initial bot baseline");
  const main = git("rev-parse", "HEAD");
  writeFileSync(
    join(root, "adapter.ts"),
    "export const feature = 'human implementation';\n",
  );
  git("add", ".");
  git("commit", "-m", "implement the integration");
  const head = git("rev-parse", "HEAD");
  const identity = {
    schema: 1,
    provider: "cursor",
    from: "1.0.0",
    version: "1.1.0",
    head,
    main,
    automation: main,
    branch: "automation/agent-runtime/cursor/012345abcdef",
    pr: 42,
    lastBotCommit: main,
    regenerate: false,
    createdAt: "2026-10-12T12:00:00.000Z",
  };
  return { root, git, task: { ...identity, id: hash(identity) } };
}

describe("isolated mechanical preparation", () => {
  it("prepares from the real human commit and leaves its implementation untouched", async () => {
    const { root, git, task } = checkout();
    const commands: string[][] = [];
    const execute = (command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (args.includes("--lockfile-only"))
        writeFileSync(join(root, "pnpm-lock.yaml"), lock("1.1.0"));
      if (args[0] === "scripts/generate-third-party-licenses.mjs")
        writeFileSync(join(root, "THIRD-PARTY-LICENSES.txt"), "new licenses\n");
    };
    const result = await prepareUpdate(task, {
      root,
      execute,
      inspect: async () => [
        { provider: "cursor", subject: "Options", disposition: null },
      ],
    });
    expect(result.status).toBe("prepared");
    expect(result.patch.files.map((file: any) => file.path)).toEqual([
      "THIRD-PARTY-LICENSES.txt",
      "package.json",
      "pnpm-lock.yaml",
    ]);
    expect(readFileSync(join(root, "adapter.ts"), "utf8")).toContain(
      "human implementation",
    );
    expect(git("rev-parse", "HEAD")).toBe(task.head);
    expect(result.report.testedHead).toBeNull();
    expect(
      result.report.gates.find((gate: any) => gate.name === "surface-review")
        .status,
    ).toBe("failed");
    expect(commands[0]).toEqual([
      "pnpm",
      "install",
      "--lockfile-only",
      "--ignore-scripts",
    ]);
  });
  it("refuses a dirty tree before touching the manifest", async () => {
    const { root, task } = checkout();
    writeFileSync(join(root, "adapter.ts"), "uncommitted work");
    await expect(prepareUpdate(task, { root })).rejects.toThrow(
      "clean working tree",
    );
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain("1.0.0");
  });
  it("prepares evidence for acknowledging regeneration when the managed files are already current", async () => {
    const { root, git, task: original } = checkout();
    const { id: _id, ...base } = original;
    const identity = {
      ...base,
      version: base.from,
      regenerate: true,
      lastBotCommit: base.head,
    };
    const task = { ...identity, id: hash(identity) };
    const execute = vi.fn();
    const inspect = vi.fn(async () => []);
    const result = await prepareUpdate(task, { root, execute, inspect });
    expect(result.status).toBe("unchanged");
    expect(result.patch).toMatchObject({
      taskId: task.id,
      head: task.head,
      files: [],
    });
    expect(inspect).toHaveBeenCalledWith({ root, base: task.main });
    expect(result.report.testedHead).toBeNull();
    expect(result.report.gates).toContainEqual({
      name: "mechanical-preparation",
      status: "passed",
      exitCode: 0,
    });
    expect(execute).toHaveBeenCalledWith(
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      root,
    );
    expect(git("status", "--porcelain")).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(task.head);
  });
  it("does not overwrite a manual generated-file edit on the PR", () => {
    const { root, git, task } = checkout();
    writeFileSync(join(root, "THIRD-PARTY-LICENSES.txt"), "manual legal fix");
    git("add", ".");
    git("commit", "-m", "manual generated-file fix");
    expect(() =>
      checkManualEdits(root, { ...task, head: git("rev-parse", "HEAD") }),
    ).toThrow("maintainer changed");
  });
  it("refuses a generator that changes an unrelated source file", async () => {
    const { root, task } = checkout();
    const execute = (_: string, args: string[]) => {
      if (args.includes("--lockfile-only"))
        writeFileSync(join(root, "pnpm-lock.yaml"), lock("1.1.0"));
      if (args[0] === "scripts/generate-third-party-licenses.mjs")
        writeFileSync(join(root, "adapter.ts"), "unwanted change");
    };
    await expect(
      prepareUpdate(task, { root, execute, inspect: async () => [] }),
    ).rejects.toThrow("outside its declared ownership");
  });
  it("does not pass provider, App, deployment or Actions credentials to generators", () => {
    const env = cleanProcessEnv({
      PATH: "/fixture/bin",
      GH_TOKEN: "fixture",
      CURSOR_API_KEY: "fixture",
      ACTIONS_RUNTIME_TOKEN: "fixture",
      ZEROS_AGENT_GITHUB_APP_B64: "fixture",
      NODE_OPTIONS: "--import=untrusted",
    });
    expect(env).toEqual({
      PATH: "/fixture/bin",
      CI: "true",
      GIT_TERMINAL_PROMPT: "0",
    });
  });
});
