import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { CLIENT_A, WORKSPACE_ID, browserFrame, config } from "./worker-fixtures";
import { GithubBroker, githubEnvironment } from "../credentials/github";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
let directory: string, dist: string, runtime: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "worker-package-"));
  const built = join(directory, "build-output"); dist = join(directory, "relocated worker", "worker");
  await exec(process.execPath, [join(packageRoot, "scripts/build.mjs"), "--outdir", built], { cwd: packageRoot, env: workerChildEnvironment(), timeout: 90_000, maxBuffer: 1024 * 1024 });
  // Move out of the build location and away from every repository node_modules.
  runtime = join(dirname(dist), "runtime", "a".repeat(64));
  await mkdir(dirname(runtime), { recursive: true });
  await rename(built, runtime);
  await symlink(runtime, dist, "dir");
}, 100_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it("refuses to replace an existing output directory that is not a worker build", async () => {
  const other = join(directory, "unrelated"); await mkdir(other); await writeFile(join(other, "keep.txt"), "keep");
  await expect(exec(process.execPath, [join(packageRoot, "scripts/build.mjs"), "--outdir", other], { cwd: packageRoot, env: workerChildEnvironment(), timeout: 90_000 })).rejects.toThrow();
  expect(await readFile(join(other, "keep.txt"), "utf8")).toBe("keep");
});

it("ships a relocatable dependency graph and a complete SHA-256 inventory", async () => {
  expect((await lstat(dist)).isSymbolicLink()).toBe(true); expect(await realpath(dist)).toBe(runtime);
  const manifest = JSON.parse(await readFile(join(dist, "runtime-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ node: "24", platform: process.platform, arch: process.arch,
    pins: { "@openai/codex": "0.164.0", "@anthropic-ai/claude-agent-sdk": "0.3.311", "@cursor/sdk": "1.1.0", "node-pty": "1.1.0" } });
  const files: string[] = [];
  async function walk(relative = ""): Promise<void> {
    for (const entry of await readdir(join(dist, relative), { withFileTypes: true })) {
      expect(entry.isSymbolicLink()).toBe(false);
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path); else if (path !== "runtime-manifest.json") files.push(path);
    }
  }
  await walk(); expect(Object.keys(manifest.files).sort()).toEqual(files.sort());
  for (const name of ["worker.mjs", "cursor-host.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"])
    expect(files).toContain(name);
  // Hash the native executables too, not only their package manifests.
  for (const name of files) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(dist, name))) hash.update(chunk);
    expect(hash.digest("hex"), name).toBe(manifest.files[name].sha256);
  }
  expect(files.some(name => name.includes("claude-agent-sdk-linux-") && name.endsWith("/claude"))).toBe(true);
  expect(files.some(name => name.includes("codex-linux-") && name.endsWith("/codex"))).toBe(true);
  expect(files.some(name => name.includes("@cursor/sdk-linux-") && name.endsWith("/rg"))).toBe(true);
}, 60_000);

it("loads pinned binaries and SDKs through the runtime symlink without the checkout or pnpm store", async () => {
  const script = `
    import { createRequire } from 'node:module';
    import { dirname, join } from 'node:path';
    import { realpathSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    import { execFileSync } from 'node:child_process';
    import assert from 'node:assert/strict';
    const require = createRequire(new URL('./worker.mjs', import.meta.url));
    await import('@anthropic-ai/claude-agent-sdk');
    await import('@cursor/sdk');
    const root = dirname(fileURLToPath(import.meta.url));
    const codexManifest = require.resolve('@openai/codex/package.json');
    const codex = join(dirname(codexManifest), 'bin/codex.js');
    const claudeSdk = require.resolve('@anthropic-ai/claude-agent-sdk');
    const claude = createRequire(claudeSdk).resolve('@anthropic-ai/claude-agent-sdk-' + process.platform + '-' + process.arch + '/claude');
    for (const path of [codex, claude, require.resolve('@cursor/sdk')]) assert(realpathSync(path).startsWith(root + '/node_modules/'));
    assert.equal(require(codexManifest).version, '0.164.0');
    assert.equal(require(join(dirname(claudeSdk), 'package.json')).version, '0.3.311');
    assert.equal(require(join(dirname(claude), 'package.json')).version, '0.3.311');
    assert.match(execFileSync(process.execPath, [codex, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }), /0\\.164\\.0/);
    assert.match(execFileSync(claude, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }), /2\\.1\\.311 \\(Claude Code\\)/);
    const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf WORKER_NATIVE_OK'], {cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'}});
    let output=''; pty.onData(data=>{output+=data});
    pty.onExit(({exitCode})=>{process.exitCode=exitCode===0&&output.includes('WORKER_NATIVE_OK')?0:1;});
  `;
  const path = join(dist, "native-smoke.mjs"); await writeFile(path, script);
  const result = await exec(process.execPath, [path], { cwd: directory, env: { ...workerChildEnvironment(), HOME: directory }, timeout: 25_000, maxBuffer: 1024 * 1024 });
  expect(result.stderr).toBe(""); await rm(path);
}, 30_000);

it("boots the relocated Cursor host with its real pinned SDK over IPC without contacting a provider", async () => {
  const child = spawn(process.execPath, [join(dist, "cursor-host.mjs")], { cwd: directory,
    env: { ...workerChildEnvironment(), CURSOR_API_KEY: "fixture-offline-key" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const reply = new Promise((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", () => reject(new Error("Cursor host exited before replying.")));
    });
    child.send({ id: 1, method: "unsupported-offline-probe", params: {} });
    await expect(reply).resolves.toEqual({ t: "reply", id: 1, error: "Unsupported Cursor host request." });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
  }
});

it("resolves askpass and gh wrappers through a runtime symlink, including spaces", async () => {
  let requests = 0;
  const broker = new GithubBroker(join(directory, "askpass.sock"), async () => { requests++; return { token: "fixture-package-github", expiresAt: Date.now() + 60_000 }; });
  await broker.start();
  try {
    const executable = join(dist, "bin/git-askpass");
    const result = await exec(executable, ["Password for 'https://x-access-token@github.com': "], {
      cwd: directory, env: workerChildEnvironment(undefined, githubEnvironment(broker.socketPath, executable)), timeout: 10_000,
    });
    expect(result.stdout === "fixture-package-github\n").toBe(true); expect(result.stderr).toBe("");
    const git = spawn("git", ["credential", "fill"], { cwd: directory,
      env: { ...workerChildEnvironment(undefined, githubEnvironment(broker.socketPath, executable)), HOME: directory }, stdio: ["pipe", "pipe", "pipe"] });
    let credentials = "", errors = "";
    git.stdout.on("data", data => { credentials += data; }); git.stderr.on("data", data => { errors += data; });
    const closed = once(git, "close"); git.stdin.end("protocol=https\nhost=github.com\n\n");
    const [code] = await closed;
    expect(code).toBe(0); expect(errors).toBe("");
    expect(credentials.includes("password=fixture-package-github\n")).toBe(true);
    expect(credentials.includes("username=x-access-token\n")).toBe(true);
    // Only the final OS gh process is substituted: test hosts need not install
    // Boat's /usr/bin/gh, and this smoke must never contact GitHub.
    const gh = await exec(join(dist, "bin/gh"), ["--version"], {
      cwd: directory, env: { ...workerChildEnvironment(undefined, githubEnvironment(broker.socketPath, executable)),
        NODE_OPTIONS: `--import=${new URL("./fixtures/gh-launch.mjs", import.meta.url).href}` }, timeout: 10_000,
    });
    expect(gh.stdout.startsWith("gh version ")).toBe(true); expect(gh.stderr).toBe(""); expect(requests).toBe(3);
  } finally { await broker.dispose(); }
});

it("boots through the runtime symlink, waits for a token, serves a dial-in PTY and mirrors over HTTP", async () => {
  const { root, scope, git } = await repositoryFixture();
  const origin = join(directory, "origin.git"); await git("clone", "--bare", root, origin); await git("remote", "add", "origin", origin);
  const tokenFile = join(directory, "token"), state = join(directory, "state");
  const keys = generateKeyPairSync("ed25519");
  const publicKeys = [keys.publicKey.export({ type: "spki", format: "pem" }).toString()];
  // Reserve an ephemeral test port; production has no bind-address override.
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const initialToken = "fixture-package-worker", rotatedToken = "fixture-rotated-package-worker";
  const messages: any[] = [], requests: Array<{ path: string; generation: "initial" | "rotated" | null; chatIds: string[] }> = [];
  let bootId = "";
  const server = createServer(async (request, response) => {
    const path = request.url!.split("/").at(-1)!;
    // A request may already be in flight while the credential file rotates.
    // Classify its actual header, then require the new history mutation below
    // to use the rotated token. A mutable expectation after reading the body
    // incorrectly marks an authenticated in-flight request as unauthenticated.
    const generation = request.headers.authorization === `Bearer ${initialToken}` ? "initial"
      : request.headers.authorization === `Bearer ${rotatedToken}` ? "rotated" : null;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path, generation, chatIds: (body.chats ?? []).map((chat: { id: string }) => chat.id) });
    if (!generation) { response.writeHead(401).end(); return; }
    if (path === "hello") bootId = body.bootId;
    const value = path === "hello" || path === "config" ? { config: { ...config, workspace: scope.workspace, agents: {} } }
      : path === "history" ? { sequence: body.sequence }
      : path === "activity" ? { state: "running", loginRevision: "0" }
      : { token: "fixture-package-github", expiresAt: Date.now() + 60_000 };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const harness = join(dist, "boot-smoke.mjs");
  await writeFile(harness, `import { startWorker, readBootEnvironment } from './worker.mjs';\nstartWorker({...readBootEnvironment(),tokenFile:${JSON.stringify(tokenFile)},directory:${JSON.stringify(state)},publicKeys:${JSON.stringify(publicKeys)},port:${port}});\n`);
  let child: ChildProcess | undefined, socket: WebSocket | undefined; let output = "";
  try {
    child = spawn(process.execPath, [harness], { cwd: directory, env: { ...workerChildEnvironment(), HOME: root,
      CLOUD_V2_API_URL: `http://127.0.0.1:${address.port}`, CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), ZEROS_WORKSPACE_ID: WORKSPACE_ID }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
    await expect.poll(() => output.includes("credential-unavailable")).toBe(true);
    expect(child.exitCode).toBeNull(); expect(requests).toEqual([]);
    await writeFile(tokenFile, initialToken, { mode: 0o600 }); await chmod(tokenFile, 0o600);
    await expect.poll(() => bootId, { timeout: 5000 }).not.toBe("");
    const now = Math.floor(Date.now() / 1000);
    const payload = `v1.${Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: WORKSPACE_ID, boot: bootId, iat: now, exp: now + 60, jti: randomUUID() })).toString("base64url")}`;
    const grant = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`;
    socket = new WebSocket(`ws://127.0.0.1:${port}/v2/worker/bridge`, "zeros.cloud.v2.worker", { headers: { "X-Zeros-Worker-Auth": grant, Cookie: "_port_auth=fixture-private-route-token" } });
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()); messages.push(message);
      if (message.t === "frame" && message.frame.type === "ENGINE_READY")
        socket!.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame: browserFrame("PTY_CREATE", { sessionId: "package-shell" }) }));
      if (message.t === "frame" && message.frame.type === "PTY_CREATED")
        socket!.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame: browserFrame("PTY_WRITE", { sessionId: "package-shell", data: "printf 'BUNDLED_PTY_OK\\n'\n" }) }));
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ t: "open", clientId: CLIENT_A }));
    await expect.poll(() => messages.some(message => message.t === "frame" && message.frame.type === "PTY_DATA"
      && message.frame.data.includes("BUNDLED_PTY_OK")), { timeout: 5000 }).toBe(true);
    expect(requests.some(request => request.path === "hello" && request.generation === "initial")).toBe(true);
    await writeFile(`${tokenFile}.next`, rotatedToken, { mode: 0o600 });
    await rename(`${tokenFile}.next`, tokenFile);
    socket.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame: browserFrame("WORKSPACE_REQUEST", { op: "chats.upsert", params: {
      chat: { id: "package-chat", folder: root, agentId: "codex", title: "Fixture", createdAt: 100 },
    } }) }));
    await expect.poll(() => requests.find(request => request.path === "history" && request.chatIds.includes("package-chat"))?.generation).toBe("rotated");
    expect(requests.every(request => request.generation !== null)).toBe(true);
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    expect(child.exitCode).toBe(0);
    for (const secret of [initialToken, rotatedToken, "fixture-private-route-token", grant]) expect(output.includes(secret)).toBe(false);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    socket?.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(harness, { force: true });
  }
});

it("rejects invalid boot configuration without printing its contents", async () => {
  const result = await exec(process.execPath, [join(dist, "worker.mjs")], { cwd: directory,
    env: { ...workerChildEnvironment(), CLOUD_V2_API_URL: "https://fixture-login:fixture-secret@example.invalid", CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), ZEROS_WORKSPACE_ID: WORKSPACE_ID }, timeout: 10_000,
  }).then(() => undefined, error => error as { code: number; stderr: string });
  expect(result).toMatchObject({ code: 1, stderr: "cloud-worker invalid-boot-configuration\n" });
});

it("imports its helpers when the calling process has no file entry", async () => {
  const source = `await import(${JSON.stringify(pathToFileURL(join(dist, "worker.mjs")).href)}); process.stdout.write('WORKER_IMPORT_OK');`;
  const result = await exec(process.execPath, ["--input-type=module", "-e", source, "-"], { cwd: directory, env: workerChildEnvironment(), timeout: 10_000 });
  expect(result.stdout).toBe("WORKER_IMPORT_OK"); expect(result.stderr).toBe("");
});
