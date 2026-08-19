// Unit + integration coverage for runGit's transient-lock retry. The retry
// exists because "Local main" is now an editable workspace: multiple agents
// can run in the SAME checkout and briefly contend for .git/index.lock, and
// git exits non-zero without mutating anything when it can't take the lock.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import {
  classifyGitTransportError,
  isGitLockContention,
  runFile,
  runGit,
} from "../git-exec";
import {
  closeGitCredentialBrokerForTesting,
  prepareGitCredentialInvocation,
  prepareGitCredentialShellEnvironment,
  setGitCredentialSourceForTesting,
} from "../credential-broker";

const execFileAsync = promisify(execFile);

async function serveGitHttpBackend(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  projectRoot: string;
}): Promise<void> {
  const requestUrl = new URL(opts.req.url ?? "/", "http://localhost");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: opts.projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: requestUrl.pathname,
      QUERY_STRING: requestUrl.search.slice(1),
      REQUEST_METHOD: opts.req.method ?? "GET",
      CONTENT_TYPE: opts.req.headers["content-type"] ?? "",
      CONTENT_LENGTH: opts.req.headers["content-length"] ?? "",
      REMOTE_USER: "x-access-token",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  opts.req.pipe(child.stdin);

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    opts.res.statusCode = 500;
    opts.res.end(Buffer.concat(stderr).toString("utf8"));
    return;
  }

  const response = Buffer.concat(stdout);
  let headerEnd = response.indexOf("\r\n\r\n");
  let separatorLength = 4;
  if (headerEnd < 0) {
    headerEnd = response.indexOf("\n\n");
    separatorLength = 2;
  }
  if (headerEnd < 0) {
    opts.res.statusCode = 500;
    opts.res.end("git http-backend returned no CGI headers");
    return;
  }

  const headerText = response.subarray(0, headerEnd).toString("utf8");
  for (const line of headerText.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === "status") {
      opts.res.statusCode = Number.parseInt(value, 10);
    } else {
      opts.res.setHeader(name, value);
    }
  }
  opts.res.end(response.subarray(headerEnd + separatorLength));
}

async function startAuthenticatedGitServer(opts: {
  projectRoot: string;
  password: string;
}): Promise<{
  url: string;
  observed: Array<{ username: string; password: string }>;
  close(): Promise<void>;
}> {
  const observed: Array<{ username: string; password: string }> = [];
  const server = createServer(async (req, res) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Basic ")) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Zeros test"' });
      res.end("authentication required");
      return;
    }
    const decoded = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    const separator = decoded.indexOf(":");
    const credential = {
      username: separator >= 0 ? decoded.slice(0, separator) : decoded,
      password: separator >= 0 ? decoded.slice(separator + 1) : "",
    };
    observed.push(credential);
    if (
      credential.username !== "x-access-token" ||
      credential.password !== opts.password
    ) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Zeros test"' });
      res.end("bad credential");
      return;
    }
    await serveGitHttpBackend({
      req,
      res,
      projectRoot: opts.projectRoot,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test git server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/remote.git`,
    observed,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("isGitLockContention", () => {
  it("matches transient lock contention (safe to retry)", () => {
    expect(
      isGitLockContention(
        "fatal: Unable to create '/r/.git/index.lock': File exists.",
      ),
    ).toBe(true);
    expect(
      isGitLockContention(
        "Another git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'.",
      ),
    ).toBe(true);
    expect(
      isGitLockContention(
        "error: cannot lock ref 'refs/heads/main': unable to",
      ),
    ).toBe(true);
    expect(
      isGitLockContention(
        "fatal: Unable to create '/r/.git/refs/heads/x.lock': File exists",
      ),
    ).toBe(true);
    expect(
      isGitLockContention("error: could not lock config file .git/config"),
    ).toBe(true);
  });

  it("does NOT match real failures (must surface, never retry)", () => {
    expect(
      isGitLockContention("error: pathspec 'x' did not match any file(s)"),
    ).toBe(false);
    expect(
      isGitLockContention("CONFLICT (content): Merge conflict in a.txt"),
    ).toBe(false);
    expect(isGitLockContention("nothing to commit, working tree clean")).toBe(
      false,
    );
    expect(isGitLockContention("fatal: not a git repository")).toBe(false);
    expect(isGitLockContention("")).toBe(false);
  });
});

describe("classifyGitTransportError", () => {
  it.each([
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: could not read Password for 'https://github.com': No such device or address",
    "remote: Invalid username or password.\nfatal: Authentication failed",
    "git@github.com: Permission denied (publickey).",
    "remote: HTTP Basic: Access denied",
    // GitHub answers a revoked token — and a repo outside the GitHub App's
    // installation — with "not found", never a 403. This is the most common
    // shape an auth failure actually takes, and missing it cost the reconnect
    // affordance and the one-shot rotation retry.
    "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    "remote: Write access to repository not granted.",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
  ])("recognizes authentication failures: %s", (stderr) => {
    expect(classifyGitTransportError(stderr)).toBe("NOT_AUTHENTICATED");
  });

  it.each([
    "fatal: unable to access: Could not resolve host: github.com",
    "fatal: unable to access: Failed to connect to github.com",
    "ssh: connect to host github.com port 22: Network is unreachable",
    "fatal: unable to access: Operation timed out",
    "fatal: unable to access 'https://github.com/o/r.git/': server certificate verification failed. CAfile: none",
    "fatal: the remote end hung up unexpectedly\nerror: RPC failed; curl 56 recv failure",
    "fatal: early EOF",
    "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 503",
  ])("recognizes network failures: %s", (stderr) => {
    expect(classifyGitTransportError(stderr)).toBe("NETWORK_ERROR");
  });

  it("leaves unrelated git failures to the caller", () => {
    expect(
      classifyGitTransportError(
        "error: failed to push some refs because the tip is behind",
      ),
    ).toBeUndefined();
  });

  // These used to be read as auth failures, which both told the user to
  // reconnect GitHub and triggered a GitHub App refresh-token rotation for a
  // failure that had nothing to do with credentials.
  it.each([
    "error: unable to unlink old 'src/a.ts': Permission denied",
    "error: object file .git/objects/40/3f9e is empty",
    "fatal: pack has 401 unresolved deltas",
  ])("does not read a local failure as an auth failure: %s", (stderr) => {
    expect(classifyGitTransportError(stderr)).not.toBe("NOT_AUTHENTICATED");
  });
});

describe("runFile — Bun native subprocess boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Bun.spawn with bounded pipes, timeout, env, and binary stdin", async () => {
    const spawn = vi.fn(
      (_command: string[], _options: Record<string, unknown>) => ({
        stdout: new Response("native stdout").body,
        stderr: new Response("native stderr").body,
        exited: Promise.resolve(0),
        signalCode: null,
        killed: false,
      }),
    );
    vi.stubGlobal("Bun", { spawn });

    await expect(
      runFile("git", ["status", "--short"], {
        cwd: "/tmp/example",
        env: { PATH: "/usr/bin" },
        input: "patch body",
        maxBufferBytes: 1234,
        timeoutMs: 5678,
      }),
    ).resolves.toEqual({
      stdout: "native stdout",
      stderr: "native stderr",
    });

    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0]!;
    expect(command).toEqual(["git", "status", "--short"]);
    expect(options).toMatchObject({
      cwd: "/tmp/example",
      env: { PATH: "/usr/bin" },
      stdout: "pipe",
      stderr: "pipe",
      maxBuffer: 1234,
      timeout: 5678,
      killSignal: "SIGKILL",
    });
    expect(new TextDecoder().decode(options.stdin as Uint8Array)).toBe(
      "patch body",
    );
  });

  it("retains exit details when a native subprocess fails", async () => {
    const spawn = vi.fn(
      (_command: string[], _options: Record<string, unknown>) => ({
        stdout: new Response("partial output").body,
        stderr: new Response("fatal: worktree is locked").body,
        exited: Promise.resolve(7),
        signalCode: null,
        killed: false,
      }),
    );
    vi.stubGlobal("Bun", { spawn });

    await expect(runFile("git", ["worktree", "remove"])).rejects.toMatchObject({
      code: 7,
      signal: null,
      killed: false,
      stdout: "partial output",
      stderr: "fatal: worktree is locked",
    });
  });

  it("kills a Bun subprocess when its owning capability is aborted", async () => {
    let finish!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const kill = vi.fn(() => finish(137));
    vi.stubGlobal("Bun", {
      spawn: vi.fn(() => ({
        stdout: new Response("").body,
        stderr: new Response("").body,
        exited,
        signalCode: "SIGKILL",
        killed: true,
        kill,
      })),
    });
    const controller = new AbortController();
    const running = runFile("git", ["fetch", "origin"], {
      signal: controller.signal,
    });

    controller.abort(new Error("capability revoked"));

    await expect(running).rejects.toThrow("capability revoked");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("cancels a Node subprocess through AbortSignal", async () => {
    vi.stubGlobal("Bun", undefined);
    const controller = new AbortController();
    const running = runFile(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { signal: controller.signal, timeoutMs: 5_000 },
    );
    controller.abort(new Error("capability revoked"));

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("runGit — transient lock retry", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zeros-gitexec-test-"));
    repo = path.join(dir, "repo");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repo });
    await writeFile(path.join(repo, "a.txt"), "a\n");
    await execFileAsync("git", ["add", "."], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  });

  afterEach(async () => {
    delete process.env.ZEROS_TEST_GIT_SSH_COMMAND;
    setGitCredentialSourceForTesting(null);
    await closeGitCredentialBrokerForTesting();
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("retries then surfaces a bounded GIT_COMMAND_FAILED when index.lock is held", async () => {
    // A held (here, stale) index.lock makes git refuse to write the index —
    // the same failure a concurrent agent's git op would produce.
    await writeFile(path.join(repo, ".git", "index.lock"), "");
    await writeFile(path.join(repo, "b.txt"), "b\n");

    const start = Date.now();
    await expect(runGit(repo, ["add", "b.txt"])).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED",
    });
    // It retried (so spent at least one backoff window) but still RETURNED —
    // i.e. the retry is bounded and never hangs.
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });

  it("succeeds normally when there is no lock (retry path is a no-op)", async () => {
    await writeFile(path.join(repo, "c.txt"), "c\n");
    const res = await runGit(repo, ["add", "c.txt"]);
    expect(res.stdout).toBe("");
  });

  it("never executes a repository hook with engine authority", async () => {
    const sentinel = path.join(dir, "pre-commit-ran");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, `#!/bin/sh\nprintf ran > '${sentinel}'\n`, "utf8");
    await chmod(hook, 0o700);
    await writeFile(path.join(repo, "hook.txt"), "safe\n");

    await runGit(repo, ["add", "hook.txt"]);
    await runGit(repo, ["commit", "-m", "engine commit"]);

    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a command-line alias before repository bytes can run", async () => {
    const sentinel = path.join(dir, "alias-ran");
    const executable = path.join(dir, "alias-command");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\n`,
      "utf8",
    );
    await chmod(executable, 0o700);

    await expect(
      runGit(repo, ["-c", `alias.pwn=!${executable}`, "pwn"]),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages bytes without running a configured clean filter", async () => {
    const sentinel = path.join(dir, "filter-ran");
    const executable = path.join(dir, "clean-filter");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\ncat\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    await execFileAsync(
      "git",
      ["config", "filter.zeros-engine.clean", executable],
      { cwd: repo },
    );
    await execFileAsync(
      "git",
      ["config", "filter.zeros-engine.required", "true"],
      { cwd: repo },
    );
    await writeFile(
      path.join(repo, ".gitattributes"),
      "*.asset filter=zeros-engine\n",
    );
    await writeFile(path.join(repo, "safe.asset"), "original bytes\n");

    await runGit(repo, ["add", ".gitattributes", "safe.asset"]);

    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    const staged = await runGit(repo, ["show", ":safe.asset"]);
    expect(staged.stdout).toBe("original bytes\n");
  });

  it("strips an external diff program from the inherited and caller env", async () => {
    const sentinel = path.join(dir, "external-diff-ran");
    const executable = path.join(dir, "external-diff");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    await writeFile(path.join(repo, "a.txt"), "changed\n");
    process.env.GIT_EXTERNAL_DIFF = executable;
    try {
      const result = await runGit(repo, ["diff", "--", "a.txt"], {
        env: { GIT_EXTERNAL_DIFF: executable },
      });
      expect(result.stdout).toContain("-a");
      expect(result.stdout).toContain("+changed");
    } finally {
      delete process.env.GIT_EXTERNAL_DIFF;
    }
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke an unknown remote helper from PATH", async () => {
    const sentinel = path.join(dir, "remote-helper-ran");
    const bin = path.join(dir, "bin");
    const executable = path.join(bin, "git-remote-pwn");
    await mkdir(bin, { recursive: true });
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\nexit 1\n`,
      "utf8",
    );
    await chmod(executable, 0o700);

    await expect(
      runGit(repo, ["ls-remote", "pwn::payload"], {
        env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke a configured fsmonitor hook", async () => {
    const sentinel = path.join(dir, "fsmonitor-ran");
    const executable = path.join(dir, "fsmonitor");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    // Warm the policy cache before changing the canonical config. The second
    // call must fingerprint-invalidate it rather than trusting stale keys.
    await runGit(repo, ["status", "--short"]);
    await execFileAsync("git", ["config", "core.fsmonitor", executable], {
      cwd: repo,
    });

    await runGit(repo, ["status", "--short"]);

    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke a configured merge driver", async () => {
    const sentinel = path.join(dir, "merge-driver-ran");
    const executable = path.join(dir, "merge-driver");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\nexit 1\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    await execFileAsync(
      "git",
      ["config", "merge.zeros-engine.driver", `${executable} %O %A %B`],
      { cwd: repo },
    );
    await writeFile(
      path.join(repo, ".gitattributes"),
      "merge.txt merge=zeros-engine\n",
    );
    await writeFile(path.join(repo, "merge.txt"), "base\n");
    await execFileAsync("git", ["add", ".gitattributes", "merge.txt"], {
      cwd: repo,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "merge base"], {
      cwd: repo,
    });
    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], {
      cwd: repo,
    });
    await writeFile(path.join(repo, "merge.txt"), "feature\n");
    await execFileAsync("git", ["commit", "-qam", "feature"], { cwd: repo });
    await execFileAsync("git", ["checkout", "-q", "main"], { cwd: repo });
    await writeFile(path.join(repo, "merge.txt"), "main\n");
    await execFileAsync("git", ["commit", "-qam", "main"], { cwd: repo });

    const result = await runGit(repo, ["merge", "feature"], {
      treatAsExpected: ["conflict"],
    });

    expect(result.expectedError).toBe("conflict");
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke configured signing programs", async () => {
    const sentinel = path.join(dir, "gpg-ran");
    const executable = path.join(dir, "fake-gpg");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\nexit 1\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    await execFileAsync("git", ["config", "commit.gpgSign", "true"], {
      cwd: repo,
    });
    await execFileAsync("git", ["config", "gpg.program", executable], {
      cwd: repo,
    });
    await writeFile(path.join(repo, "unsigned.txt"), "safe\n");

    await runGit(repo, ["add", "unsigned.txt"]);
    await runGit(repo, ["commit", "-m", "unsigned engine commit"]);

    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a config include that resolves into code territory", async () => {
    const sentinel = path.join(dir, "included-config-ran");
    const executable = path.join(repo, "included-fsmonitor");
    const includedConfig = path.join(repo, "agent-writable.config");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\n`,
      "utf8",
    );
    await chmod(executable, 0o700);
    await writeFile(
      includedConfig,
      `[core]\n\tfsmonitor = ${executable}\n`,
      "utf8",
    );
    await runGit(repo, ["status", "--short"]);
    await execFileAsync("git", ["config", "include.path", includedConfig], {
      cwd: repo,
    });

    await expect(runGit(repo, ["status", "--short"])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a custom upload-pack before it can run", async () => {
    const sentinel = path.join(dir, "upload-pack-ran");
    const executable = path.join(dir, "upload-pack");
    await writeFile(
      executable,
      `#!/bin/sh\nprintf ran > '${sentinel}'\nexit 1\n`,
      "utf8",
    );
    await chmod(executable, 0o700);

    await expect(
      runGit(repo, ["fetch", `--upload-pack=${executable}`, repo]),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("authenticates a real HTTP git push through the broker and resets stale helpers", async () => {
    const remoteRoot = path.join(dir, "http-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", [
      "--git-dir",
      bareRemote,
      "config",
      "http.receivepack",
      "true",
    ]);

    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "broker-secret",
    });
    const staleHelper = path.join(dir, "stale-helper");
    const staleHelperLog = path.join(dir, "stale-helper.log");
    await writeFile(
      staleHelper,
      `#!/bin/sh\nprintf 'called\\n' >> '${staleHelperLog}'\nprintf 'username=wrong\\npassword=wrong\\n'\n`,
    );
    await chmod(staleHelper, 0o700);
    await execFileAsync("git", ["config", "credential.helper", staleHelper], {
      cwd: repo,
    });
    await execFileAsync("git", ["remote", "add", "origin", server.url], {
      cwd: repo,
    });

    let credentialReads = 0;
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "http" && host === "127.0.0.1";
      },
      async getCredential() {
        credentialReads += 1;
        return {
          username: "x-access-token",
          password: "broker-secret",
        };
      },
    });

    try {
      await expect(
        runGit(repo, ["push", "-u", "origin", "main"], {
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ stdout: expect.any(String) });
      expect(credentialReads).toBeGreaterThan(0);
      expect(server.observed).toContainEqual({
        username: "x-access-token",
        password: "broker-secret",
      });
      await expect(readFile(staleHelperLog, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await server.close();
    }
  });

  it("authenticates a pull through the current branch's configured upstream", async () => {
    const remoteRoot = path.join(dir, "http-pull-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", [
      "--git-dir",
      bareRemote,
      "config",
      "http.receivepack",
      "true",
    ]);
    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "pull-secret",
    });
    await execFileAsync("git", ["remote", "add", "origin", server.url], {
      cwd: repo,
    });

    let credentialReads = 0;
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "http" && host === "127.0.0.1";
      },
      async getCredential() {
        credentialReads += 1;
        return {
          username: "x-access-token",
          password: "pull-secret",
        };
      },
    });

    try {
      await runGit(repo, ["push", "-u", "origin", "main"], {
        timeoutMs: 10_000,
      });
      credentialReads = 0;
      server.observed.length = 0;

      await expect(
        runGit(repo, ["pull", "--ff-only"], { timeoutMs: 10_000 }),
      ).resolves.toMatchObject({ stdout: expect.any(String) });
      expect(credentialReads).toBeGreaterThan(0);
      expect(server.observed).toContainEqual({
        username: "x-access-token",
        password: "pull-secret",
      });
    } finally {
      await server.close();
    }
  });

  it("brokers an admitted non-GitHub credential through the user's global helper", async () => {
    const remoteRoot = path.join(dir, "ambient-http-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    const hostHome = path.join(dir, "host-home");
    const helper = path.join(dir, "ambient-helper");
    const helperLog = path.join(dir, "ambient-helper.log");
    await Promise.all([
      mkdir(remoteRoot, { recursive: true }),
      mkdir(hostHome, { recursive: true }),
    ]);
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", [
      "--git-dir",
      bareRemote,
      "config",
      "http.receivepack",
      "true",
    ]);
    await writeFile(
      helper,
      [
        "#!/bin/sh",
        `printf 'called\\n' >> '${helperLog}'`,
        '[ "${1:-}" = get ] || exit 0',
        "printf 'username=x-access-token\\npassword=ambient-secret\\n'",
        "",
      ].join("\n"),
    );
    await chmod(helper, 0o700);
    await writeFile(
      path.join(hostHome, ".gitconfig"),
      `[credential]\n\thelper = ${helper}\n`,
    );
    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "ambient-secret",
    });
    await execFileAsync("git", ["remote", "add", "origin", server.url], {
      cwd: repo,
    });

    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = hostHome;
    delete process.env.XDG_CONFIG_HOME;
    try {
      await expect(
        runGit(repo, ["push", "-u", "origin", "main"], {
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ stdout: expect.any(String) });
      expect(server.observed).toContainEqual({
        username: "x-access-token",
        password: "ambient-secret",
      });
      expect((await readFile(helperLog, "utf8")).trim().split("\n")).toEqual([
        "called",
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      await server.close();
    }
  });

  it("scopes and revokes an ambient credential capability exactly", async () => {
    const hostHome = path.join(dir, "ambient-capability-home");
    const helper = path.join(dir, "ambient-capability-helper");
    await mkdir(hostHome, { recursive: true });
    await writeFile(
      helper,
      [
        "#!/bin/sh",
        '[ "${1:-}" = get ] || exit 0',
        "printf 'username=ambient-user\\npassword=ambient-capability-secret\\n'",
        "",
      ].join("\n"),
    );
    await chmod(helper, 0o700);
    await writeFile(
      path.join(hostHome, ".gitconfig"),
      `[credential]\n\thelper = ${helper}\n`,
    );
    const { stdout: gitBinaryOutput } = await execFileAsync("which", ["git"]);
    const invocation = await prepareGitCredentialInvocation(
      {
        contextId: "workspace:ambient-capability",
        protocol: "https",
        host: "example.com",
        authority: "example.com",
        username: "ambient-user",
        path: "owner/repo.git",
      },
      {
        ambient: {
          gitBinary: gitBinaryOutput.trim(),
          home: hostHome,
        },
      },
    );
    expect(invocation).not.toBeNull();
    expect(Object.values(invocation!.env)).not.toContain(
      "ambient-capability-secret",
    );
    const askpass = invocation!.env.GIT_ASKPASS;
    const exactEnv = { ...process.env, ...invocation!.env };
    const exact = await runFile(
      askpass,
      ["Password for 'https://ambient-user@example.com': "],
      { env: exactEnv },
    );
    expect(exact.stdout.trim()).toBe("ambient-capability-secret");

    const mismatchedEnvironments: Array<Record<string, string | undefined>> = [
      { ...exactEnv, ZEROS_GIT_AUTH_HOST: "example.org" },
      { ...exactEnv, ZEROS_GIT_AUTH_PATH: "other/repo.git" },
      { ...exactEnv, ZEROS_GIT_AUTH_CONTEXT: "workspace:other" },
    ];
    for (const env of mismatchedEnvironments) {
      const promptHost = env.ZEROS_GIT_AUTH_HOST ?? "example.com";
      await expect(
        runFile(
          askpass,
          [`Password for 'https://ambient-user@${promptHost}': `],
          { env },
        ),
      ).rejects.toSatisfy(
        (error: unknown) =>
          !JSON.stringify(error).includes("ambient-capability-secret"),
      );
    }

    invocation!.release?.();
    await expect(
      runFile(askpass, ["Password for 'https://ambient-user@example.com': "], {
        env: exactEnv,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        !JSON.stringify(error).includes("ambient-capability-secret"),
    );
  });

  it("uses the fixed SSH transport while ignoring repository SSH commands", async () => {
    const remoteRoot = path.join(dir, "ssh-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    const fakeSsh = path.join(dir, "fake-ssh");
    const maliciousSsh = path.join(dir, "malicious-ssh");
    const maliciousLog = path.join(dir, "malicious-ssh.log");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await writeFile(
      fakeSsh,
      [
        "#!/bin/sh",
        'if [ "$1" = -G ]; then exit 0; fi',
        "command=",
        'for value in "$@"; do command="$value"; done',
        'case "$command" in',
        "  'git-upload-pack '*|'git-receive-pack '*) exec /bin/sh -c \"$command\" ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await writeFile(
      maliciousSsh,
      `#!/bin/sh\nprintf ran > '${maliciousLog}'\nexit 1\n`,
    );
    await Promise.all([chmod(fakeSsh, 0o700), chmod(maliciousSsh, 0o700)]);
    await execFileAsync(
      "git",
      ["remote", "add", "origin", `ssh://example.invalid${bareRemote}`],
      { cwd: repo },
    );
    await execFileAsync("git", ["config", "core.sshCommand", maliciousSsh], {
      cwd: repo,
    });
    process.env.ZEROS_TEST_GIT_SSH_COMMAND = fakeSsh;

    await expect(
      runGit(repo, ["push", "origin", "main"], { timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ stdout: expect.any(String) });

    await expect(stat(maliciousLog)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await execFileAsync("git", [
          "--git-dir",
          bareRemote,
          "rev-parse",
          "refs/heads/main",
        ])
      ).stdout.trim(),
    ).toBe(
      (
        await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })
      ).stdout.trim(),
    );
  });

  it("refuses an embedded remote credential when the broker owns that host", async () => {
    const remoteRoot = path.join(dir, "http-embedded-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", [
      "--git-dir",
      bareRemote,
      "config",
      "http.receivepack",
      "true",
    ]);
    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "broker-secret",
    });
    const embeddedUrl = server.url.replace(
      "http://",
      "http://legacy-user:embedded-secret@",
    );
    await execFileAsync("git", ["remote", "add", "origin", embeddedUrl], {
      cwd: repo,
    });
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "http" && host === "127.0.0.1";
      },
      async getCredential() {
        return {
          username: "x-access-token",
          password: "broker-secret",
        };
      },
    });

    try {
      await expect(
        runGit(repo, ["push", "-u", "origin", "main"], {
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/embedded password/i),
      });
      expect(server.observed).toEqual([]);

      // A username with NO password is not a bypass — it is the common legacy
      // remote form, and git simply asks the broker for the password. Refusing
      // it made push/fetch/ls-remote/Create PR all fail on those repos.
      await execFileAsync(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          server.url.replace("http://", "http://legacy-user@"),
        ],
        { cwd: repo },
      );
      await runGit(repo, ["push", "-u", "origin", "main"], {
        timeoutMs: 10_000,
      });
      // The broker answered the password prompt, so the push really reached the
      // server rather than being refused before it started.
      expect(server.observed.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("refreshes one rejected broker credential and retries the git operation once", async () => {
    const remoteRoot = path.join(dir, "http-refresh-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", [
      "--git-dir",
      bareRemote,
      "config",
      "http.receivepack",
      "true",
    ]);
    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "rotated-secret",
    });
    await execFileAsync("git", ["remote", "add", "origin", server.url], {
      cwd: repo,
    });

    let token = "rejected-secret";
    const refresh = vi.fn(async () => {
      token = "rotated-secret";
      return true;
    });
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "http" && host === "127.0.0.1";
      },
      async getCredential() {
        return {
          username: "x-access-token",
          password: token,
        };
      },
      async credentialFingerprint() {
        return token;
      },
      refreshAfterAuthenticationFailure: refresh,
    });

    try {
      await expect(
        runGit(repo, ["push", "-u", "origin", "main"], {
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ stdout: expect.any(String) });
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: "http",
          host: "127.0.0.1",
        }),
        "rejected-secret",
      );
      expect(server.observed).toContainEqual({
        username: "x-access-token",
        password: "rejected-secret",
      });
      expect(server.observed).toContainEqual({
        username: "x-access-token",
        password: "rotated-secret",
      });
    } finally {
      await server.close();
    }
  });

  it("finds the remote after network options that take separate values", async () => {
    const remoteRoot = path.join(dir, "http-options-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", ["push", bareRemote, "main:main"], {
      cwd: repo,
    });
    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "option-secret",
    });
    const fetchRepo = path.join(dir, "fetch-repo");
    await mkdir(fetchRepo, { recursive: true });
    await execFileAsync("git", ["init", "-q", fetchRepo]);
    await execFileAsync("git", ["remote", "add", "origin", server.url], {
      cwd: fetchRepo,
    });
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "http" && host === "127.0.0.1";
      },
      async getCredential() {
        return {
          username: "x-access-token",
          password: "option-secret",
        };
      },
    });

    try {
      await expect(
        runGit(fetchRepo, ["fetch", "--depth", "1", "origin"], {
          timeoutMs: 10_000,
        }),
      ).resolves.toMatchObject({ stdout: expect.any(String) });
      await expect(
        execFileAsync(
          "git",
          ["rev-parse", "--verify", "refs/remotes/origin/main"],
          { cwd: fetchRepo },
        ),
      ).resolves.toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("fails fast without a credential instead of prompting", async () => {
    const remoteRoot = path.join(dir, "http-empty-root");
    const bareRemote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", bareRemote]);
    await execFileAsync("git", [
      "--git-dir",
      bareRemote,
      "config",
      "http.receivepack",
      "true",
    ]);
    const server = await startAuthenticatedGitServer({
      projectRoot: remoteRoot,
      password: "unused",
    });
    await execFileAsync("git", ["remote", "add", "origin", server.url], {
      cwd: repo,
    });
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "http" && host === "127.0.0.1";
      },
      async getCredential() {
        return null;
      },
    });

    const startedAt = Date.now();
    try {
      await expect(
        runGit(repo, ["push", "-u", "origin", "main"], {
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({
        code: "GIT_COMMAND_FAILED",
        context: {
          stderr: expect.stringMatching(
            /terminal prompts disabled|could not read Username|authentication failed/i,
          ),
        },
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await server.close();
    }
  });
});

describe("runGit — constrained child environment", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zeros-gitenv-test-"));
    repo = path.join(dir, "repo");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await writeFile(path.join(repo, "tracked.txt"), "tracked\n");
  });

  afterEach(async () => {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
    delete process.env.GIT_INDEX_FILE;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("keeps the narrow snapshot author/committer environment contract", async () => {
    await runGit(repo, ["add", "tracked.txt"]);
    const tree = (await runGit(repo, ["write-tree"])).stdout.trim();
    const commit = (
      await runGit(repo, ["commit-tree", tree, "-m", "snapshot"], {
        env: {
          GIT_AUTHOR_NAME: "Snapshot Author",
          GIT_AUTHOR_EMAIL: "author@zeros.invalid",
          GIT_COMMITTER_NAME: "Snapshot Committer",
          GIT_COMMITTER_EMAIL: "committer@zeros.invalid",
        },
      })
    ).stdout.trim();

    const object = await runGit(repo, ["cat-file", "-p", commit]);
    expect(object.stdout).toContain(
      "author Snapshot Author <author@zeros.invalid>",
    );
    expect(object.stdout).toContain(
      "committer Snapshot Committer <committer@zeros.invalid>",
    );
  });

  it("strips GIT_CONFIG_COUNT injection from process and caller env", async () => {
    const sentinel = path.join(dir, "config-env-ran");
    const fsmonitor = path.join(dir, "fsmonitor");
    await writeFile(
      fsmonitor,
      `#!/bin/sh\nprintf ran > '${sentinel}'\n`,
      "utf8",
    );
    await chmod(fsmonitor, 0o700);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    process.env.GIT_CONFIG_VALUE_0 = fsmonitor;

    await runGit(repo, ["status", "--short"], {
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: fsmonitor,
      },
    });

    await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not inherit a process-level Git index redirect", async () => {
    const redirectedIndex = path.join(dir, "attacker-index");
    process.env.GIT_INDEX_FILE = redirectedIndex;

    await runGit(repo, ["add", "tracked.txt"]);

    await expect(stat(redirectedIndex)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(runGit(repo, ["show", ":tracked.txt"])).resolves.toMatchObject(
      {
        stdout: "tracked\n",
      },
    );
  });
});

describe("workspace git/gh credential shims", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zeros-git-shims-test-"));
  });

  afterEach(async () => {
    setGitCredentialSourceForTesting(null);
    await closeGitCredentialBrokerForTesting();
    await rm(dir, { recursive: true, force: true });
  });

  it("projects a broker read-only to the qualified cloud worker identity", async () => {
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "https" && host === "github.com";
      },
      async getCredential() {
        return { username: "x-access-token", password: "worker-secret" };
      },
    });
    const prepared = await prepareGitCredentialShellEnvironment(
      "workspace:test",
      process.env.PATH ?? "",
      {
        uid: process.getuid?.() ?? 1_000,
        gid: process.getgid?.() ?? 1_000,
      },
    );
    expect(prepared).not.toBeNull();

    const socket = prepared!.env.ZEROS_GIT_AUTH_SOCKET;
    const helper = prepared!.env.ZEROS_GIT_AUTH_HELPER;
    const socketDir = await stat(path.dirname(socket));
    const socketStat = await stat(socket);
    const helperDir = await stat(path.dirname(helper));
    const helperStat = await stat(helper);
    expect(socketDir.mode & 0o777).toBe(0o710);
    expect(socketStat.mode & 0o777).toBe(0o660);
    expect(helperDir.mode & 0o777).toBe(0o750);
    expect(helperStat.mode & 0o777).toBe(0o750);
  });

  it("serves the current credential to GitHub without putting it in the shell environment", async () => {
    let token = "first-broker-secret";
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "https" && host === "github.com";
      },
      async getCredential() {
        return { username: "x-access-token", password: token };
      },
    });

    const prepared = await prepareGitCredentialShellEnvironment(
      "workspace:test",
      process.env.PATH ?? "",
    );
    expect(prepared).not.toBeNull();
    const env = {
      ...process.env,
      ...prepared!.env,
    };
    expect(Object.values(prepared!.env).join("\n")).not.toContain(token);
    const shimDir = prepared!.env.PATH.split(path.delimiter)[0]!;
    const gitShim = path.join(shimDir, "git");

    const first = await runFile(gitShim, ["credential", "fill"], {
      env,
      input: "protocol=https\nhost=github.com\n\n",
    });
    expect(first.stdout).toContain("username=x-access-token");
    expect(first.stdout).toContain("password=first-broker-secret");

    token = "rotated-broker-secret";
    const rotated = await runFile(gitShim, ["credential", "fill"], {
      env,
      input: "protocol=https\nhost=github.com\n\n",
    });
    expect(rotated.stdout).toContain("password=rotated-broker-secret");
    expect(rotated.stdout).not.toContain("first-broker-secret");
  });

  it("keeps the user's normal credential helper for non-GitHub hosts", async () => {
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "https" && host === "github.com";
      },
      async getCredential() {
        return {
          username: "x-access-token",
          password: "github-only-secret",
        };
      },
    });
    const fallbackHelper = path.join(dir, "fallback-helper");
    await writeFile(
      fallbackHelper,
      "#!/bin/sh\nprintf 'username=fallback\\npassword=other-host\\n'\n",
    );
    await chmod(fallbackHelper, 0o700);
    const prepared = await prepareGitCredentialShellEnvironment(
      "workspace:test",
      process.env.PATH ?? "",
    );
    const env = { ...process.env, ...prepared!.env };
    const gitShim = path.join(
      prepared!.env.PATH.split(path.delimiter)[0]!,
      "git",
    );

    const result = await runFile(
      gitShim,
      ["-c", `credential.helper=${fallbackHelper}`, "credential", "fill"],
      {
        env,
        input: "protocol=https\nhost=gitlab.com\n\n",
      },
    );
    expect(result.stdout).toContain("username=fallback");
    expect(result.stdout).toContain("password=other-host");
    expect(result.stdout).not.toContain("github-only-secret");
  });

  it("fails closed for an owned GitHub host while its credential is absent", async () => {
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "https" && host === "github.com";
      },
      async shouldHandle() {
        return true;
      },
      async getCredential() {
        return null;
      },
    });
    const fallbackHelper = path.join(dir, "fallback-helper");
    const fallbackLog = path.join(dir, "fallback-helper.log");
    await writeFile(
      fallbackHelper,
      `#!/bin/sh\nprintf 'called\\n' >> '${fallbackLog}'\nprintf 'username=ambient\\npassword=ambient-secret\\n'\n`,
    );
    await chmod(fallbackHelper, 0o700);
    const prepared = await prepareGitCredentialShellEnvironment(
      "workspace:test",
      process.env.PATH ?? "",
    );
    const env = { ...process.env, ...prepared!.env };
    const gitShim = path.join(
      prepared!.env.PATH.split(path.delimiter)[0]!,
      "git",
    );

    await expect(
      runFile(
        gitShim,
        ["-c", `credential.helper=${fallbackHelper}`, "credential", "fill"],
        {
          env,
          input: "protocol=https\nhost=github.com\n\n",
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/told us to quit/i),
    });
    await expect(readFile(fallbackLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // GIT_ASKPASS is process-global and is inherited by child git processes,
  // unlike the URL-scoped credential helper. A redirect target, a submodule, or
  // an LFS remote on a second host reaches the askpass, so it must answer only
  // for the authority its invocation was scoped to.
  it("refuses to hand the selected credential to a second host via GIT_ASKPASS", async () => {
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "https" && host === "github.com";
      },
      async getCredential() {
        return { username: "x-access-token", password: "owned-host-secret" };
      },
    });
    const invocation = await prepareGitCredentialInvocation({
      contextId: "workspace:test",
      protocol: "https",
      host: "github.com",
      authority: "github.com",
    });
    const askpass = invocation!.env.GIT_ASKPASS!;
    const env = { ...process.env, ...invocation!.env };

    // The owned host still gets both fields — git asks for them separately.
    const password = await runFile(
      askpass,
      ["Password for 'https://x-access-token@github.com': "],
      { env },
    );
    expect(password.stdout.trim()).toBe("owned-host-secret");
    const username = await runFile(
      askpass,
      ["Username for 'https://github.com': "],
      { env },
    );
    expect(username.stdout.trim()).toBe("x-access-token");

    for (const prompt of [
      "Password for 'https://x-access-token@gitlab.com': ",
      "Username for 'https://gitlab.com': ",
      // A lookalike host must not satisfy the scope check by suffix.
      "Password for 'https://x-access-token@github.com.evil.example': ",
    ]) {
      await expect(runFile(askpass, [prompt], { env })).rejects.toMatchObject({
        stdout: expect.not.stringContaining("owned-host-secret"),
      });
    }
  });

  it("serves a provider-specific username for a GitLab credential context", async () => {
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return (
          protocol === "https" &&
          (host === "github.com" || host === "gitlab.com")
        );
      },
      async getCredential({ host }) {
        return host === "gitlab.com"
          ? { username: "oauth2", password: "gitlab-oauth-secret" }
          : null;
      },
    });
    const prepared = await prepareGitCredentialShellEnvironment(
      "workspace:test",
      process.env.PATH ?? "",
    );
    expect(prepared).not.toBeNull();

    const result = await runFile(prepared!.env.ZEROS_GIT_AUTH_HELPER, ["get"], {
      env: { ...process.env, ...prepared!.env },
      input: "protocol=https\nhost=gitlab.com\n\n",
    });
    expect(result.stdout).toContain("username=oauth2");
    expect(result.stdout).toContain("password=gitlab-oauth-secret");
  });

  it("gives gh the selected token only for the real gh child", async () => {
    let token: string | null = "gh-child-only-secret";
    setGitCredentialSourceForTesting({
      supports({ protocol, host }) {
        return protocol === "https" && host === "github.com";
      },
      async shouldHandle() {
        return true;
      },
      async getCredential() {
        return token ? { username: "x-access-token", password: token } : null;
      },
    });
    const fakeGh = path.join(dir, "real-gh");
    await writeFile(
      fakeGh,
      '#!/bin/sh\nprintf \'token=%s\\nargs=%s\\n\' "${GH_TOKEN-}" "$*"\n',
    );
    await chmod(fakeGh, 0o700);
    const prepared = await prepareGitCredentialShellEnvironment(
      "workspace:test",
      process.env.PATH ?? "",
    );
    expect(Object.values(prepared!.env).join("\n")).not.toContain(
      "gh-child-only-secret",
    );
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...prepared!.env,
      ZEROS_REAL_GH_PATH: fakeGh,
    };
    delete env.GH_TOKEN;
    const ghShim = path.join(
      prepared!.env.PATH.split(path.delimiter)[0]!,
      "gh",
    );

    const connected = await runFile(ghShim, ["pr", "status"], { env });
    expect(connected.stdout).toBe(
      "token=gh-child-only-secret\nargs=pr status\n",
    );
    expect(env.GH_TOKEN).toBeUndefined();

    const authManagement = await runFile(ghShim, ["auth", "login"], { env });
    expect(authManagement.stdout).toBe("token=\nargs=auth login\n");

    token = null;
    await expect(
      runFile(ghShim, ["pr", "status"], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /no usable credential.*selected GitHub authentication method/i,
      ),
    });
    const disconnected = await runFile(ghShim, ["auth", "status"], { env });
    expect(disconnected.stdout).toBe("token=\nargs=auth status\n");
  });
});
