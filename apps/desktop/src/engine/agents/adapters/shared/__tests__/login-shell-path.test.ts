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
      ["-ilc", "echo $PATH"],
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
