import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as outerBroker from "../credential-broker";
import { runFile } from "../git-exec";

describe("credential shim executable resolution", () => {
  let directory: string;
  let innerBroker: typeof outerBroker;
  let binaryDirectory: string;
  let actualGit: string;
  const source: outerBroker.GitCredentialSource = {
    supports: () => true,
    getCredential: async () => ({ username: "fixture", password: "fixture-only" }),
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zeros-shim-recursion-test-"));
    binaryDirectory = path.join(directory, "bin");
    await mkdir(binaryDirectory);
    outerBroker.setGitCredentialSourceForTesting(source);
    const original = await outerBroker.prepareGitCredentialShellEnvironment("outer", process.env.PATH ?? "");
    actualGit = original!.env.ZEROS_REAL_GIT_PATH!;
    await writeFile(path.join(binaryDirectory, "git"),
      '#!/bin/sh\nprintf "invoked\\n" >> "$ZEROS_TEST_GIT_LOG"\nexec "$ZEROS_TEST_GIT_BINARY" "$@"\n',
      { mode: 0o700 });
    await writeFile(path.join(binaryDirectory, "gh"), '#!/bin/sh\nprintf "gh fixture\\n"\n', { mode: 0o700 });
    vi.resetModules();
    innerBroker = await import("../credential-broker");
    innerBroker.setGitCredentialSourceForTesting(source);
  });

  afterEach(async () => {
    outerBroker.setGitCredentialSourceForTesting(null);
    innerBroker?.setGitCredentialSourceForTesting(null);
    await outerBroker.closeGitCredentialBrokerForTesting();
    await innerBroker?.closeGitCredentialBrokerForTesting();
    await rm(directory, { recursive: true, force: true });
  });

  async function outerEnvironment() {
    return (await outerBroker.prepareGitCredentialShellEnvironment("outer", `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`))!.env;
  }

  function invocationEnvironment(env: Record<string, string>) {
    return {
      ...process.env,
      ...env,
      ZEROS_TEST_GIT_LOG: path.join(directory, "git-spawns"),
      ZEROS_TEST_GIT_BINARY: actualGit,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: directory,
      XDG_CONFIG_HOME: directory,
    };
  }

  it.each([
    { label: "version", args: ["--version"], input: undefined },
    { label: "credential fill", args: ["credential", "fill"], input: "protocol=https\nhost=github.com\n\n" },
  ])("executes real Git exactly once for nested brokers: $label", async ({ args, input }) => {
    const outer = await outerEnvironment();
    const inner = (await innerBroker.prepareGitCredentialShellEnvironment("inner", outer.PATH!))!.env;
    const shim = path.join(inner.PATH!.split(path.delimiter)[0]!, "git");
    const result = await runFile(shim, args, { env: invocationEnvironment(inner), input, timeoutMs: 2_000 });

    expect(result.stdout).toContain(input ? "username=fixture" : "git version");
    expect(await readFile(path.join(directory, "git-spawns"), "utf8")).toBe("invoked\n");
    expect(inner.ZEROS_REAL_GIT_PATH).toBe(path.join(binaryDirectory, "git"));
    expect(inner.ZEROS_REAL_GH_PATH).toBe(path.join(binaryDirectory, "gh"));
    expect(inner.PATH!.split(path.delimiter).filter((entry) => path.basename(entry).startsWith("zeros-git-auth-"))).toHaveLength(1);
  });

  it.each(["directory symlink", "executable symlink", "copied executable"])("skips shims reached through a %s", async (kind) => {
    const outer = await outerEnvironment();
    const outerDirectory = outer.PATH!.split(path.delimiter)[0]!;
    const alias = path.join(directory, "alias");
    if (kind === "directory symlink") {
      await symlink(outerDirectory, alias);
    } else {
      await mkdir(alias);
      for (const name of ["git", "gh"]) {
        if (kind === "executable symlink") await symlink(path.join(outerDirectory, name), path.join(alias, name));
        else await copyFile(path.join(outerDirectory, name), path.join(alias, name));
      }
    }
    const inner = (await innerBroker.prepareGitCredentialShellEnvironment("inner", `${alias}${path.delimiter}${outer.PATH}`))!.env;
    expect(inner.ZEROS_REAL_GIT_PATH).toBe(path.join(binaryDirectory, "git"));
    expect(inner.ZEROS_REAL_GH_PATH).toBe(path.join(binaryDirectory, "gh"));
    if (kind === "directory symlink") expect(inner.PATH!.split(path.delimiter)).not.toContain(alias);
  });

  it.each(["git", "gh"])("rejects a self-referencing %s even after the broker dies", async (name) => {
    const env = await outerEnvironment();
    const shim = path.join(env.PATH!.split(path.delimiter)[0]!, name);
    await expect(runFile(shim, name === "git" ? ["--version"] : ["auth", "status"], {
      env: {
        ...invocationEnvironment(env),
        [name === "git" ? "ZEROS_REAL_GIT_PATH" : "ZEROS_REAL_GH_PATH"]: shim,
        ZEROS_GIT_AUTH_BROKER_PID: "2147483647",
      },
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ code: 126, stderr: expect.stringContaining("recursive executable") });
  });

  const modes = process.platform === "linux" ? ["local", "cloud"] : ["local"];
  it.each(modes)("preserves a normal %s invocation and its credential helper", async (mode) => {
    const uid = process.getuid?.() || 10_001;
    const gid = process.getgid?.() || 10_001;
    const prepared = (await innerBroker.prepareGitCredentialShellEnvironment("inner", `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      mode === "cloud" ? { uid, gid } : undefined))!.env;
    const shim = path.join(prepared.PATH!.split(path.delimiter)[0]!, "git");
    const env = invocationEnvironment(prepared);
    const version = await runFile(shim, ["--version"], { env, timeoutMs: 2_000 });
    const credential = await runFile(shim, ["credential", "fill"], {
      env, input: "protocol=https\nhost=github.com\n\n", timeoutMs: 2_000,
    });
    expect(version.stdout).toContain("git version");
    expect(credential.stdout).toBe("protocol=https\nhost=github.com\nusername=fixture\npassword=fixture-only\n");
    expect(await readFile(path.join(directory, "git-spawns"), "utf8")).toBe("invoked\ninvoked\n");
    expect(prepared.ZEROS_GIT_AUTH_BROKER_PID).toBe(mode === "local" ? String(process.pid) : undefined);
  });

  it.each(modes.flatMap((mode) => [22, 28].map((status) => ({ mode, status }))))(
    "keeps a live $mode broker fail-closed after curl exit $status",
    async ({ mode, status }) => {
      const uid = process.getuid?.() || 10_001;
      const gid = process.getgid?.() || 10_001;
      const prepared = (await innerBroker.prepareGitCredentialShellEnvironment("inner", `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        mode === "cloud" ? { uid, gid } : undefined))!.env;
      await writeFile(path.join(binaryDirectory, "curl"), `#!/bin/sh\nexit ${status}\n`, { mode: 0o700 });
      const helper = path.join(directory, "ambient-helper");
      const sentinel = path.join(directory, "ambient-invoked");
      await writeFile(helper, `#!/bin/sh\nprintf 'invoked\\n' >> '${sentinel}'\nprintf 'username=ambient\\npassword=fixture-only\\n'\n`, { mode: 0o700 });
      await writeFile(path.join(directory, ".gitconfig"), `[credential]\n\thelper = ${helper}\n`);
      const shim = path.join(prepared.PATH!.split(path.delimiter)[0]!, "git");
      await expect(runFile(shim, ["credential", "fill"], {
        env: invocationEnvironment(prepared), input: "protocol=https\nhost=github.com\n\n", timeoutMs: 2_000,
      })).rejects.toMatchObject({ code: 128 });
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(directory, "git-spawns"), "utf8")).toBe("invoked\n");
    },
  );
});
