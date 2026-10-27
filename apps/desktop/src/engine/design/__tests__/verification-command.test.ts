import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDesignVerificationService } from "../verification-service";

describe("Design verification command", () => {
  let root: string;
  let workspace: string;
  let service: Awaited<ReturnType<typeof startDesignVerificationService>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-command-"));
    workspace = path.join(root, "person's worktree");
    await mkdir(workspace);
    service = await startDesignVerificationService({ renderer: () => undefined });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  });

  function commandFor(runtime: {
    execPath: string;
    entry?: string;
    execArgv?: string[];
    bun?: string;
  }): string {
    vi.stubGlobal("process", Object.create(process, {
      execPath: { value: runtime.execPath },
      argv: { value: [runtime.execPath, runtime.entry] },
      execArgv: { value: runtime.execArgv ?? [] },
      versions: { value: { ...process.versions, bun: runtime.bun } },
    }));
    try {
      return service.register({
        workspaceId: "workspace",
        workspacePath: workspace,
        directory: "Example - Design",
        directoryId: "design_example",
      }).command;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it.each([
    { name: "Bun source", bun: "1.3.13", extension: "mjs", execArgv: [] },
    { name: "Node source with a loader", bun: undefined, extension: "ts", execArgv: ["--import", "tsx"] },
  ])("runs the supplied $name command from the task workspace", async ({ bun, extension, execArgv }) => {
    const entry = path.join(root, `engine's entry.${extension}`);
    await writeFile(entry, [
      // The enum needs the source loader even on Node versions with type stripping.
      extension === "ts" ? 'enum Command { Design = "design" }' : 'const Command = { Design: "design" };',
      'if (process.argv[2] !== Command.Design) throw new Error("Wrong command namespace");',
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));',
    ].join("\n"));
    // Exercise the real generated shell command with a Node-backed source
    // fixture and Bun's process shape; the suite does not require Bun installed.
    const command = commandFor({ execPath: process.execPath, entry, execArgv, bun });
    const result = spawnSync("/bin/sh", ["-c", `${command} --help`], {
      cwd: workspace, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["design", "--help"], cwd: workspace });
  });

  it.each(["missing", "executable", "virtual"] as const)("runs the compiled sidecar with a %s entry", async (kind) => {
    const executable = path.join(root, "Zeros app's engine");
    await writeFile(executable, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 });
    const entry = kind === "missing" ? undefined : kind === "executable" ? executable : "/$bunfs/root/cli.ts";
    const command = commandFor({ execPath: executable, entry, bun: "1.3.13", execArgv: ["--smol"] });
    const result = spawnSync("/bin/sh", ["-c", `${command} --help`], {
      cwd: workspace, encoding: "utf8", timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("<design>\n<--help>\n");
  });
});
