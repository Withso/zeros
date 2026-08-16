import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSqlite } from "../../../db/sqlite";
import { runFile } from "../../../git/git-exec";
import {
  closeGitCredentialBrokerForTesting,
  setGitCredentialSourceForTesting,
} from "../../../git/credential-broker";
import type { AgentFilesystemTerritory } from "../../types";
import {
  discoverCanonicalGitRepository,
  parseShadowGitFetchArgs,
  parseShadowGitPullArgs,
  parseShadowGitPushArgs,
  recoverShadowGitPreservations,
  ShadowGitPromotionError,
  ShadowGitSession,
} from "../shadow-git";
import { newTerritoryGeneration } from "../status";
import {
  sessionsRoot,
  SHADOW_GIT_RECOVERY_HOLD_FILE,
} from "../../session-paths";

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  return (
    await runFile("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      timeoutMs: 30_000,
    })
  ).stdout.trim();
}

async function startSmartHttpGitServer(
  projectRoot: string,
  username: string,
  password: string,
  options: { rejectLfsUploads?: boolean } = {},
): Promise<{ server: Server; url: string; lfsObjects: Map<string, Buffer> }> {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const lfsObjects = new Map<string, Buffer>();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      response.statusCode = 401;
      response.setHeader("WWW-Authenticate", 'Basic realm="zeros-test"');
      response.end();
      return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/remote.git/info/lfs/objects/batch"
    ) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          const payload = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as {
            operation?: unknown;
            objects?: Array<{ oid?: unknown; size?: unknown }>;
          };
          if (
            payload.operation !== "upload" ||
            !Array.isArray(payload.objects) ||
            payload.objects.length > 100
          ) {
            throw new Error("invalid LFS batch");
          }
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("missing LFS server address");
          }
          const objects = payload.objects.map((object) => {
            if (
              typeof object.oid !== "string" ||
              !/^[0-9a-f]{64}$/.test(object.oid) ||
              !Number.isSafeInteger(object.size) ||
              Number(object.size) < 0
            ) {
              throw new Error("invalid LFS object");
            }
            return {
              oid: object.oid,
              size: object.size,
              authenticated: true,
              ...(options.rejectLfsUploads
                ? {
                    error: {
                      code: 422,
                      message: "LFS upload rejected by fixture",
                    },
                  }
                : lfsObjects.has(object.oid)
                  ? {}
                  : {
                      actions: {
                        upload: {
                          href: `http://127.0.0.1:${address.port}/lfs-upload/${object.oid}`,
                          header: { Authorization: expected },
                        },
                      },
                    }),
            };
          });
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/vnd.git-lfs+json");
          response.end(JSON.stringify({ transfer: "basic", objects }));
        } catch {
          response.statusCode = 422;
          response.end(JSON.stringify({ message: "invalid LFS batch" }));
        }
      });
      return;
    }
    const upload = /^\/lfs-upload\/([0-9a-f]{64})$/.exec(requestUrl.pathname);
    if (request.method === "PUT" && upload) {
      if (options.rejectLfsUploads) {
        response.statusCode = 422;
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        const content = Buffer.concat(chunks);
        if (createHash("sha256").update(content).digest("hex") !== upload[1]) {
          response.statusCode = 422;
          response.end();
          return;
        }
        lfsObjects.set(upload[1]!, content);
        response.statusCode = 200;
        response.end();
      });
      return;
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: requestUrl.pathname,
        QUERY_STRING: requestUrl.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        REMOTE_USER: username,
        SERVER_PROTOCOL: "HTTP/1.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    request.pipe(child.stdin);
    child.once("exit", (code) => {
      if (code !== 0) {
        response.statusCode = 500;
        response.end(Buffer.concat(errors).toString("utf8").slice(-2_000));
        return;
      }
      const payload = Buffer.concat(output);
      let separator = payload.indexOf("\r\n\r\n");
      let width = 4;
      if (separator < 0) {
        separator = payload.indexOf("\n\n");
        width = 2;
      }
      if (separator < 0) {
        response.statusCode = 500;
        response.end("invalid CGI response");
        return;
      }
      const headers = payload.subarray(0, separator).toString("utf8");
      for (const line of headers.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") {
          response.statusCode = Number.parseInt(value, 10);
        } else {
          response.setHeader(name, value);
        }
      }
      response.end(payload.subarray(separator + width));
    });
    child.once("error", () => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test Git HTTP server has no TCP address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/remote.git`,
    lfsObjects,
  };
}

describe("ZSR shadow Git", () => {
  let root: string;
  let workspace: string;
  let design: string;
  let privateRoot: string;
  let initialHead: string;
  let sessions: ShadowGitSession[];
  let httpServers: Server[];
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-shadow-git-"));
    workspace = path.join(root, "workspace");
    design = path.join(workspace, "Zeros Design");
    privateRoot = path.join(root, "private");
    sessions = [];
    httpServers = [];
    previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(path.join(privateRoot, "git"), { recursive: true }),
      mkdir(path.join(privateRoot, "home"), { recursive: true }),
      mkdir(path.join(privateRoot, "commands"), { recursive: true }),
      mkdir(path.join(privateRoot, "tools"), { recursive: true }),
    ]);
    await git(workspace, ["init", "-b", "main"]);
    await git(workspace, ["config", "user.name", "Zeros Test"]);
    await git(workspace, ["config", "user.email", "zeros@example.invalid"]);
    await Promise.all([
      writeFile(path.join(workspace, "code.txt"), "before\n"),
      writeFile(path.join(design, "document.json"), '{"safe":true}\n'),
    ]);
    await git(workspace, ["add", "--", "code.txt", "Zeros Design"]);
    await git(workspace, ["commit", "-m", "initial"]);
    initialHead = await git(workspace, ["rev-parse", "HEAD"]);
  });

  afterEach(async () => {
    await Promise.all(sessions.map((active) => active.stop()));
    setGitCredentialSourceForTesting(null);
    await closeGitCredentialBrokerForTesting();
    await Promise.all(
      httpServers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  });

  async function session(
    options: {
      root?: string;
      trustedSshCommandForTesting?: string;
      checkpoint?: NonNullable<
        Parameters<
          typeof ShadowGitSession.create
        >[0]["promotionCheckpointForTesting"]
      >;
    } = {},
  ): Promise<ShadowGitSession> {
    const sessionRoot = options.root ?? privateRoot;
    await Promise.all([
      mkdir(path.join(sessionRoot, "git"), { recursive: true }),
      mkdir(path.join(sessionRoot, "home"), { recursive: true }),
      mkdir(path.join(sessionRoot, "commands"), { recursive: true }),
      mkdir(path.join(sessionRoot, "tools"), { recursive: true }),
    ]);
    const repository = await discoverCanonicalGitRepository(workspace);
    if (!repository) throw new Error("test repository was not discovered");
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: workspace,
      designDirectory: design,
      protectedDesignDirectories: [design],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [design, path.join(workspace, ".git")],
      },
    };
    const active = await ShadowGitSession.create({
      workspaceRoot: workspace,
      shadowRoot: path.join(sessionRoot, "git"),
      privateHome: path.join(sessionRoot, "home"),
      commandsRoot: path.join(sessionRoot, "commands"),
      toolsRoot: path.join(sessionRoot, "tools"),
      toolRuntime: process.execPath,
      generation: newTerritoryGeneration(),
      territory,
      repository,
      ...(options.trustedSshCommandForTesting
        ? {
            trustedSshCommandForTesting: options.trustedSshCommandForTesting,
          }
        : {}),
      ...(options.checkpoint
        ? { promotionCheckpointForTesting: options.checkpoint }
        : {}),
    });
    sessions.push(active);
    return active;
  }

  async function authenticatedRemote(
    remoteName: string,
    options: { rejectLfsUploads?: boolean } = {},
  ): Promise<{
    remote: string;
    url: string;
    username: string;
    password: string;
    lfsObjects: Map<string, Buffer>;
  }> {
    const remoteRoot = path.join(root, `${remoteName}-remotes`);
    const remote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(remote, ["config", "http.receivepack", "true"]);
    await git(workspace, ["push", remote, "main"]);
    await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const username = `${remoteName}-user`;
    const password = `${remoteName}-credential-secret`;
    const http = await startSmartHttpGitServer(
      remoteRoot,
      username,
      password,
      options,
    );
    httpServers.push(http.server);
    await git(workspace, ["remote", "add", "origin", http.url]);
    setGitCredentialSourceForTesting({
      supports(request) {
        return request.host === "127.0.0.1";
      },
      async shouldHandle() {
        return true;
      },
      async getCredential() {
        return { username, password };
      },
    });
    return {
      remote,
      url: http.url,
      username,
      password,
      lfsObjects: http.lfsObjects,
    };
  }

  async function advanceRemote(
    remote: string,
    updates: Readonly<Record<string, string>>,
  ): Promise<string> {
    const checkout = path.join(root, `remote-checkout-${Date.now()}`);
    await git(root, ["clone", remote, checkout]);
    await git(checkout, ["config", "user.name", "Remote Test"]);
    await git(checkout, ["config", "user.email", "remote@example.invalid"]);
    for (const [relative, content] of Object.entries(updates)) {
      const destination = path.join(checkout, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await git(checkout, ["add", "--", ...Object.keys(updates)]);
    await git(checkout, ["commit", "-m", "remote update"]);
    await git(checkout, ["push", "origin", "main"]);
    return git(checkout, ["rev-parse", "HEAD"]);
  }

  async function createMixedBranch(name: string): Promise<string> {
    await git(workspace, ["checkout", "-b", name]);
    await Promise.all([
      writeFile(path.join(workspace, "code.txt"), `${name} code\n`),
      writeFile(path.join(design, "document.json"), '{"safe":false}\n'),
    ]);
    await git(workspace, ["add", "--", "code.txt", "Zeros Design"]);
    await git(workspace, ["commit", "-m", `${name} code and Design`]);
    const oid = await git(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["checkout", "main"]);
    return oid;
  }

  it("keeps native Git writable and CAS-promotes a code-only commit", async () => {
    const shadow = await session();
    expect(shadow.env).toMatchObject({
      GIT_DIR: path.join(privateRoot, "git"),
      GIT_COMMON_DIR: path.join(privateRoot, "git"),
      GIT_WORK_TREE: workspace,
    });
    await writeFile(path.join(workspace, "code.txt"), "after\n");
    await git(workspace, ["add", "--", "code.txt"], { ...shadow.env });
    await git(workspace, ["commit", "-m", "agent code"], { ...shadow.env });
    const shadowHead = await git(workspace, ["rev-parse", "HEAD"], {
      ...shadow.env,
    });
    expect(shadowHead).not.toBe(initialHead);
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(initialHead);

    await expect(shadow.synchronize()).resolves.toEqual({
      state: "promoted",
      updatedRefs: 1,
      indexUpdated: true,
    });
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(shadowHead);
    expect(await git(workspace, ["status", "--porcelain"])).toBe("");
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
  });

  it.runIf(spawnSync("gpg", ["--version"]).status === 0)(
    "preserves a signed code-only commit through promotion",
    async () => {
      const gpgHome = path.join(privateRoot, "gpg-home");
      await mkdir(gpgHome, { mode: 0o700 });
      await runFile(
        "gpg",
        [
          "--homedir",
          gpgHome,
          "--batch",
          "--pinentry-mode",
          "loopback",
          "--passphrase",
          "",
          "--quick-generate-key",
          "Zeros Signed Commit <signed@example.invalid>",
          "ed25519",
          "sign",
          "1d",
        ],
        { cwd: workspace, timeoutMs: 30_000 },
      );
      const keys = await runFile(
        "gpg",
        ["--homedir", gpgHome, "--batch", "--with-colons", "--list-keys"],
        { cwd: workspace, timeoutMs: 10_000 },
      );
      const fingerprint = /^fpr:::::::::([0-9A-F]+):$/m.exec(keys.stdout)?.[1];
      expect(fingerprint).toMatch(/^[0-9A-F]{40,64}$/);

      const shadow = await session();
      const childEnv = {
        ...shadow.childEnvironment(process.env.PATH),
        GNUPGHOME: gpgHome,
      };
      await git(
        workspace,
        ["config", "--global", "user.signingKey", fingerprint!],
        childEnv,
      );
      await git(
        workspace,
        ["config", "--global", "commit.gpgSign", "true"],
        childEnv,
      );
      await writeFile(path.join(workspace, "code.txt"), "signed code\n");
      await git(workspace, ["add", "--", "code.txt"], childEnv);
      await git(workspace, ["commit", "-m", "signed agent code"], childEnv);
      const shadowHead = await git(workspace, ["rev-parse", "HEAD"], childEnv);
      expect(
        await git(workspace, ["log", "-1", "--format=%G?"], childEnv),
      ).toBe("G");

      await expect(shadow.synchronize()).resolves.toMatchObject({
        state: "promoted",
      });
      expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(shadowHead);
      expect(
        await git(workspace, ["cat-file", "commit", shadowHead]),
      ).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    },
    30_000,
  );

  it("refuses a crafted commit whose tree changes Design", async () => {
    const shadow = await session();
    await writeFile(path.join(design, "document.json"), '{"safe":false}\n');
    await git(workspace, ["add", "--", "Zeros Design/document.json"], {
      ...shadow.env,
    });
    await git(workspace, ["commit", "-m", "smuggled design"], {
      ...shadow.env,
    });

    const failure = await shadow.synchronize().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ShadowGitPromotionError);
    expect((failure as ShadowGitPromotionError).code).toBe("design-impact");
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  it("does not run canonical reference-transaction hooks during promotion", async () => {
    const sentinel = path.join(root, "hook-ran");
    const hook = path.join(workspace, ".git", "hooks", "reference-transaction");
    await writeFile(hook, `#!/bin/sh\nprintf ran > '${sentinel}'\n`, {
      mode: 0o700,
    });
    const shadow = await session();
    await writeFile(path.join(workspace, "code.txt"), "hook-safe\n");
    await git(workspace, ["add", "--", "code.txt"], { ...shadow.env });
    await git(workspace, ["commit", "-m", "contained hook"], {
      ...shadow.env,
    });

    // The private ref update correctly ran the copied hook inside the code
    // actor. Clear that evidence; the trusted canonical CAS below must not run
    // the canonical hook a second time outside containment.
    await rm(sentinel, { force: true });
    await shadow.synchronize();
    await expect(readFile(sentinel, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs repository hooks from the private Git view", async () => {
    const sentinel = path.join(workspace, "hook-output.txt");
    const hook = path.join(workspace, ".git", "hooks", "pre-commit");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf 'contained\\n' > '${sentinel}'\n`,
      { mode: 0o700 },
    );
    const shadow = await session();
    await writeFile(path.join(workspace, "code.txt"), "hooked\n");
    await git(workspace, ["add", "--", "code.txt"], { ...shadow.env });
    await git(workspace, ["commit", "-m", "run contained hook"], {
      ...shadow.env,
    });

    expect(await readFile(sentinel, "utf8")).toBe("contained\n");
    expect(
      await readFile(
        path.join(privateRoot, "git", "hooks", "pre-commit"),
        "utf8",
      ),
    ).toContain("contained");
    await shadow.synchronize();
  });

  it("never materializes an out-of-tree hook symlink into private Git state", async () => {
    const external = path.join(root, "engine-private-hook");
    const hook = path.join(workspace, ".git", "hooks", "pre-commit");
    await writeFile(external, "engine-only-content\n", { mode: 0o700 });
    await symlink(external, hook);

    await session();

    const copied = path.join(privateRoot, "git", "hooks", "pre-commit");
    expect((await lstat(copied)).isSymbolicLink()).toBe(true);
    expect(await readlink(copied)).toBe(external);
  });

  it("promotes a code-only branch checkout and commit", async () => {
    await git(workspace, ["branch", "feature"]);
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await git(workspace, ["checkout", "feature"], { ...childEnv });
    await writeFile(path.join(workspace, "code.txt"), "feature\n");
    await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["commit", "-m", "feature code"], {
      ...childEnv,
    });

    await expect(shadow.synchronize()).resolves.toMatchObject({
      state: "promoted",
      updatedRefs: 1,
    });
    expect(await git(workspace, ["symbolic-ref", "--short", "HEAD"])).toBe(
      "feature",
    );
    expect(await git(workspace, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a mixed code and Design checkout before either tree is mutated", async () => {
    await createMixedBranch("mixed-design");

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["checkout", "mixed-design"], { ...childEnv }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      initialHead,
    );
  });

  it("refuses a mixed hard reset before code or Design is mutated", async () => {
    const mixed = await createMixedBranch("mixed-reset");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["reset", "--hard", mixed], { ...childEnv }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      initialHead,
    );
  });

  it("refuses a mixed restore pathset before restoring code", async () => {
    await createMixedBranch("mixed-restore");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(
        workspace,
        [
          "restore",
          "--source=mixed-restore",
          "--",
          "code.txt",
          "Zeros Design/document.json",
        ],
        { ...childEnv },
      ),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
  });

  it("refuses a clean that selects untracked code and Design files before deletion", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const codeScratch = path.join(workspace, "scratch.txt");
    const designScratch = path.join(design, "scratch.txt");
    await Promise.all([
      writeFile(codeScratch, "code scratch\n"),
      writeFile(designScratch, "Design scratch\n"),
    ]);

    await expect(
      git(workspace, ["clean", "-fd"], { ...childEnv }),
    ).rejects.toThrow(/protected Design/i);
    await expect(readFile(codeScratch, "utf8")).resolves.toBe("code scratch\n");
    await expect(readFile(designScratch, "utf8")).resolves.toBe(
      "Design scratch\n",
    );
  });

  it("refuses a mixed merge before code or Design is mutated", async () => {
    await createMixedBranch("mixed-merge");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["merge", "--no-edit", "mixed-merge"], { ...childEnv }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      initialHead,
    );
  });

  it("allows and promotes a code-only merge", async () => {
    await git(workspace, ["checkout", "-b", "code-merge"]);
    await writeFile(path.join(workspace, "code.txt"), "merged code\n");
    await git(workspace, ["add", "--", "code.txt"]);
    await git(workspace, ["commit", "-m", "code-only merge target"]);
    const target = await git(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["checkout", "main"]);
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await git(workspace, ["merge", "--ff-only", "code-merge"], {
      ...childEnv,
    });
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "merged code\n",
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      target,
    );
    await expect(shadow.synchronize()).resolves.toMatchObject({
      state: "promoted",
    });
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(target);
  });

  it("refuses mixed rm and mv selections before moving code", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["rm", "-r", "--", "code.txt", "Zeros Design"], {
        ...childEnv,
      }),
    ).rejects.toThrow(/protected Design/i);
    await expect(
      git(workspace, ["mv", "code.txt", "Zeros Design/moved-code.txt"], {
        ...childEnv,
      }),
    ).rejects.toThrow(/protected Design/i);
    await expect(
      readFile(path.join(workspace, "code.txt"), "utf8"),
    ).resolves.toBe("before\n");
    await expect(
      readFile(path.join(design, "document.json"), "utf8"),
    ).resolves.toBe('{"safe":true}\n');
  });

  it("refuses a mixed cherry-pick before code or Design is mutated", async () => {
    const mixed = await createMixedBranch("mixed-cherry-pick");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["cherry-pick", mixed], { ...childEnv }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      initialHead,
    );
  });

  it("refuses a rebase whose net tree is safe but intermediate commits change Design", async () => {
    await git(workspace, ["checkout", "-b", "net-zero-design"]);
    await Promise.all([
      writeFile(path.join(workspace, "code.txt"), "rebase step one\n"),
      writeFile(path.join(design, "document.json"), '{"safe":false}\n'),
    ]);
    await git(workspace, ["add", "--", "code.txt", "Zeros Design"]);
    await git(workspace, ["commit", "-m", "temporarily change Design"]);
    await Promise.all([
      writeFile(path.join(workspace, "code.txt"), "rebase step two\n"),
      writeFile(path.join(design, "document.json"), '{"safe":true}\n'),
    ]);
    await git(workspace, ["add", "--", "code.txt", "Zeros Design"]);
    await git(workspace, ["commit", "-m", "restore Design"]);
    await git(workspace, ["checkout", "main"]);
    await writeFile(path.join(workspace, "base.txt"), "new base\n");
    await git(workspace, ["add", "--", "base.txt"]);
    await git(workspace, ["commit", "-m", "advance base"]);
    const canonicalHead = await git(workspace, ["rev-parse", "HEAD"]);

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await expect(
      git(workspace, ["rebase", "main", "net-zero-design"], {
        ...childEnv,
      }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      canonicalHead,
    );
  });

  it("refuses a stash apply that mixes code and Design before either is mutated", async () => {
    await Promise.all([
      writeFile(path.join(workspace, "code.txt"), "stashed code\n"),
      writeFile(path.join(design, "document.json"), '{"safe":false}\n'),
    ]);
    await git(workspace, ["stash", "push", "-m", "mixed stash"]);
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["stash", "pop"], { ...childEnv }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(
      await git(workspace, ["rev-parse", "--verify", "refs/stash"], {
        ...childEnv,
      }),
    ).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("preserves native code-only stash push and pop behavior", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await writeFile(path.join(workspace, "code.txt"), "stashed code only\n");

    await git(workspace, ["stash", "push", "-m", "code-only stash"], {
      ...childEnv,
    });
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    await git(workspace, ["stash", "pop"], { ...childEnv });
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "stashed code only\n",
    );
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
  });

  it("imports bounded canonical reflogs for stash selectors and checkout dash", async () => {
    await writeFile(path.join(workspace, "code.txt"), "older stash\n");
    await git(workspace, ["stash", "push", "-m", "older"]);
    const older = await git(workspace, ["rev-parse", "refs/stash"]);
    await writeFile(path.join(workspace, "code.txt"), "newer stash\n");
    await git(workspace, ["stash", "push", "-m", "newer"]);
    await git(workspace, ["branch", "previous-branch"]);
    await git(workspace, ["checkout", "previous-branch"]);
    await git(workspace, ["checkout", "main"]);

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    expect(
      await git(workspace, ["rev-parse", "stash@{1}"], { ...childEnv }),
    ).toBe(older);
    await git(workspace, ["stash", "apply", "stash@{1}"], { ...childEnv });
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "older stash\n",
    );
    await git(workspace, ["restore", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["checkout", "-"], { ...childEnv });
    expect(
      await git(workspace, ["symbolic-ref", "--short", "HEAD"], {
        ...childEnv,
      }),
    ).toBe("previous-branch");
  });

  it("fails old-OID CAS instead of overwriting a concurrent human ref", async () => {
    const shadow = await session();
    await writeFile(path.join(workspace, "code.txt"), "agent\n");
    await git(workspace, ["add", "--", "code.txt"], { ...shadow.env });
    await git(workspace, ["commit", "-m", "agent"], { ...shadow.env });

    const tree = await git(workspace, ["rev-parse", `${initialHead}^{tree}`]);
    const humanCommit = await git(workspace, [
      "commit-tree",
      tree,
      "-p",
      initialHead,
      "-m",
      "human",
    ]);
    await git(workspace, [
      "update-ref",
      "refs/heads/main",
      humanCommit,
      initialHead,
    ]);

    const failure = await shadow.synchronize().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ShadowGitPromotionError);
    expect((failure as ShadowGitPromotionError).code).toBe(
      "concurrent-git-change",
    );
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(humanCommit);
  });

  it.each([
    ["replacements-staged", false],
    ["journal-prepared", false],
    ["refs-committed", true],
    ["head-committed", true],
    ["index-committed", true],
  ] as const)(
    "recovers an abrupt promotion crash at %s",
    async (crashPhase, shouldFinish) => {
      const crashing = await session({
        root: path.join(root, "crashing-private"),
        checkpoint(phase) {
          if (phase !== crashPhase) return;
          throw Object.assign(new Error(`simulated crash at ${phase}`), {
            zsrSimulatedCrash: true,
          });
        },
      });
      const childEnv = crashing.childEnvironment(process.env.PATH);
      await writeFile(
        path.join(workspace, "code.txt"),
        `crash-${crashPhase}\n`,
      );
      await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
      await git(workspace, ["commit", "-m", `crash ${crashPhase}`], {
        ...childEnv,
      });
      const candidateHead = await git(workspace, ["rev-parse", "HEAD"], {
        ...childEnv,
      });
      await expect(crashing.synchronize()).rejects.toThrow(/simulated crash/);
      await crashing.stop();

      const recovered = await session({
        root: path.join(root, "recovered-private"),
      });
      expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(
        shouldFinish ? candidateHead : initialHead,
      );
      await expect(
        readFile(path.join(workspace, ".git", "HEAD.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(workspace, ".git", "index.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const journalBase = path.join(root, "engine", "git-promotion-journal");
      const journalWorkspaces = await readdir(journalBase).catch(() => []);
      for (const directory of journalWorkspaces) {
        expect(
          (await readdir(path.join(journalBase, directory))).filter((name) =>
            name.endsWith(".json"),
          ),
        ).toEqual([]);
      }
      await recovered.stop();
    },
  );

  it("serializes promotion recovery across engine processes", async () => {
    const shadow = await session();
    const repository = await discoverCanonicalGitRepository(workspace);
    if (!repository) throw new Error("test repository was not discovered");
    const workspaceHash = createHash("sha256")
      .update(`${repository.workspaceRoot}\0${repository.commonDir}`)
      .digest("hex");
    const lockPath = path.join(
      root,
      "engine",
      "git-promotion-journal",
      workspaceHash,
      "promotion-lock.sqlite",
    );
    const lockDb = openSqlite(lockPath);
    lockDb.exec("BEGIN IMMEDIATE");
    await writeFile(path.join(workspace, "code.txt"), "serialized\n");
    await git(workspace, ["add", "--", "code.txt"], { ...shadow.env });
    await git(workspace, ["commit", "-m", "serialized"], { ...shadow.env });

    let settled = false;
    const promotion = shadow.synchronize().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    lockDb.exec("COMMIT");
    lockDb.close();

    await expect(promotion).resolves.toMatchObject({ state: "promoted" });
  });

  it("copies normal Git config but removes credential-bearing authority", async () => {
    await git(workspace, [
      "config",
      "credential.https://example.invalid.helper",
      "!printf 'password=host-secret\\n'",
    ]);
    await git(workspace, [
      "config",
      "http.https://example.invalid.extraHeader",
      "Authorization: Bearer host-secret",
    ]);
    await git(workspace, [
      "remote",
      "add",
      "origin",
      "https://alice:host-secret@example.invalid/repo.git",
    ]);
    await git(workspace, ["config", "alias.safe-status", "status --short"]);

    const shadow = await session();
    const config = await git(workspace, ["config", "--null", "--list"], {
      ...shadow.childEnvironment(process.env.PATH),
    });
    expect(config).not.toContain("host-secret");
    expect(config).not.toContain("credential.https://example.invalid.helper");
    expect(config).not.toContain("extraheader");
    expect(config).toContain("alias.safe-status");
    expect(
      await git(workspace, ["remote", "get-url", "origin"], {
        ...shadow.childEnvironment(process.env.PATH),
      }),
    ).toBe("https://alice@example.invalid/repo.git");
    expect(
      await git(workspace, ["--version"], {
        ...shadow.childEnvironment(process.env.PATH),
      }),
    ).toMatch(/^git version /);
  });

  it("rejects broad or helper-selecting push syntax before credential use", () => {
    expect(parseShadowGitPushArgs(["push", "-u", "origin", "main"])).toEqual({
      remote: "origin",
      refspecs: ["main"],
      flags: [],
      setUpstream: true,
      deleteMode: false,
      forceWithLease: false,
      explicitLeases: [],
      allBranches: false,
      allTags: false,
      followTags: false,
      mirror: false,
      prune: false,
    });
    for (const args of [
      ["-c", "alias.p=push", "p", "origin", "main"],
      ["push", "--receive-pack=/tmp/evil", "origin", "main"],
      ["push", "--signed", "origin", "main"],
      ["push", "--repo", "https://example.invalid/repo.git", "main"],
    ]) {
      expect(() => parseShadowGitPushArgs(args)).toThrow(
        ShadowGitPromotionError,
      );
    }
    expect(parseShadowGitPushArgs(["push", "--mirror", "origin"]).mirror).toBe(
      true,
    );
    expect(
      parseShadowGitPushArgs([
        "push",
        "--prune",
        "origin",
        "refs/heads/*:refs/heads/*",
      ]).prune,
    ).toBe(true);
  });

  it("parses common scoped fetch/pull syntax and rejects helper selection", () => {
    expect(
      parseShadowGitFetchArgs([
        "fetch",
        "--depth=2",
        "--prune",
        "origin",
        "main",
      ]),
    ).toEqual({
      remote: "origin",
      refspecs: ["main"],
      flags: ["--depth=2", "--prune"],
    });
    expect(
      parseShadowGitPullArgs([
        "pull",
        "--rebase=merges",
        "--autostash",
        "origin",
        "main",
      ]),
    ).toEqual({
      remote: "origin",
      refspecs: ["main"],
      flags: [],
      integration: "rebase",
      integrationFlags: ["--rebase-merges", "--autostash"],
    });
    for (const args of [
      ["fetch", "--upload-pack=/tmp/evil", "origin"],
      ["fetch", "--all"],
      ["fetch", "--multiple", "origin", "backup"],
      ["pull", "--upload-pack", "/tmp/evil", "origin"],
      ["-c", "credential.helper=!evil", "fetch", "origin"],
    ]) {
      const parse = args.includes("pull")
        ? parseShadowGitPullArgs
        : parseShadowGitFetchArgs;
      expect(() => parse(args)).toThrow(ShadowGitPromotionError);
    }
  });

  it("fetches an authenticated HTTP remote into private refs without exposing credentials", async () => {
    const remote = await authenticatedRemote("fetch");
    const shadow = await session();
    const remoteHead = await advanceRemote(remote.remote, {
      "code.txt": "fetched\n",
    });
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await git(workspace, ["fetch", "origin"], { ...childEnv });

    expect(Object.values(childEnv)).not.toContain(remote.password);
    expect(
      await git(workspace, ["rev-parse", "refs/remotes/origin/main"], {
        ...childEnv,
      }),
    ).toBe(remoteHead);
    await expect(
      git(workspace, ["rev-parse", "--verify", "refs/remotes/origin/main"]),
    ).rejects.toBeDefined();
    expect(
      await readFile(path.join(privateRoot, "git", "FETCH_HEAD"), "utf8"),
    ).not.toContain(remote.password);
    expect(
      await readdir(path.join(privateRoot, "tools", "remote-stages")),
    ).toEqual([]);

    await shadow.synchronize();
    expect(
      await git(workspace, ["rev-parse", "refs/remotes/origin/main"]),
    ).toBe(remoteHead);
  });

  it("uses an admitted host's ambient credential helper without exposing its secret", async () => {
    const remoteRoot = path.join(root, "ambient-remotes");
    const remote = path.join(remoteRoot, "remote.git");
    const hostHome = path.join(root, "ambient-home");
    const helper = path.join(root, "ambient-helper");
    const helperLog = path.join(root, "ambient-helper.log");
    await Promise.all([
      mkdir(remoteRoot, { recursive: true }),
      mkdir(hostHome, { recursive: true }),
    ]);
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(remote, ["config", "http.receivepack", "true"]);
    const http = await startSmartHttpGitServer(
      remoteRoot,
      "ambient-user",
      "ambient-secret",
    );
    httpServers.push(http.server);
    await git(workspace, ["remote", "add", "origin", http.url]);
    await writeFile(
      helper,
      [
        "#!/bin/sh",
        `printf 'called\\n' >> '${helperLog}'`,
        '[ "${1:-}" = get ] || exit 0',
        "printf 'username=ambient-user\\npassword=ambient-secret\\n'",
        "",
      ].join("\n"),
    );
    await chmod(helper, 0o700);
    await writeFile(
      path.join(hostHome, ".gitconfig"),
      `[credential]\n\thelper = ${helper}\n`,
    );
    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = hostHome;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const shadow = await session();
      const childEnv = shadow.childEnvironment(process.env.PATH);
      expect(Object.values(childEnv)).not.toContain("ambient-secret");
      await writeFile(path.join(workspace, "code.txt"), "ambient push\n");
      await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
      await git(workspace, ["commit", "-m", "ambient helper"], {
        ...childEnv,
      });

      await git(workspace, ["push", "origin", "main"], { ...childEnv });

      expect((await readFile(helperLog, "utf8")).trim()).not.toBe("");
      expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
        await git(workspace, ["rev-parse", "HEAD"], { ...childEnv }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it("preserves an admitted SSH remote through the exact validated broker path", async () => {
    const remoteRoot = path.join(root, "ssh-remotes");
    const remote = path.join(remoteRoot, "remote.git");
    const fakeSsh = path.join(root, "fake-ssh");
    await mkdir(remoteRoot, { recursive: true });
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(workspace, ["push", remote, "main"]);
    await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
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
    await chmod(fakeSsh, 0o700);
    await git(workspace, [
      "remote",
      "add",
      "origin",
      `ssh://example.invalid${remote}`,
    ]);

    const shadow = await session({ trustedSshCommandForTesting: fakeSsh });
    const childEnv = shadow.childEnvironment(process.env.PATH);
    expect(childEnv.GIT_SSH).toBeUndefined();
    await writeFile(path.join(workspace, "code.txt"), "ssh push\n");
    await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["commit", "-m", "ssh transport"], {
      ...childEnv,
    });
    const privateHead = await git(workspace, ["rev-parse", "HEAD"], {
      ...childEnv,
    });

    await git(workspace, ["push", "origin", "main"], { ...childEnv });

    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      privateHead,
    );
  });

  it("hydrates a private partial clone through the fetch-only promisor broker", async () => {
    const source = path.join(root, "partial-source");
    const remoteRoot = path.join(root, "partial-remotes");
    const remote = path.join(remoteRoot, "remote.git");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(remoteRoot, { recursive: true }),
    ]);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "Partial Clone Test"]);
    await git(source, ["config", "user.email", "partial@example.invalid"]);
    await mkdir(path.join(source, "Zeros Design"));
    await Promise.all([
      writeFile(path.join(source, "code.txt"), "first\n"),
      writeFile(path.join(source, "historical.txt"), "lazy private blob\n"),
      writeFile(
        path.join(source, "Zeros Design", "document.json"),
        '{"safe":true}\n',
      ),
    ]);
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "historical blob"]);
    const historicalCommit = await git(source, ["rev-parse", "HEAD"]);
    await rm(path.join(source, "historical.txt"));
    await writeFile(path.join(source, "code.txt"), "current\n");
    await git(source, ["add", "-A"]);
    await git(source, ["commit", "-m", "current tree"]);
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(remote, ["config", "http.receivepack", "true"]);
    await git(remote, ["config", "uploadpack.allowFilter", "true"]);
    await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    await git(source, ["push", remote, "main"]);
    await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const http = await startSmartHttpGitServer(
      remoteRoot,
      "partial-user",
      "partial-secret",
    );
    httpServers.push(http.server);

    const askpass = path.join(root, "partial-clone-askpass");
    await writeFile(
      askpass,
      [
        "#!/bin/sh",
        'case "${1:-}" in',
        "  *sername*) printf 'partial-user\\n' ;;",
        "  *) printf 'partial-secret\\n' ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(askpass, 0o700);
    await rm(workspace, { recursive: true, force: true });
    await runFile(
      "git",
      ["clone", "--filter=blob:none", "--no-local", http.url, workspace],
      {
        cwd: root,
        timeoutMs: 30_000,
        env: {
          ...process.env,
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    design = path.join(workspace, "Zeros Design");
    initialHead = await git(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["config", "user.name", "Zeros Test"]);
    await git(workspace, ["config", "user.email", "zeros@example.invalid"]);
    expect(
      await git(workspace, ["config", "--get", "remote.origin.promisor"]),
    ).toBe("true");

    const hostHome = path.join(root, "partial-host-home");
    const ambientHelper = path.join(root, "partial-ambient-helper");
    const helperLog = path.join(root, "partial-helper.log");
    await mkdir(hostHome, { mode: 0o700 });
    await writeFile(
      ambientHelper,
      [
        "#!/bin/sh",
        `printf 'called\\n' >> '${helperLog}'`,
        '[ "${1:-}" = get ] || exit 0',
        "printf 'username=partial-user\\npassword=partial-secret\\n'",
        "",
      ].join("\n"),
    );
    await chmod(ambientHelper, 0o700);
    await writeFile(
      path.join(hostHome, ".gitconfig"),
      `[credential]\n\thelper = ${ambientHelper}\n`,
    );
    const previousHome = process.env.HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = hostHome;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const shadow = await session();
      const childEnv = shadow.childEnvironment(process.env.PATH);
      expect(Object.values(childEnv)).not.toContain("partial-secret");
      expect(
        await git(workspace, ["remote", "get-url", "origin"], childEnv),
      ).toBe(http.url);
      expect(await git(workspace, ["remote", "-v"], childEnv)).not.toContain(
        "zeros-zsr",
      );
      const historical = await git(
        workspace,
        ["show", `${historicalCommit}:historical.txt`],
        childEnv,
      );
      expect(historical).toBe("lazy private blob");
      expect((await readFile(helperLog, "utf8")).trim()).not.toBe("");
      expect(
        await git(workspace, ["config", "--get", "remote.origin.url"], {
          ...childEnv,
        }),
      ).toBe(http.url);

      // Even a child that invokes the generated helper directly cannot
      // turn the lazy-fetch credential into an outbound ref-update grant.
      const transportHelper = path.join(
        childEnv.PATH!.split(path.delimiter)[0]!,
        "git-remote-zeros-zsr",
      );
      await runFile(transportHelper, ["origin", http.url], {
        cwd: workspace,
        env: { ...process.env, ...childEnv },
        input: "capabilities\npush refs/heads/main:refs/heads/zsr-escape\n\n",
        timeoutMs: 5_000,
        maxBufferBytes: 1024 * 1024,
      }).catch(() => undefined);
      await expect(
        git(remote, ["show-ref", "--verify", "refs/heads/zsr-escape"]),
      ).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  }, 60_000);

  it("hydrates an SSH partial clone through the upload-pack-only broker", async () => {
    const source = path.join(root, "ssh-partial-source");
    const remoteRoot = path.join(root, "ssh partial's remotes");
    const remote = path.join(remoteRoot, "remote.git");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(remoteRoot, { recursive: true }),
    ]);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "SSH Partial Test"]);
    await git(source, ["config", "user.email", "ssh-partial@example.invalid"]);
    await mkdir(path.join(source, "Zeros Design"));
    await Promise.all([
      writeFile(path.join(source, "code.txt"), "first\n"),
      writeFile(path.join(source, "ssh-historical.txt"), "ssh lazy blob\n"),
      writeFile(
        path.join(source, "Zeros Design", "document.json"),
        '{"safe":true}\n',
      ),
    ]);
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "historical SSH blob"]);
    const historicalCommit = await git(source, ["rev-parse", "HEAD"]);
    await rm(path.join(source, "ssh-historical.txt"));
    await writeFile(path.join(source, "code.txt"), "current\n");
    await git(source, ["add", "-A"]);
    await git(source, ["commit", "-m", "current SSH tree"]);
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(remote, ["config", "uploadpack.allowFilter", "true"]);
    await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    await git(source, ["push", remote, "main"]);
    await git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

    await rm(workspace, { recursive: true, force: true });
    await git(root, [
      "clone",
      "--filter=blob:none",
      "--no-local",
      pathToFileURL(remote).toString(),
      workspace,
    ]);
    design = path.join(workspace, "Zeros Design");
    initialHead = await git(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["config", "user.name", "Zeros Test"]);
    await git(workspace, ["config", "user.email", "zeros@example.invalid"]);
    const sshUrl = new URL(`ssh://example.invalid${remote}`).toString();
    await git(workspace, ["remote", "set-url", "origin", sshUrl]);

    const fakeSsh = path.join(root, "fake-ssh-partial");
    const sshLog = path.join(root, "fake-ssh-partial.log");
    await writeFile(
      fakeSsh,
      [
        "#!/bin/sh",
        `printf 'called\\n' >> '${sshLog}'`,
        "command=",
        'for value in "$@"; do command="$value"; done',
        'case "$command" in',
        "  'git-upload-pack '*) exec /bin/sh -c \"$command\" ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(fakeSsh, 0o700);

    const shadow = await session({ trustedSshCommandForTesting: fakeSsh });
    const childEnv = shadow.childEnvironment(process.env.PATH);
    expect(
      await git(workspace, ["remote", "get-url", "origin"], childEnv),
    ).toBe(sshUrl);
    expect(
      await git(
        workspace,
        ["show", `${historicalCommit}:ssh-historical.txt`],
        childEnv,
      ),
    ).toBe("ssh lazy blob");
    expect((await readFile(sshLog, "utf8")).trim()).not.toBe("");
  });

  it("never evaluates agent-controlled Git config with broker credentials", async () => {
    const remote = await authenticatedRemote("config-attack");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const injectedConfig = path.join(root, "engine-only-injected.config");
    await writeFile(
      injectedConfig,
      '[url "http://127.0.0.1:1/"]\n\tinsteadOf = http://127.0.0.1/\n',
    );
    await git(
      workspace,
      ["config", "--local", "include.path", injectedConfig],
      {
        ...childEnv,
      },
    );
    await git(
      workspace,
      ["config", "--local", `url.http://127.0.0.1:1/.insteadOf`, remote.url],
      { ...childEnv },
    );
    await git(
      workspace,
      ["config", "--local", "remote.origin.vcs", "agent-controlled-helper"],
      { ...childEnv },
    );
    await git(
      workspace,
      ["config", "--local", "remote.origin.proxy", "http://127.0.0.1:1"],
      { ...childEnv },
    );
    const remoteHead = await advanceRemote(remote.remote, {
      "code.txt": "config-isolated\n",
    });

    await git(workspace, ["fetch", "origin"], { ...childEnv });

    expect(
      await git(workspace, ["rev-parse", "refs/remotes/origin/main"], {
        ...childEnv,
      }),
    ).toBe(remoteHead);
  });

  it("never grants broker credentials to an unconfigured direct URL", async () => {
    const remoteRoot = path.join(root, "unconfigured-remotes");
    await mkdir(remoteRoot, { recursive: true });
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    const username = "scoped-user";
    const password = "scoped-secret";
    const http = await startSmartHttpGitServer(remoteRoot, username, password);
    httpServers.push(http.server);
    await git(workspace, ["remote", "add", "origin", http.url]);
    let credentialReads = 0;
    setGitCredentialSourceForTesting({
      supports: () => true,
      async shouldHandle() {
        return true;
      },
      async getCredential() {
        credentialReads += 1;
        return { username, password };
      },
    });
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const unconfigured = http.url.replace("remote.git", "other.git");

    await git(workspace, ["fetch", unconfigured], { ...childEnv }).catch(
      () => "expected native transport failure",
    );
    expect(credentialReads).toBe(0);
  });

  it("pulls an authenticated code-only fast-forward through a network-free contained merge", async () => {
    const remote = await authenticatedRemote("pull");
    const shadow = await session();
    const remoteHead = await advanceRemote(remote.remote, {
      "code.txt": "pulled\n",
    });
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await git(workspace, ["pull", "--ff-only", "origin", "main"], {
      ...childEnv,
    });

    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "pulled\n",
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      remoteHead,
    );
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(initialHead);
    await shadow.synchronize();
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(remoteHead);
  });

  it("rejects a pull that changes Design before the worktree can be mutated", async () => {
    const remote = await authenticatedRemote("protected-pull");
    const shadow = await session();
    await advanceRemote(remote.remote, {
      "Zeros Design/document.json": '{"safe":false}\n',
    });
    const childEnv = shadow.childEnvironment(process.env.PATH);

    await expect(
      git(workspace, ["pull", "--ff-only", "origin", "main"], {
        ...childEnv,
      }),
    ).rejects.toThrow(/protected Design/i);
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
    expect(await git(workspace, ["rev-parse", "HEAD"], { ...childEnv })).toBe(
      initialHead,
    );
  });

  it("promotes then pushes an exact branch without exposing the credential", async () => {
    const remoteRoot = path.join(root, "remotes");
    const remote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(remote, ["config", "http.receivepack", "true"]);
    const username = "zeros-user";
    const password = "zsr-test-secret";
    const http = await startSmartHttpGitServer(remoteRoot, username, password);
    httpServers.push(http.server);
    let credentialReads = 0;
    setGitCredentialSourceForTesting({
      supports(request) {
        return request.host === "127.0.0.1";
      },
      async shouldHandle() {
        return true;
      },
      async getCredential() {
        credentialReads += 1;
        return { username, password };
      },
    });
    await git(workspace, ["remote", "add", "origin", http.url]);

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    expect(Object.values(childEnv)).not.toContain(password);
    await writeFile(path.join(workspace, "code.txt"), "pushed\n");
    await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["commit", "-m", "brokered push"], {
      ...childEnv,
    });
    const privateHead = await git(workspace, ["rev-parse", "HEAD"], {
      ...childEnv,
    });

    await git(workspace, ["push", "-u", "origin", "main"], {
      ...childEnv,
    });
    expect(credentialReads).toBeGreaterThan(0);
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(privateHead);
    expect(await git(remote, ["rev-parse", "refs/heads/main"])).toBe(
      privateHead,
    );
    expect(await git(workspace, ["config", "branch.main.remote"])).toBe(
      "origin",
    );
  });

  it("pushes annotated tags and bulk branches through exact validated refspecs", async () => {
    const remote = await authenticatedRemote("bulk-push");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await git(workspace, ["tag", "-a", "v1", "-m", "version one"], {
      ...childEnv,
    });
    await git(workspace, ["branch", "feature"], { ...childEnv });

    await git(workspace, ["push", "origin", "v1"], { ...childEnv });
    await git(workspace, ["push", "--all", "origin"], { ...childEnv });

    expect(await git(remote.remote, ["rev-parse", "refs/tags/v1"])).toBe(
      await git(workspace, ["rev-parse", "refs/tags/v1"], { ...childEnv }),
    );
    expect(await git(remote.remote, ["rev-parse", "refs/heads/feature"])).toBe(
      initialHead,
    );
  });

  it("refuses an outbound tag whose commit smuggles a protected Design tree", async () => {
    const remote = await authenticatedRemote("tag-design");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const blob = (
      await runFile("git", ["hash-object", "-w", "--stdin"], {
        cwd: workspace,
        input: '{"safe":false}\n',
        env: { ...process.env, ...childEnv },
      })
    ).stdout.trim();
    // Build the malicious tree through a temporary private index so the real
    // protected worktree file is never modified, even in this fixture.
    const attackIndex = path.join(privateRoot, "attack-index");
    await git(workspace, ["read-tree", initialHead], {
      ...childEnv,
      GIT_INDEX_FILE: attackIndex,
    });
    await runFile(
      "git",
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        blob,
        "Zeros Design/document.json",
      ],
      {
        cwd: workspace,
        env: { ...process.env, ...childEnv, GIT_INDEX_FILE: attackIndex },
      },
    );
    const tree = await git(workspace, ["write-tree"], {
      ...childEnv,
      GIT_INDEX_FILE: attackIndex,
    });
    const commit = await git(
      workspace,
      ["commit-tree", tree, "-p", initialHead, "-m", "hidden design"],
      {
        ...childEnv,
        GIT_AUTHOR_NAME: "Zeros Test",
        GIT_AUTHOR_EMAIL: "zeros@example.invalid",
        GIT_COMMITTER_NAME: "Zeros Test",
        GIT_COMMITTER_EMAIL: "zeros@example.invalid",
      },
    );
    await git(workspace, ["tag", "unsafe-design", commit], { ...childEnv });

    await expect(
      git(workspace, ["push", "origin", "unsafe-design"], { ...childEnv }),
    ).rejects.toThrow(/changes protected Design/i);
    await expect(
      git(remote.remote, ["rev-parse", "--verify", "refs/tags/unsafe-design"]),
    ).rejects.toBeDefined();
    await expect(
      git(workspace, ["rev-parse", "--verify", "refs/tags/unsafe-design"]),
    ).rejects.toBeDefined();
    expect(await readFile(path.join(design, "document.json"), "utf8")).toBe(
      '{"safe":true}\n',
    );
  });

  it("keeps push --dry-run free of canonical refs and index side effects", async () => {
    const remoteRoot = path.join(root, "dry-run-remotes");
    const remote = path.join(remoteRoot, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    await git(remoteRoot, ["init", "--bare", "remote.git"]);
    await git(remote, ["config", "http.receivepack", "true"]);
    const username = "dry-user";
    const password = "dry-secret";
    const http = await startSmartHttpGitServer(remoteRoot, username, password);
    httpServers.push(http.server);
    setGitCredentialSourceForTesting({
      supports: () => true,
      async shouldHandle() {
        return true;
      },
      async getCredential() {
        return { username, password };
      },
    });
    await git(workspace, ["remote", "add", "origin", http.url]);
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await writeFile(path.join(workspace, "code.txt"), "dry-run\n");
    await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["commit", "-m", "dry run"], { ...childEnv });

    await git(workspace, ["push", "--dry-run", "origin", "main"], {
      ...childEnv,
    });
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(initialHead);
    await expect(
      git(remote, ["rev-parse", "--verify", "refs/heads/main"]),
    ).rejects.toBeDefined();
  });

  it("preserves a code-only interactive merge conflict through resolution and promotion", async () => {
    await git(workspace, ["checkout", "-b", "conflicting"]);
    await writeFile(path.join(workspace, "code.txt"), "branch\n");
    await git(workspace, ["add", "--", "code.txt"]);
    await git(workspace, ["commit", "-m", "branch side"]);
    await git(workspace, ["checkout", "main"]);
    await writeFile(path.join(workspace, "code.txt"), "main side\n");
    await git(workspace, ["add", "--", "code.txt"]);
    await git(workspace, ["commit", "-m", "main side"]);

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await expect(
      git(workspace, ["merge", "conflicting"], { ...childEnv }),
    ).rejects.toBeDefined();
    expect(
      await git(workspace, ["diff", "--name-only", "--diff-filter=U"], {
        ...childEnv,
      }),
    ).toBe("code.txt");
    await writeFile(path.join(workspace, "code.txt"), "resolved\n");
    await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["commit", "-m", "resolve conflict"], {
      ...childEnv,
    });
    await expect(shadow.synchronize()).resolves.toMatchObject({
      state: "promoted",
    });
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "resolved\n",
    );
  });

  it("serializes two agent sessions with old-OID CAS instead of losing either history", async () => {
    const first = await session({ root: path.join(root, "agent-one") });
    const second = await session({ root: path.join(root, "agent-two") });
    const firstEnv = first.childEnvironment(process.env.PATH);
    const secondEnv = second.childEnvironment(process.env.PATH);

    await writeFile(path.join(workspace, "first.txt"), "one\n");
    await git(workspace, ["add", "--", "first.txt"], { ...firstEnv });
    await git(workspace, ["commit", "-m", "first agent"], { ...firstEnv });

    await writeFile(path.join(workspace, "second.txt"), "two\n");
    await git(workspace, ["add", "--", "second.txt"], { ...secondEnv });
    await git(workspace, ["commit", "-m", "second agent"], { ...secondEnv });

    await expect(first.synchronize()).resolves.toMatchObject({
      state: "promoted",
    });
    await expect(second.synchronize()).rejects.toMatchObject({
      code: "concurrent-git-change",
    });
    expect(await git(workspace, ["log", "-1", "--format=%s"])).toBe(
      "first agent",
    );
  });

  it("runs custom clean/smudge filters inside the private repository", async () => {
    const filter = path.join(workspace, "filter.mjs");
    await writeFile(
      filter,
      [
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => (input += chunk));',
        'process.stdin.on("end", () => process.stdout.write(process.argv[2] === "clean" ? input.toUpperCase() : input.toLowerCase()));',
      ].join("\n"),
    );
    await git(workspace, [
      "config",
      "filter.zeros-test.clean",
      `${process.execPath} ${filter} clean`,
    ]);
    await git(workspace, [
      "config",
      "filter.zeros-test.smudge",
      `${process.execPath} ${filter} smudge`,
    ]);
    await writeFile(
      path.join(workspace, ".gitattributes"),
      "filtered.txt filter=zeros-test\n",
    );
    await git(workspace, ["add", "--", ".gitattributes", "filter.mjs"]);
    await git(workspace, ["commit", "-m", "filter fixture"]);

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await writeFile(path.join(workspace, "filtered.txt"), "Mixed Case\n");
    await git(workspace, ["add", "--", "filtered.txt"], { ...childEnv });
    expect(
      await git(workspace, ["show", ":filtered.txt"], { ...childEnv }),
    ).toBe("MIXED CASE");
    await git(workspace, ["commit", "-m", "filtered content"], {
      ...childEnv,
    });
    await expect(shadow.synchronize()).resolves.toMatchObject({
      state: "promoted",
    });
  });

  it.runIf(spawnSync("git", ["lfs", "version"]).status === 0)(
    "promotes private Git LFS media needed by the canonical repository",
    async () => {
      await git(workspace, ["lfs", "install", "--local"]);
      await writeFile(
        path.join(workspace, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      await git(workspace, ["add", "--", ".gitattributes"]);
      await git(workspace, ["commit", "-m", "track lfs"]);

      const shadow = await session();
      const childEnv = shadow.childEnvironment(process.env.PATH);
      await writeFile(path.join(workspace, "asset.bin"), Buffer.alloc(4096, 7));
      await git(workspace, ["add", "--", "asset.bin"], { ...childEnv });
      await git(workspace, ["commit", "-m", "lfs asset"], { ...childEnv });
      const oid = (
        await git(workspace, ["show", "HEAD:asset.bin"], { ...childEnv })
      ).match(/^oid sha256:([0-9a-f]{64})$/m)?.[1];
      expect(oid).toMatch(/^[0-9a-f]{64}$/);
      await shadow.synchronize();
      const repository = await discoverCanonicalGitRepository(workspace);
      expect(repository).not.toBeNull();
      const canonicalMedia = path.join(
        repository!.commonDir,
        "lfs",
        "objects",
        oid!.slice(0, 2),
        oid!.slice(2, 4),
        oid!,
      );
      expect((await readFile(canonicalMedia)).length).toBe(4096);
    },
  );

  it.runIf(spawnSync("git", ["lfs", "version"]).status === 0)(
    "uploads LFS media before publishing its Git ref through the scoped remote",
    async () => {
      const remote = await authenticatedRemote("lfs-push");
      await git(workspace, ["lfs", "install", "--local"]);
      await writeFile(
        path.join(workspace, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      await git(workspace, ["add", "--", ".gitattributes"]);
      await git(workspace, ["commit", "-m", "track lfs"]);
      await git(workspace, ["push", remote.remote, "main"]);

      const shadow = await session();
      const childEnv = shadow.childEnvironment(process.env.PATH);
      const content = Buffer.alloc(8192, 11);
      await writeFile(path.join(workspace, "remote-asset.bin"), content);
      await git(workspace, ["add", "--", "remote-asset.bin"], {
        ...childEnv,
      });
      await git(workspace, ["commit", "-m", "remote lfs asset"], {
        ...childEnv,
      });
      const oid = (
        await git(workspace, ["show", "HEAD:remote-asset.bin"], {
          ...childEnv,
        })
      ).match(/^oid sha256:([0-9a-f]{64})$/m)?.[1];
      expect(oid).toMatch(/^[0-9a-f]{64}$/);

      await git(workspace, ["push", "origin", "main"], { ...childEnv });

      expect(remote.lfsObjects.get(oid!)?.equals(content)).toBe(true);
      expect(await git(remote.remote, ["rev-parse", "refs/heads/main"])).toBe(
        await git(workspace, ["rev-parse", "HEAD"], { ...childEnv }),
      );
    },
    30_000,
  );

  it.runIf(spawnSync("git", ["lfs", "version"]).status === 0)(
    "does not publish a Git ref when its LFS upload is rejected",
    async () => {
      const remote = await authenticatedRemote("lfs-rejected", {
        rejectLfsUploads: true,
      });
      await git(workspace, ["lfs", "install", "--local"]);
      await writeFile(
        path.join(workspace, ".gitattributes"),
        "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      );
      await git(workspace, ["add", "--", ".gitattributes"]);
      await git(workspace, ["commit", "-m", "track lfs"]);
      await git(workspace, ["push", remote.remote, "main"]);
      const remoteHead = await git(remote.remote, [
        "rev-parse",
        "refs/heads/main",
      ]);

      const shadow = await session();
      const childEnv = shadow.childEnvironment(process.env.PATH);
      await writeFile(
        path.join(workspace, "rejected.bin"),
        Buffer.alloc(512, 5),
      );
      await git(workspace, ["add", "--", "rejected.bin"], { ...childEnv });
      await git(workspace, ["commit", "-m", "rejected lfs asset"], {
        ...childEnv,
      });

      await expect(
        git(workspace, ["push", "origin", "main"], { ...childEnv }),
      ).rejects.toThrow();
      expect(await git(remote.remote, ["rev-parse", "refs/heads/main"])).toBe(
        remoteHead,
      );
      expect(remote.lfsObjects.size).toBe(0);
    },
    30_000,
  );

  it("rejects a forged private LFS object before canonical state advances", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await writeFile(path.join(workspace, "code.txt"), "candidate\n");
    await git(workspace, ["add", "--", "code.txt"], { ...childEnv });
    await git(workspace, ["commit", "-m", "candidate"], { ...childEnv });
    const forgedOid = "a".repeat(64);
    const forgedDirectory = path.join(
      privateRoot,
      "git",
      "lfs",
      "objects",
      "aa",
      "aa",
    );
    await mkdir(forgedDirectory, { recursive: true });
    await symlink(
      path.join(design, "document.json"),
      path.join(forgedDirectory, forgedOid),
    );

    await expect(shadow.synchronize()).rejects.toMatchObject({
      code: "invalid-shadow-repository",
    });
    expect(await git(workspace, ["rev-parse", "HEAD"])).toBe(initialHead);
  });

  it("supports a local submodule through the private metadata view", async () => {
    const moduleSource = path.join(workspace, "module-source");
    await mkdir(moduleSource);
    await git(moduleSource, ["init", "-b", "main"]);
    await git(moduleSource, ["config", "user.name", "Zeros Test"]);
    await git(moduleSource, ["config", "user.email", "zeros@example.invalid"]);
    await writeFile(path.join(moduleSource, "module.txt"), "module\n");
    await git(moduleSource, ["add", "--", "module.txt"]);
    await git(moduleSource, ["commit", "-m", "module"]);
    await git(workspace, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "./module-source",
      "modules/example",
    ]);
    await git(workspace, ["commit", "-m", "add submodule"]);
    await git(workspace, [
      "submodule",
      "deinit",
      "-f",
      "--",
      "modules/example",
    ]);
    await rm(path.join(workspace, "modules", "example"), {
      recursive: true,
      force: true,
    });

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    await git(
      workspace,
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "update",
        "--init",
        "--",
        "modules/example",
      ],
      { ...childEnv },
    );
    expect(
      await readFile(
        path.join(workspace, "modules", "example", "module.txt"),
        "utf8",
      ),
    ).toBe("module\n");
  });

  it("uses a private linked-worktree identity when Git runs from that worktree", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const linked = path.join(workspace, "agent-worktree");
    await git(workspace, ["worktree", "add", "-b", "agent-worktree", linked], {
      ...childEnv,
    });
    await writeFile(path.join(linked, "code.txt"), "linked\n");
    await git(linked, ["add", "--", "code.txt"], { ...childEnv });
    await git(linked, ["commit", "-m", "linked worktree"], { ...childEnv });

    expect(
      await git(linked, ["symbolic-ref", "--short", "HEAD"], {
        ...childEnv,
      }),
    ).toBe("agent-worktree");
    expect(await readFile(path.join(workspace, "code.txt"), "utf8")).toBe(
      "before\n",
    );
    expect(
      await git(
        workspace,
        [
          "diff",
          "--name-only",
          initialHead,
          "agent-worktree",
          "--",
          "Zeros Design",
        ],
        { ...childEnv },
      ),
    ).toBe("");
    await expect(shadow.synchronize()).resolves.toMatchObject({
      state: "promoted",
    });
    await expect(shadow.finalizeLinkedWorktrees()).resolves.toBe(1);
    await shadow.stop();
    await rm(privateRoot, { recursive: true, force: true });
    expect(await readFile(path.join(linked, ".git"), "utf8")).toContain(
      path.join(
        (await discoverCanonicalGitRepository(workspace))!.commonDir,
        "worktrees",
      ),
    );
    expect(await git(linked, ["status", "--short"])).toBe("");
    expect(await git(workspace, ["show", "agent-worktree:code.txt"])).toBe(
      "linked",
    );
  });

  it("brokers linked-worktree pushes and refuses a crafted Design commit", async () => {
    const remote = await authenticatedRemote("linked-push");
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const linked = path.join(workspace, "agent-push-worktree");
    await git(
      workspace,
      ["worktree", "add", "-b", "linked-push", linked],
      childEnv,
    );
    await writeFile(path.join(linked, "code.txt"), "linked push\n");
    await git(linked, ["add", "--", "code.txt"], childEnv);
    await git(linked, ["commit", "-m", "linked push"], childEnv);
    const safeHead = await git(linked, ["rev-parse", "HEAD"], childEnv);

    await git(
      linked,
      ["push", "--set-upstream", "origin", "linked-push"],
      childEnv,
    );
    expect(
      await git(remote.remote, ["rev-parse", "refs/heads/linked-push"]),
    ).toBe(safeHead);

    const linkedDesign = path.join(linked, "Zeros Design", "document.json");
    await writeFile(linkedDesign, '{"safe":false}\n');
    await git(linked, ["add", "--", "Zeros Design/document.json"], childEnv);
    await git(linked, ["commit", "-m", "crafted Design commit"], childEnv);
    await writeFile(linkedDesign, '{"safe":true}\n');

    await expect(
      git(linked, ["push", "origin", "linked-push"], childEnv),
    ).rejects.toThrow(/Design|protected/i);
    expect(
      await git(remote.remote, ["rev-parse", "refs/heads/linked-push"]),
    ).toBe(safeHead);
  });

  it("preserves staged linked-worktree code and its private objects after teardown", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const linked = path.join(workspace, "staged-worktree");
    await git(workspace, ["worktree", "add", "-b", "staged-worktree", linked], {
      ...childEnv,
    });
    await writeFile(path.join(linked, "code.txt"), "staged linked code\n");
    await git(linked, ["add", "--", "code.txt"], { ...childEnv });

    await shadow.synchronize();
    await expect(shadow.finalizeLinkedWorktrees()).resolves.toBe(1);
    await shadow.stop();
    await rm(privateRoot, { recursive: true, force: true });

    expect(await git(linked, ["status", "--short"])).toBe("M  code.txt");
    expect(await git(linked, ["show", ":code.txt"])).toBe("staged linked code");
  });

  it("preserves a detached linked-worktree commit after private state is reclaimed", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const linked = path.join(workspace, "detached-worktree");
    await git(workspace, ["worktree", "add", "--detach", linked, initialHead], {
      ...childEnv,
    });
    await writeFile(path.join(linked, "code.txt"), "detached\n");
    await git(linked, ["add", "--", "code.txt"], { ...childEnv });
    await git(linked, ["commit", "-m", "detached linked commit"], {
      ...childEnv,
    });
    const detachedHead = await git(linked, ["rev-parse", "HEAD"], {
      ...childEnv,
    });

    await shadow.synchronize();
    await shadow.finalizeLinkedWorktrees();
    await shadow.stop();
    await rm(privateRoot, { recursive: true, force: true });

    expect(await git(linked, ["rev-parse", "HEAD"])).toBe(detachedHead);
    expect(await git(linked, ["show", "HEAD:code.txt"])).toBe("detached");
  });

  it.each([
    "recovery-copy-ready",
    "recovery-pointer-committed",
    "recovery-source-removed",
  ] as const)(
    "recovers a linked-worktree preservation crash at %s without a broken .git pointer",
    async (crashPhase) => {
      const sessionState = path.join(sessionsRoot(), `linked-${crashPhase}`);
      const generationRoot = path.join(
        sessionState,
        "boundary",
        "00000000-0000-4000-8000-000000000099",
      );
      const shadow = await session({
        root: generationRoot,
        checkpoint(phase) {
          if (phase !== crashPhase) return;
          throw Object.assign(new Error(`simulated ${phase}`), {
            zsrSimulatedCrash: true,
          });
        },
      });
      const childEnv = shadow.childEnvironment(process.env.PATH);
      const linked = path.join(workspace, `linked-${crashPhase}`);
      await git(
        workspace,
        ["worktree", "add", "-b", `branch-${crashPhase}`, linked],
        { ...childEnv },
      );
      await writeFile(path.join(linked, "code.txt"), `${crashPhase}\n`);
      await git(linked, ["add", "--", "code.txt"], { ...childEnv });
      await shadow.synchronize();

      await expect(
        shadow.preserveForRecovery(new Error("teardown failed")),
      ).rejects.toThrow(`simulated ${crashPhase}`);
      expect(
        await readFile(
          path.join(sessionState, SHADOW_GIT_RECOVERY_HOLD_FILE),
          "utf8",
        ),
      ).toContain("recoveryId");

      const recovered = await recoverShadowGitPreservations();
      expect(recovered).toMatchObject({ recovered: 1, preserved: 0 });
      await expect(
        readFile(
          path.join(sessionState, SHADOW_GIT_RECOVERY_HOLD_FILE),
          "utf8",
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const pointer = await readFile(path.join(linked, ".git"), "utf8");
      expect(pointer).toContain(path.join("recovery", "shadow-git"));
      expect(pointer).not.toContain(generationRoot);

      await rm(sessionState, { recursive: true, force: true });
      expect(await git(linked, ["status", "--short"])).toBe("M  code.txt");
      expect(await git(linked, ["show", ":code.txt"])).toBe(crashPhase);
    },
  );

  it("preserves a linked-worktree merge conflict for later resolution", async () => {
    await git(workspace, ["checkout", "-b", "conflict-left"]);
    await writeFile(path.join(workspace, "code.txt"), "left\n");
    await git(workspace, ["commit", "-am", "left"]);
    await git(workspace, ["checkout", "main"]);
    await git(workspace, ["checkout", "-b", "conflict-right"]);
    await writeFile(path.join(workspace, "code.txt"), "right\n");
    await git(workspace, ["commit", "-am", "right"]);
    const rightHead = await git(workspace, ["rev-parse", "HEAD"]);
    await git(workspace, ["checkout", "main"]);

    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const linked = path.join(workspace, "conflicted-worktree");
    await git(
      workspace,
      ["worktree", "add", "-b", "conflicted-worktree", linked, "conflict-left"],
      { ...childEnv },
    );
    await expect(
      git(linked, ["merge", "conflict-right"], { ...childEnv }),
    ).rejects.toThrow();

    await shadow.synchronize();
    await shadow.finalizeLinkedWorktrees();
    await shadow.stop();
    await rm(privateRoot, { recursive: true, force: true });

    expect(await git(linked, ["status", "--short"])).toContain("UU code.txt");
    expect(await git(linked, ["rev-parse", "MERGE_HEAD"])).toBe(rightHead);
  });

  it("refuses to persist a linked-worktree index that stages protected Design", async () => {
    const shadow = await session();
    const childEnv = shadow.childEnvironment(process.env.PATH);
    const linked = path.join(workspace, "protected-worktree");
    await git(
      workspace,
      ["worktree", "add", "-b", "protected-worktree", linked],
      { ...childEnv },
    );
    await writeFile(
      path.join(linked, "Zeros Design", "design.json"),
      '{"version":999}\n',
    );
    await git(linked, ["add", "--", "Zeros Design/design.json"], {
      ...childEnv,
    });

    await shadow.synchronize();
    await expect(shadow.finalizeLinkedWorktrees()).rejects.toMatchObject({
      code: "design-impact",
    });
    expect(await readFile(path.join(linked, ".git"), "utf8")).toContain(
      privateRoot,
    );
  });
});
