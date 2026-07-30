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

// The env git receives is composed of three layers and the ORDER is load-bearing:
// a launcher-PRUNED copy of process.env, then the caller's `opts.env`, then the
// engine's own auth vars last so nothing can redirect the credential helper.
// Those first two arrived from different branches — the prune from the terminal
// work, the auth vars from the credential broker — and nothing else in the suite
// pinned them TOGETHER. Collapsing back to either single layer would be silent:
// git would re-inherit the launching `pnpm run` context (so a repo's pre-commit
// hook resolves the user's linters to Zeros' pinned copies), or lose opts.env.
describe("runGit — child env composition", () => {
  let dir: string;
  let repo: string;
  const LAUNCHER = {
    npm_execpath: "/usr/local/lib/pnpm.cjs",
    npm_lifecycle_event: "electron:dev",
    npm_config_verify_deps_before_run: "install",
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "zeros-gitenv-test-"));
    repo = path.join(dir, "repo");
    await mkdir(repo, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  });

  afterEach(async () => {
    for (const key of Object.keys(LAUNCHER)) delete process.env[key];
    delete process.env.ZEROS_GITENV_PROBE;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  /** git's OWN child env, read back through a `!`-prefixed alias — the same
   *  shell git hands a hook, so this observes what actually escapes. */
  async function childEnv(
    callerEnv?: Record<string, string | undefined>,
  ): Promise<Record<string, string>> {
    const res = await runGit(
      repo,
      ["-c", "alias.dumpenv=!env", "dumpenv"],
      callerEnv ? { env: callerEnv } : {},
    );
    const out: Record<string, string> = {};
    for (const line of res.stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  it("prunes the launching script's context out of git's own children", async () => {
    Object.assign(process.env, LAUNCHER);
    const env = await childEnv();
    for (const key of Object.keys(LAUNCHER)) {
      expect(env[key], `${key} must not reach a git hook`).toBeUndefined();
    }
  });

  it("merges opts.env OVER the pruned base, and still prunes", async () => {
    Object.assign(process.env, LAUNCHER);
    process.env.ZEROS_GITENV_PROBE = "from-process";
    const env = await childEnv({ ZEROS_GITENV_PROBE: "from-opts" });
    expect(env.ZEROS_GITENV_PROBE).toBe("from-opts");
    // The prune has to survive a caller-supplied env too. The pre-merge shape
    // only built an env object when there WAS one, so this is the case a
    // conditional would skip.
    for (const key of Object.keys(LAUNCHER)) {
      expect(
        env[key],
        `${key} must not survive an opts.env merge`,
      ).toBeUndefined();
    }
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
