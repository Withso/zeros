import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { CLIENT_A, WORKSPACE_ID, browserFrame, config } from "./worker-fixtures";
import { GithubBroker, githubEnvironment } from "../credentials/github";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
let directory: string, dist: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "worker-package-"));
  const built = join(directory, "build-output"); dist = join(directory, "relocated worker", "worker");
  await exec(process.execPath, [join(packageRoot, "scripts/build.mjs"), "--outdir", built], { cwd: packageRoot, env: workerChildEnvironment(), timeout: 90_000, maxBuffer: 1024 * 1024 });
  // Move out of the build location and away from every repository node_modules.
  await mkdir(dirname(dist));
  await rename(built, dist);
}, 100_000);
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it("refuses to replace an existing output directory that is not a worker build", async () => {
  const other = join(directory, "unrelated"); await mkdir(other); await writeFile(join(other, "keep.txt"), "keep");
  await expect(exec(process.execPath, [join(packageRoot, "scripts/build.mjs"), "--outdir", other], { cwd: packageRoot, env: workerChildEnvironment(), timeout: 90_000 })).rejects.toThrow();
  expect(await readFile(join(other, "keep.txt"), "utf8")).toBe("keep");
});

it("ships a relocatable dependency graph and a complete SHA-256 inventory", async () => {
  const manifest = JSON.parse(await readFile(join(dist, "runtime-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ node: "24", platform: process.platform, arch: process.arch,
    pins: { "@openai/codex": "0.162.1", "@anthropic-ai/claude-agent-sdk": "0.3.296", "@cursor/sdk": "1.0.37", "node-pty": "1.1.0" } });
  const files: string[] = [];
  async function walk(relative = ""): Promise<void> {
    for (const entry of await readdir(join(dist, relative), { withFileTypes: true })) {
      expect(entry.isSymbolicLink()).toBe(false);
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path); else if (path !== "runtime-manifest.json") files.push(path);
    }
  }
  await walk(); expect(Object.keys(manifest.files).sort()).toEqual(files.sort());
  for (const name of ["worker.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"])
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

it("loads all external SDKs and runs node-pty without the checkout or pnpm store", async () => {
  const script = `
    import { createRequire } from 'node:module';
    const require = createRequire(new URL('./worker.mjs', import.meta.url));
    await import('@anthropic-ai/claude-agent-sdk');
    await import('@cursor/sdk');
    require.resolve('@openai/codex/package.json');
    const pty = require('node-pty').spawn('/bin/sh', ['-c', 'printf WORKER_NATIVE_OK'], {cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'}});
    let output=''; pty.onData(data=>{output+=data});
    pty.onExit(({exitCode})=>{process.exitCode=exitCode===0&&output.includes('WORKER_NATIVE_OK')?0:1;});
  `;
  const path = join(dist, "native-smoke.mjs"); await writeFile(path, script);
  const result = await exec(process.execPath, [path], { cwd: directory, env: workerChildEnvironment(), timeout: 15_000, maxBuffer: 1024 * 1024 });
  expect(result.stderr).toBe(""); await rm(path);
});

it("resolves the executable askpass wrapper after relocation, including spaces", async () => {
  const broker = new GithubBroker(join(directory, "askpass.sock"), async () => ({ token: "fixture-package-github", expiresAt: Date.now() + 60_000 }));
  await broker.start();
  try {
    const executable = join(dist, "bin/git-askpass");
    const result = await exec(executable, ["Password for 'https://x-access-token@github.com': "], {
      cwd: directory, env: workerChildEnvironment(undefined, githubEnvironment(broker.socketPath, executable)), timeout: 10_000,
    });
    expect(result.stdout).toBe("fixture-package-github\n"); expect(result.stderr).toBe("");
  } finally { await broker.dispose(); }
});

it("boots the relocated entry, waits for a token, connects to a fake relay, and shuts down", async () => {
  const { root, scope, git } = await repositoryFixture();
  const origin = join(directory, "origin.git"); await git("clone", "--bare", root, origin); await git("remote", "add", "origin", origin);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No relay fixture address.");
  const tokenFile = join(directory, "token"), state = join(directory, "state");
  const messages: Array<Record<string, unknown>> = []; let authenticated = false;
  server.on("connection", (socket, request) => {
    authenticated = request.headers.authorization === "Bearer fixture-package-worker";
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()); messages.push(message);
      if (message.t === "hello") {
        socket.send(JSON.stringify({ ...config, workspace: scope.workspace, agents: {} }));
        socket.send(JSON.stringify({ t: "open", clientId: CLIENT_A }));
      }
      if (message.t === "frame" && message.frame.type === "ENGINE_READY")
        socket.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame: browserFrame("PTY_CREATE", { sessionId: "package-shell" }) }));
      if (message.t === "frame" && message.frame.type === "PTY_CREATED")
        socket.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame: browserFrame("PTY_WRITE", { sessionId: "package-shell", data: "printf 'BUNDLED_PTY_OK\\n'\n" }) }));
    });
  });
  const harness = join(dist, "boot-smoke.mjs");
  await writeFile(harness, `import { startWorker, readBootEnvironment } from './worker.mjs';\nstartWorker({...readBootEnvironment(),tokenFile:${JSON.stringify(tokenFile)},directory:${JSON.stringify(state)}});\n`);
  let child: ChildProcess | undefined; let output = "";
  try {
    child = spawn(process.execPath, [harness], { cwd: directory, env: { ...workerChildEnvironment(), HOME: root, ZEROS_WORKER_URL: `ws://127.0.0.1:${address.port}/v2/cloud/worker`, ZEROS_WORKSPACE_ID: WORKSPACE_ID }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
    await expect.poll(() => output.includes("credential-unavailable")).toBe(true);
    expect(child.exitCode).toBeNull(); expect(messages).toEqual([]);
    await writeFile(tokenFile, "fixture-package-worker", { mode: 0o600 }); await chmod(tokenFile, 0o600);
    await expect.poll(() => messages.length > 0, { timeout: 5000 }).toBe(true);
    expect(authenticated).toBe(true); expect(messages[0]).toMatchObject({ t: "hello", protocol: 1 });
    await expect.poll(() => messages.some(message => message.t === "frame" && (message.frame as { type: string; data?: string }).type === "PTY_DATA"
      && (message.frame as { data: string }).data.includes("BUNDLED_PTY_OK")), { timeout: 5000 }).toBe(true);
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    expect(child.exitCode).toBe(0); expect(output).not.toContain("fixture-package-worker");
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(harness, { force: true });
  }
});

it("rejects invalid boot configuration without printing its contents", async () => {
  const result = await exec(process.execPath, [join(dist, "worker.mjs")], { cwd: directory,
    env: { ...workerChildEnvironment(), ZEROS_WORKER_URL: "wss://fixture-login:fixture-secret@example.invalid", ZEROS_WORKSPACE_ID: WORKSPACE_ID }, timeout: 10_000,
  }).then(() => undefined, error => error as { code: number; stderr: string });
  expect(result).toMatchObject({ code: 1, stderr: "cloud-worker invalid-boot-configuration\n" });
});
