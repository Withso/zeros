import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureLoginShellPathRunner,
  getLoginShellPath,
  loginShellPathGeneration,
  resetLoginShellPathForTests,
} from "../login-shell-path";

afterEach(() => {
  resetLoginShellPathForTests();
  vi.unstubAllEnvs();
});

describe("login-shell PATH execution boundary", () => {
  it("uses the configured ZSR runner for shell startup bytes", async () => {
    const run = vi.fn(async () => ({
      stdout: "/opt/homebrew/bin:/usr/bin:/bin\n",
    }));
    configureLoginShellPathRunner({ cacheKey: "zsr-test", run });

    await expect(getLoginShellPath()).resolves.toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
    expect(run).toHaveBeenCalledWith(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", `printf '%s\\n' "$PATH"`],
      { timeoutMs: 3_000 },
    );
  });

  it("falls back without caching the first bounded-runner failure", async () => {
    const inherited = process.env.PATH ?? "";
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("sandbox unavailable"))
      .mockResolvedValueOnce({ stdout: "/safe/toolchain:/usr/bin\n" });
    configureLoginShellPathRunner({ cacheKey: "zsr-retry", run });

    await expect(getLoginShellPath()).resolves.toBe(inherited);
    await expect(getLoginShellPath()).resolves.toBe(
      "/safe/toolchain:/usr/bin",
    );
    expect(run).toHaveBeenCalledTimes(2);
  });
});

const execFileAsync = promisify(execFile);

describe("login-shell PATH recovery", () => {
  it("re-probes a changed shell profile after the cached PATH misses a command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-shell-path-"));
    try {
      const shell = path.join(root, "shell");
      const profile = path.join(root, "profile-path");
      await writeFile(shell, '#!/bin/sh\n/bin/cat "$0.path"\n');
      await chmod(shell, 0o755);
      await writeFile(`${shell}.path`, "/old/toolchain:/usr/bin\n");
      vi.stubEnv("SHELL", shell);
      expect(await getLoginShellPath()).toBe("/old/toolchain:/usr/bin");
      await writeFile(`${shell}.path`, `${profile}:/usr/bin\n`);
      expect(await getLoginShellPath()).toBe("/old/toolchain:/usr/bin");

      expect(await getLoginShellPath({ refresh: true })).toBe(`${profile}:/usr/bin`);
      expect(await getLoginShellPath()).toBe(`${profile}:/usr/bin`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers after the cold-boot probe budget cached the inherited PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-shell-path-"));
    try {
      const shell = path.join(root, "shell");
      await writeFile(shell, '#!/bin/sh\n/bin/cat "$0.path" 2>/dev/null\n');
      await chmod(shell, 0o755);
      vi.stubEnv("SHELL", shell);
      vi.stubEnv("PATH", "/inherited/path");
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await getLoginShellPath()).toBe("/inherited/path");
      }
      await writeFile(`${shell}.path`, "/installed/toolchain:/usr/bin\n");
      expect(await getLoginShellPath()).toBe("/inherited/path");

      expect(await getLoginShellPath({ refresh: true })).toBe("/installed/toolchain:/usr/bin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent refreshes without letting a retired runner overwrite the new cache", async () => {
    let finishOld!: (result: { stdout: string }) => void;
    configureLoginShellPathRunner({
      cacheKey: "old-engine",
      run: () => new Promise((resolve) => { finishOld = resolve; }),
    });
    const old = getLoginShellPath();
    const run = vi.fn(async () => ({ stdout: "/new/engine/bin\n" }));
    configureLoginShellPathRunner({ cacheKey: "new-engine", run });
    await Promise.all([getLoginShellPath({ refresh: true }), getLoginShellPath({ refresh: true })]);
    expect(run).toHaveBeenCalledTimes(1);
    finishOld({ stdout: "/old/engine/bin\n" });
    await old;
    expect(await getLoginShellPath()).toBe("/new/engine/bin");
  });

  it("offers Retry after repeated probe timeouts and recovers on the next request", async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    configureLoginShellPathRunner({ cacheKey: "slow-shell", run });
    await getLoginShellPath();

    await expect(getLoginShellPath({ refresh: true })).rejects.toThrow("Zeros couldn't load your shell PATH");
    run.mockResolvedValue({ stdout: "/recovered/bin:/usr/bin\n" });
    expect(await getLoginShellPath({ refresh: true })).toBe("/recovered/bin:/usr/bin");
  });

  it("shares a failed refresh across stale starts and retains the last confirmed PATH", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "/confirmed/bin:/usr/bin\n" })
      .mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    configureLoginShellPathRunner({ cacheKey: "confirmed-before-timeout", run });
    await getLoginShellPath();
    const generation = loginShellPathGeneration();
    expect(await getLoginShellPath({ refresh: true, ifGeneration: generation })).toBe("/confirmed/bin:/usr/bin");
    expect(await getLoginShellPath({ refresh: true, ifGeneration: generation })).toBe("/confirmed/bin:/usr/bin");
    expect(run).toHaveBeenCalledTimes(2);
    await expect(getLoginShellPath({ refresh: true })).rejects.toThrow("Zeros couldn't load your shell PATH");
    expect(await getLoginShellPath()).toBe("/confirmed/bin:/usr/bin");
  });
});

describe("login-shell PATH probe output", () => {
  // `echo '/opt/homebrew/bin\n/opt/homebrew/sbin' | sudo tee /etc/paths.d/homebrew`
  // writes the backslash literally, and path_helper adds that line to PATH as
  // one entry. The `echo` of zsh, dash and macOS /bin/sh expands it, so the
  // probe returned only the text after it and repository scripts failed with
  // "node: command not found".
  const inherited = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    String.raw`/opt/homebrew/bin\n/opt/homebrew/sbin`,
  ].join(":");

  // macOS engines meet zsh and /bin/sh; Linux cloud engines meet bash and dash.
  for (const shell of ["/bin/zsh", "/bin/sh", "/bin/bash", "/bin/dash"]) {
    it.skipIf(!existsSync(shell))(
      `returns a PATH entry containing a backslash intact through ${shell}`,
      async () => {
        configureLoginShellPathRunner({
          cacheKey: `real-shell:${shell}`,
          // The real probe command with startup files disabled. Bash can treat
          // Node's socket stdin as a remote invocation and read .bashrc otherwise.
          run: async (_shell, args) => {
            const startupFlags = shell === "/bin/zsh" ? ["-f"]
              : shell === "/bin/bash" ? ["--norc"] : [];
            const { stdout } = await execFileAsync(
              shell,
              [...startupFlags, "-c", args.at(-1)!],
              { env: { PATH: inherited } },
            );
            return { stdout };
          },
        });

        await expect(getLoginShellPath()).resolves.toBe(inherited);
      },
    );
  }
});
