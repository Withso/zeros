import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HostExecutionBoundary } from "../host-boundary";
import type { AgentFilesystemTerritory } from "../../types";

const territory: AgentFilesystemTerritory = {
  agentRole: "code",
  workspaceRoot: "/work/repo",
  designDirectory: "/work/repo/Zeros Design",
  protectedDesignDirectories: ["/work/repo/Zeros Design"],
  designRecognitionPaths: [],
  writeCapabilities: {
    workspace: "write",
    deniedPaths: ["/work/repo/Zeros Design"],
  },
};

describe("host execution boundary", () => {
  it("reports ordinary code-only work as unrestricted and not requiring containment", async () => {
    const boundary = new HostExecutionBoundary();
    const prepared = await boundary.prepare({
      executionId: "code-only",
      actor: "agent-code",
      cwd: "/work/repo",
      workspaceRoot: "/work/repo",
      containerWorkflowExpected: true,
    });

    expect(prepared.status).toMatchObject({
      state: "not-required",
      backend: "none",
      designProtection: {
        required: false,
        enforced: false,
        protectedDirectoryCount: 0,
      },
      parity: { level: "full", restrictions: [] },
      git: { state: "native" },
    });
    const launch = prepared.wrapSpawn({
      command: "/bin/sh",
      args: ["-lc", "true"],
      cwd: "/work/repo",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(launch).toMatchObject({
      command: process.execPath,
      cwd: "/work/repo",
      stdio: "pipe",
    });
    expect(launch.args.slice(-4)).toEqual(["--", "/bin/sh", "-lc", "true"]);
    expect(launch.env.PATH).toBe("/usr/bin:/bin");
    await prepared.stopAndProve();
  });

  it("does not claim a kernel deny for a legacy territory-bearing request", async () => {
    const prepared = await new HostExecutionBoundary().prepare({
      executionId: "sparse-design",
      actor: "agent-code",
      cwd: "/work/repo",
      workspaceRoot: "/work/repo",
      territory,
    });

    expect(prepared.status).toMatchObject({
      state: "ready",
      backend: "none",
      designProtection: {
        required: true,
        enforced: false,
        protectedDirectoryCount: 1,
      },
      parity: { level: "full", restrictions: [] },
    });
    await prepared.stopAndProve();
  });

  it("tracks and proves shutdown of a host process group", async () => {
    if (process.platform === "win32") return;
    const prepared = await new HostExecutionBoundary().prepare({
      executionId: "host-process",
      actor: "agent-code",
      cwd: process.cwd(),
      workspaceRoot: process.cwd(),
    });
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    expect(child.pid).toBeTypeOf("number");
    prepared.trackProcess(child);

    await prepared.stopAndProve();
    expect(() => process.kill(-(child.pid as number), 0)).toThrow();
  });

  it("durably adopts PTY-style process groups before returning authority", async () => {
    if (process.platform === "win32") return;
    const dataRoot = await mkdtemp(path.join(tmpdir(), "zeros-host-adoption-"));
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    let prepared: Awaited<ReturnType<HostExecutionBoundary["prepare"]>> | null =
      null;
    try {
      prepared = await new HostExecutionBoundary().prepare({
        executionId: "pty-host-process",
        actor: "repo-code-task",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      const launch = prepared.wrapSpawn({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdio: "inherit",
      });
      const child = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        detached: true,
        stdio: "ignore",
      });
      expect(child.pid).toBeTypeOf("number");
      prepared.trackProcessGroup(child.pid as number);

      const launches = await readdir(
        path.join(
          dataRoot,
          "sessions",
          "pty-host-process",
          "boundary",
          prepared.generation,
          "launches",
        ),
      );
      expect(launches).toHaveLength(1);
      expect(
        JSON.parse(
          await readFile(
            path.join(
              dataRoot,
              "sessions",
              "pty-host-process",
              "boundary",
              prepared.generation,
              "launches",
              launches[0]!,
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({ pid: child.pid });
    } finally {
      await prepared?.stopAndProve().catch(() => undefined);
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("launches when a trusted PTY host is the supervisor's immediate parent", async () => {
    if (process.platform === "win32") return;
    const dataRoot = await mkdtemp(path.join(tmpdir(), "zeros-host-pty-parent-"));
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    let prepared: Awaited<ReturnType<HostExecutionBoundary["prepare"]>> | null =
      null;
    let relay: ReturnType<typeof spawn> | null = null;
    try {
      prepared = await new HostExecutionBoundary().prepare({
        executionId: "pty-intermediate-parent",
        actor: "repo-code-task",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      const launch = prepared.wrapSpawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write('target-ready\\n')"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdio: "inherit",
      });
      expect(launch.immediateParentPidArgIndex).toBeTypeOf("number");
      const relaySource = [
        'const { spawn } = require("node:child_process");',
        "const command = process.argv[1];",
        "const args = JSON.parse(process.argv[2]);",
        "const parentPidArgIndex = Number(process.argv[3]);",
        "args[parentPidArgIndex] = String(process.pid);",
        "const child = spawn(command, args, {",
        "  cwd: process.cwd(),",
        "  env: process.env,",
        "  detached: true,",
        '  stdio: ["ignore", "pipe", "pipe"],',
        "});",
        'process.stdout.write(`supervisor:${child.pid}\\n`);',
        "child.stdout.pipe(process.stdout);",
        "child.stderr.pipe(process.stderr);",
        "child.once(\"exit\", (code) => process.exit(code ?? 125));",
      ].join("\n");
      relay = spawn(
        process.execPath,
        [
          "-e",
          relaySource,
          launch.command,
          JSON.stringify(launch.args),
          String(launch.immediateParentPidArgIndex),
        ],
        {
          cwd: launch.cwd,
          env: { ...launch.env },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      relay.stdout?.setEncoding("utf8");
      relay.stderr?.setEncoding("utf8");
      relay.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      relay.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exit = await new Promise<number | null>((resolve) => {
        relay!.once("exit", resolve);
      });

      expect({ exit, stdout, stderr }).toMatchObject({
        exit: 0,
        stdout: expect.stringContaining("target-ready"),
        stderr: "",
      });
    } finally {
      if (relay?.pid) relay.kill("SIGKILL");
      await prepared?.stopAndProve().catch(() => undefined);
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("discards a launch descriptor when the supervisor cannot receive a pid", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "zeros-host-no-pid-"));
    const supervisorRuntime = path.join(dataRoot, "ephemeral-runtime");
    await writeFile(supervisorRuntime, "ephemeral");
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    let prepared: Awaited<ReturnType<HostExecutionBoundary["prepare"]>> | null =
      null;
    try {
      prepared = await new HostExecutionBoundary({ supervisorRuntime }).prepare({
        executionId: "host-no-pid",
        actor: "agent-code",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      // The runtime was valid at admission but disappeared before spawn (for
      // example, an app update replaced its resource tree).
      await rm(supervisorRuntime);

      await expect(
        prepared.spawn({
          command: process.execPath,
          args: [],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "" },
        }),
      ).rejects.toThrow(/did not receive a process id/i);

      await expect(
        readdir(
          path.join(
            dataRoot,
            "sessions",
            "host-no-pid",
            "boundary",
            prepared.generation,
            "commands",
          ),
        ),
      ).resolves.toEqual([]);
    } finally {
      await prepared?.stopAndProve().catch(() => undefined);
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("launches through a physical lifecycle tree reached by a canonicalizing parent symlink", async () => {
    if (process.platform === "win32") return;
    const fixtureRoot = await mkdtemp(
      path.join(tmpdir(), "zeros-host-canonical-parent-"),
    );
    const physicalDataRoot = path.join(fixtureRoot, "physical-data");
    const aliasDataRoot = path.join(fixtureRoot, "data-alias");
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    await mkdir(physicalDataRoot);
    await symlink(physicalDataRoot, aliasDataRoot, "dir");
    process.env.ZEROS_DATA_DIR = aliasDataRoot;
    let prepared: Awaited<ReturnType<HostExecutionBoundary["prepare"]>> | null =
      null;
    try {
      prepared = await new HostExecutionBoundary().prepare({
        executionId: "canonical-parent",
        actor: "agent-code",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      const tracked = await prepared.spawn({
        command: process.execPath,
        args: ["-e", "process.stdout.write('ready\\n')"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdio: "pipe",
      });
      const output = await new Promise<string>((resolve, reject) => {
        let value = "";
        tracked.stdout?.on("data", (chunk: Buffer | string) => {
          value += chunk.toString();
        });
        tracked.wait().then(
          () => resolve(value),
          (error) => reject(error),
        );
      });
      expect(output).toBe("ready\n");
    } finally {
      await prepared?.stopAndProve().catch(() => undefined);
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("durably recovers a native process group after its owning engine crashes", async () => {
    if (process.platform === "win32") return;
    const dataRoot = await mkdtemp(path.join(tmpdir(), "zeros-host-recovery-"));
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    const deadOwnerPid = 2_147_483_647;
    let prepared: Awaited<ReturnType<HostExecutionBoundary["prepare"]>> | null =
      null;
    try {
      const boundary = new HostExecutionBoundary({
        projectRoot: process.cwd(),
        ownerProcessId: deadOwnerPid,
      });
      prepared = await boundary.prepare({
        executionId: "crashed-host-process",
        actor: "agent-code",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      const tracked = await prepared.spawn({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify([process.env.ZEROS_HOST_SUPERVISOR_FIXTURE, process.env.ELECTRON_RUN_AS_NODE]) + '\\n'); setInterval(() => {}, 1000)",
        ],
        cwd: process.cwd(),
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
          ZEROS_HOST_SUPERVISOR_FIXTURE: "preserved",
          ELECTRON_RUN_AS_NODE: "target-value",
        },
        stdio: "pipe",
      });
      const firstLine = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("native target did not become ready")),
          2_000,
        );
        tracked.stdout?.on("data", (chunk: Buffer | string) => {
          output += chunk.toString();
          const newline = output.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timer);
          resolve(output.slice(0, newline));
        });
      });
      expect(JSON.parse(firstLine)).toEqual(["preserved", "target-value"]);

      const recovery = await new HostExecutionBoundary({
        projectRoot: process.cwd(),
      }).recoverStaleProcesses();

      expect(recovery).toEqual({
        discovered: 1,
        recovered: 1,
        active: 0,
        preserved: 0,
      });
      expect(() => process.kill(-tracked.pid, 0)).toThrow();
    } finally {
      await prepared?.stopAndProve().catch(() => undefined);
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("does not mistake a reused live pid for the generation's original engine", async () => {
    if (process.platform === "win32") return;
    const dataRoot = await mkdtemp(
      path.join(tmpdir(), "zeros-host-pid-reuse-"),
    );
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    let prepared: Awaited<ReturnType<HostExecutionBoundary["prepare"]>> | null =
      null;
    try {
      prepared = await new HostExecutionBoundary({
        projectRoot: process.cwd(),
      }).prepare({
        executionId: "reused-owner",
        actor: "agent-code",
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
      });
      const descriptor = path.join(
        dataRoot,
        "sessions",
        "reused-owner",
        "boundary",
        prepared.generation,
        "host-boundary.json",
      );
      const record = JSON.parse(await readFile(descriptor, "utf8")) as {
        ownerStartToken: string | null;
      };
      record.ownerStartToken = "different-boot:different-process";
      await writeFile(descriptor, JSON.stringify(record), { mode: 0o600 });

      await expect(
        new HostExecutionBoundary({
          projectRoot: process.cwd(),
        }).recoverStaleProcesses(),
      ).resolves.toEqual({
        discovered: 1,
        recovered: 1,
        active: 0,
        preserved: 0,
      });
    } finally {
      await prepared?.stopAndProve().catch(() => undefined);
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("preserves malformed native recovery evidence without blocking app startup", async () => {
    const dataRoot = await mkdtemp(
      path.join(tmpdir(), "zeros-host-malformed-"),
    );
    const previousDataRoot = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    try {
      const generation = path.join(
        dataRoot,
        "sessions",
        "malformed-host",
        "boundary",
        "host-malformed",
      );
      await mkdir(generation, { recursive: true });
      await writeFile(path.join(generation, "host-boundary.json"), "{}", {
        mode: 0o600,
      });

      await expect(
        new HostExecutionBoundary({
          projectRoot: process.cwd(),
        }).recoverStaleProcesses(),
      ).resolves.toEqual({
        discovered: 1,
        recovered: 0,
        active: 0,
        preserved: 1,
      });
      await expect(
        readFile(path.join(generation, "host-boundary.json"), "utf8"),
      ).resolves.toBe("{}");
    } finally {
      if (previousDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataRoot;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
