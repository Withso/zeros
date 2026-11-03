import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionId } from "@zeros/protocol/run-actions";

import {
  configureLoginShellPathRunner,
  getLoginShellPath,
  resetLoginShellPathForTests,
} from "../../agents/adapters/shared/login-shell-path";
import type { PreparedBoundary } from "../../agents/containment/types";
import { closeState, setStateRootForTesting } from "../../git/state";
import { SetupManager } from "../../git/setup-runner";
import { RunManager } from "../../run/run-manager";
import { PtyService, type PtyHandle, type PtySpawnRequest } from "../service";

let root: string;
let bin: string;
let shell: string;
const services: PtyService[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-command-path-"));
  bin = path.join(root, "new-bin");
  shell = path.join(root, "sh");
  await mkdir(bin);
  await writeFile(shell, '#!/bin/sh\n/bin/cat "$0.path"\n');
  await chmod(shell, 0o755);
  await writeFile(`${shell}.path`, "/usr/bin:/bin\n");
  vi.stubEnv("SHELL", shell);
  setStateRootForTesting(path.join(root, "state"));
  expect(await getLoginShellPath()).toBe("/usr/bin:/bin");
  await writeFile(`${shell}.path`, `${bin}:/usr/bin:/bin\n`);
});

afterEach(async () => {
  for (const service of services.splice(0)) service.killAll();
  closeState();
  setStateRootForTesting(null);
  resetLoginShellPathForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function installTool(
  body = 'printf "ran\\n" >> "$MARKER"\n',
): Promise<void> {
  await writeFile(path.join(bin, "zeros-new-tool"), `#!/bin/sh\n${body}`);
  await chmod(path.join(bin, "zeros-new-tool"), 0o755);
}

function processTerminal(request: PtySpawnRequest): PtyHandle {
  const child = spawn("/bin/sh", ["-c", request.command!], {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    get pid() {
      return child.pid ?? 0;
    },
    onSpawned: (callback) => callback(child.pid!),
    onData: (callback) => {
      child.stdout.on("data", (data) => callback(String(data)));
      child.stderr.on("data", (data) => callback(String(data)));
    },
    onExit: (callback) => {
      child.once("close", (code, signal) => callback(code, signal ? 15 : null));
    },
    write: (data) => {
      child.stdin.write(data);
    },
    resize: () => {},
    kill: () => {
      child.kill();
    },
  };
}

function startCommand(
  kind: "setup" | "run",
  command: string,
  owner: string,
  backend = "none",
  pathPrefix = "",
) {
  const launches: PtySpawnRequest[] = [];
  const terminal = new PtyService(root, (request) => {
    launches.push(request);
    return processTerminal(request);
  });
  services.push(terminal);
  const envBuilder = async () => ({
    PATH: `${pathPrefix}${await getLoginShellPath()}`,
    MARKER: path.join(root, "effects"),
    OWNER: owner,
  });

  const boundary = async () =>
    ({
      status: { backend },
      wrapSpawn: (request: unknown) => request,
      trackProcessGroup: () => ({}),
      revoke: async () => {},
      stopAndProve: async () => {},
    }) as unknown as PreparedBoundary;
  const setup = new SetupManager(terminal, () => {}, envBuilder, boundary);
  const run = new RunManager(
    terminal,
    () => {},
    undefined,
    envBuilder,
    boundary,
  );
  const output: string[] = [];
  const exits: Array<number | null> = [];
  terminal.onData((id, data) => {
    output.push(data);
    setup.appendData(id, data);
    run.appendData(id, data);
  });
  const ended = new Promise<void>((resolve) =>
    terminal.onExit((id, code, signal) => {
      exits.push(code);
      setup.handleExit(id, code, signal);
      run.handleExit(id, code, signal);
      resolve();
    }),
  );
  const started =
    kind === "setup"
      ? setup.start({
          workspaceId: owner,
          command,
          target: { cwd: root, repoRoot: root, baseBranch: "main" },
        })
      : run.start({
          sessionId: runSessionId(root, owner),
          workspaceId: null,
          actionId: owner,
          command,
          oneShot: true,
          cwd: root,
        });
  const stop = () =>
    kind === "setup" ? setup.stop(owner) : run.stop(runSessionId(root, owner));
  return {
    started,
    ended,
    launches,
    output,
    exits,
    terminal,
    setup,
    run,
    stop,
  };
}

describe.each(["setup", "run"] as const)(
  "%s login-shell PATH recovery",
  (kind) => {
    it("keeps explicit PATH additions while refreshing the inherited toolchain", async () => {
      await installTool();
      const customBin = path.join(root, "session-bin");
      await mkdir(customBin);
      const task = startCommand(
        kind,
        "zeros-new-tool",
        "local-personal",
        "none",
        `${customBin}:`,
      );
      await task.started;
      await task.ended;
      expect(task.launches[1]!.env!.PATH).toBe(
        `${customBin}:${bin}:/usr/bin:/bin`,
      );
    });

    it.each(["local-personal", "organization-local"])(
      "retries a missing command once for %s using the real probe/cache",
      async (owner) => {
        await installTool();
        const task = startCommand(kind, "zeros-new-tool", owner);
        await task.started;
        await task.ended;
        expect(task.exits).toEqual([0]);
        expect(task.launches).toHaveLength(2);
        expect(await readFile(path.join(root, "effects"), "utf8")).toBe(
          "ran\n",
        );
        expect(task.launches[1]!.env).toEqual({
          PATH: `${bin}:/usr/bin:/bin`,
          MARKER: path.join(root, "effects"),
          OWNER: owner,
        });
        expect(task.output.join("")).not.toContain("not found");
      },
    );

    it("does not replay a script that performed effects before returning 127", async () => {
      await installTool('printf "ran\\n" >> "$MARKER"\nexit 127\n');
      await getLoginShellPath({ refresh: true });
      const task = startCommand(kind, "zeros-new-tool", "local-personal");
      await task.started;
      await task.ended;
      expect(task.exits).toEqual([127]);
      expect(task.launches).toHaveLength(1);
      expect(await readFile(path.join(root, "effects"), "utf8")).toBe("ran\n");
    });

    it("does not replay compound commands after earlier effects", async () => {
      const task = startCommand(
        kind,
        'printf "ran\\n" >> "$MARKER"; zeros-new-tool',
        "local-personal",
      );
      await task.started;
      await task.ended;
      expect(task.exits).toEqual([127]);
      expect(task.launches).toHaveLength(1);
      expect(await readFile(path.join(root, "effects"), "utf8")).toBe("ran\n");
    });

    it("does not replay argument substitutions with side effects", async () => {
      const task = startCommand(
        kind,
        'zeros-new-tool "$(printf \'expanded\\n\' >> "$MARKER")"',
        "local-personal",
      );
      await task.started;
      await task.ended;
      expect(task.exits).toEqual([127]);
      expect(task.launches).toHaveLength(1);
      expect(await readFile(path.join(root, "effects"), "utf8")).toBe(
        "expanded\n",
      );
    });

    it("stops after the one retry when the executable is still missing", async () => {
      const task = startCommand(kind, "zeros-new-tool", "local-personal");
      await task.started;
      await task.ended;
      expect(task.exits).toEqual([127]);
      expect(task.launches).toHaveLength(2);
      expect(task.output.join("")).toContain("not found");
    });

    it("honors Stop while the recovery probe is held", async () => {
      let finishProbe!: (result: { stdout: string }) => void;
      let entered!: () => void;
      const probing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const runProbe = vi
        .fn()
        .mockResolvedValueOnce({ stdout: "/usr/bin:/bin\n" })
        .mockImplementationOnce(() => {
          entered();
          return new Promise((resolve) => {
            finishProbe = resolve;
          });
        });
      configureLoginShellPathRunner({
        cacheKey: "held-refresh",
        run: runProbe,
      });
      await getLoginShellPath();
      await installTool();
      const task = startCommand(kind, "zeros-new-tool", "local-personal");
      await task.started;
      await probing;
      expect(task.exits).toEqual([]);
      task.stop();
      await task.ended;
      finishProbe({ stdout: `${bin}:/usr/bin:/bin\n` });
      await getLoginShellPath();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(task.launches).toHaveLength(1);
      await expect(
        readFile(path.join(root, "effects"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("shows actionable text only when the recovery probe keeps timing out", async () => {
      const runProbe = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        );
      configureLoginShellPathRunner({
        cacheKey: "timed-out-shell",
        run: runProbe,
      });
      vi.stubEnv("PATH", "/usr/bin:/bin");
      for (let attempt = 0; attempt < 3; attempt++) await getLoginShellPath();
      const task = startCommand(kind, "zeros-new-tool", "local-personal");
      await task.started;
      await task.ended;
      expect(task.exits).toEqual([127]);
      expect(task.launches).toHaveLength(1);
      expect(task.output.join("")).toContain(
        "Zeros couldn't load your shell PATH",
      );
      expect(task.output.join("")).toContain("Retry");
      expect(task.output.join("")).not.toContain("zeros-path-miss");
      expect(runProbe).toHaveBeenCalledTimes(4);
    });

    it("does not apply Local PATH recovery to a non-native boundary", async () => {
      await installTool();
      const task = startCommand(
        kind,
        "zeros-new-tool",
        "organization-cloud",
        "oci",
      );
      await task.started;
      await task.ended;
      expect(task.exits).toEqual([127]);
      expect(task.launches).toHaveLength(1);
      expect(await getLoginShellPath()).toBe("/usr/bin:/bin");
    });
  },
);
