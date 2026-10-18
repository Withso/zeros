import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureLoginShellPathRunner,
  getLoginShellPath,
  resetLoginShellPathForTests,
} from "../login-shell-path";

afterEach(() => {
  resetLoginShellPathForTests();
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
          // The real probe command, without -i/-l so no startup file runs.
          run: async (_shell, args) => {
            const { stdout } = await execFileAsync(
              shell,
              [...(shell === "/bin/zsh" ? ["-f"] : []), "-c", args.at(-1)!],
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
