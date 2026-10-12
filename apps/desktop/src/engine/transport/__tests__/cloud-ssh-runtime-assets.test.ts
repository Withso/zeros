import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudRuntimeHumanServices } from "../cloud-human-services";
import { CloudHumanWorkloads } from "../cloud-human-workloads";
import { testCloudRuntime, testCloudWorker } from "../../agents/__tests__/helpers/test-cloud-runtime";
import type { CloudExecutionBoundary } from "../../agents/containment/cloud-execution-boundary";
import { lfsLoginRuntime, runtimeLfsLoginFixture } from "../../../../../../scripts/__tests__/fixtures/runtime-system-assets/login-fixture";

vi.mock("../../agents/containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../../agents/containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: () => testCloudRuntime(),
}));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: (file: Parameters<typeof fs.lstatSync>[0]) =>
    String(file).startsWith(`${testCloudRuntime().workerRoot}/`)
      ? { uid: 0, mode: 0o444, isFile: () => true, isSymbolicLink: () => false } : fs.lstatSync(file) };
});
const require = createRequire(import.meta.url), { Client } = require("ssh2");
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const runtime = testCloudRuntime();
const expected = [`${runtime.workerRoot}/gitconfig`, `/opt/zeros-infra/.git-exec/${runtime.runtimeId}`, `${runtime.workerRoot}/design-fonts/fonts.conf`, `${runtime.workerRoot}/design-fonts`];
const command = 'printf "%s\\n" "${GIT_CONFIG_SYSTEM-unset}" "${GIT_EXEC_PATH-unset}" "${FONTCONFIG_FILE-unset}" "${FONTCONFIG_PATH-unset}"';
const clientEnv = { GIT_CONFIG_SYSTEM: "/client/gitconfig-trap", GIT_EXEC_PATH: "/client/git-exec-trap", FONTCONFIG_FILE: "/client/fontconfig-trap", FONTCONFIG_PATH: "/client/fonts-trap" };
async function directory() {
  await mkdir(path.resolve(".context"), { recursive: true });
  const root = await mkdtemp(path.resolve(".context/ssh-assets-"));
  cleanup.push(() => rm(root, { recursive: true, force: true })); return root;
}
async function connect(stream: Duplex) {
  const client = new Client(); cleanup.push(() => client.destroy());
  const ready = new Promise<void>((resolve, reject) => { client.once("ready", resolve); client.once("error", reject); });
  client.connect({ sock: stream, username: "zeros", authHandler: ["none"], readyTimeout: 3000 });
  await ready; return client;
}
function exec(client: any, pty: boolean, shellCommand = command) {
  return new Promise<string[]>((resolve, reject) => {
    client.exec(shellCommand, { env: clientEnv, ...(pty ? { pty: { cols: 80, rows: 24, term: "xterm" } } : {}) }, (error: Error | null, channel: any) => {
      if (error) { reject(error); return; } let stdout = "";
      channel.on("data", (data: Buffer) => { stdout += String(data); });
      channel.on("error", reject); channel.on("close", (code: number) => {
        if (code !== 0) reject(new Error(`SSH fixture shell failed (${code}): ${stdout}`)); else resolve(stdout.trim().split(/\r?\n/));
      });
    });
  });
}

describe("cloud SSH runtime selectors", () => {
  it.runIf(process.platform === "linux" && !!lfsLoginRuntime).each([false, true])(
    "pins real LFS filters and plain git lfs after a login profile resets PATH (PTY=%s)", async pty => {
      const root = await directory(), fixture = await runtimeLfsLoginFixture(root);
      vi.spyOn(CloudHumanWorkloads.prototype, "spawnProcess").mockImplementation(async (command, args, options) =>
        spawn("/usr/bin/setpriv", [...fixture.namespace, command, ...args], { ...options, cwd: root }));
      vi.spyOn(CloudHumanWorkloads.prototype, "spawnPty").mockImplementation(async (command, args, options) =>
        require("node-pty").spawn("/usr/bin/setpriv", [...fixture.namespace, command, ...args], { ...options, cwd: root }));
      const service = new CloudRuntimeHumanServices(testCloudWorker(), () => [], undefined, {} as CloudExecutionBoundary);
      cleanup.push(() => service.pause());
      const opened = await service.open({ version: 1, audience: "zeros-cloud-runtime-access-admission-v1", admitted: true,
        grantId: "fixture", accountUserId: "fixture", authorityEpoch: 1, expiresAtMs: Date.now() + 20_000, kind: "ssh", remotePort: null });
      const client = await connect(opened.stream), output = await exec(client, pty, fixture.command);
      expect(output.some(line => line.startsWith("git-lfs/3.7.1 "))).toBe(true);
      expect(output).toContain("P5_LFS_OK");
    }, 30_000);

  it.each([false, true])("reaches the actual service shell (PTY=%s) without admitting client overrides", async pty => {
    const root = await directory();
    vi.spyOn(CloudHumanWorkloads.prototype, "spawnProcess").mockImplementation(async (command, args, options) =>
      spawn(command, args, { ...options, cwd: root }));
    vi.spyOn(CloudHumanWorkloads.prototype, "spawnPty").mockImplementation(async (command, args, options) =>
      require("node-pty").spawn(command, args, { ...options, cwd: root }));
    const service = new CloudRuntimeHumanServices(testCloudWorker(), () => [], undefined, {} as CloudExecutionBoundary);
    cleanup.push(() => service.pause());
    const opened = await service.open({ version: 1, audience: "zeros-cloud-runtime-access-admission-v1", admitted: true,
      grantId: "fixture", accountUserId: "fixture", authorityEpoch: 1, expiresAtMs: Date.now() + 5000, kind: "ssh", remotePort: null });
    const client = await connect(opened.stream);
    expect(await exec(client, pty)).toEqual(expected);
  });

  it("selects the same physical runtime in the standalone entry", async () => {
    const root = await directory(), transport = path.join(root, "transport"), containment = path.join(root, "agents/containment");
    await mkdir(transport); await mkdir(containment, { recursive: true });
    const script = path.join(transport, "cloud-ssh-session.mjs"), preload = path.join(root, "fixture.mjs");
    await copyFile(path.resolve("apps/desktop/src/engine/transport/cloud-ssh-session.mjs"), script);
    await copyFile(path.resolve("apps/desktop/src/engine/agents/containment/cloud-runtime-assets.mjs"), path.join(containment, "cloud-runtime-assets.mjs"));
    await writeFile(path.join(containment, "cloud-runtime-root.mjs"), `export const resolveCloudRuntimeChild=()=>(${JSON.stringify(runtime)});`);
    // Only VM identity/absolute cwd differ here. Run the real standalone entry
    // and protocol, without needing a privileged host or changing its files.
    await writeFile(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const realpath=fs.realpathSync,spawn=cp.spawn;fs.realpathSync=(file,...args)=>file==='/srv/zeros/workspace'?file:realpath(file,...args);
cp.spawn=(command,args,options)=>spawn(command,args,{...options,cwd:${JSON.stringify(root)}});
process.geteuid=()=>10003;process.getegid=()=>10003;syncBuiltinESMExports();`);
    const child = spawn(process.execPath, ["--import", preload, script], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    cleanup.push(async () => { child.kill("SIGTERM"); await exited; });
    const payload = new PassThrough(); let prefix = Buffer.alloc(0), introduced = false;
    const introduction = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH fixture introduction timed out")), 5000);
      child.once("error", reject); child.stderr.resume();
      child.stdout.on("data", (data: Buffer) => {
        if (introduced) { payload.write(data); return; }
        prefix = Buffer.concat([prefix, data]); const newline = prefix.indexOf(10);
        if (newline < 0) return;
        const intro = JSON.parse(prefix.subarray(0, newline).toString());
        expect(intro.kind).toBe("ssh"); introduced = true; clearTimeout(timer);
        payload.write(prefix.subarray(newline + 1)); resolve();
      });
    });
    await introduction;
    const client = await connect(Duplex.from({ readable: payload, writable: child.stdin }));
    expect(await exec(client, false)).toEqual(expected);
  });
});
