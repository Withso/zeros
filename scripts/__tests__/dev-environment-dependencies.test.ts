import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repository = path.resolve(import.meta.dirname, "../..");
const directories: string[] = [];
const scripts = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).scripts;

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A synced checkout has source and root dependencies, but neither independent
 * deployment's node_modules. Keep the real package entrypoint/bootstrap and use
 * local package-manager doubles, so this cannot allocate provider resources. */
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dependencies-"));
  directories.push(directory);
  const root = path.join(directory, "synced checkout"), home = path.join(directory, "home");
  const bin = path.join(directory, "bin"), dev = path.join(root, "scripts/dev-environment");
  for (const target of [root, home, bin, dev]) fs.mkdirSync(target, { recursive: true });
  const write = (name: string, data: unknown) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data));
  };
  write("package.json", { type: "module", packageManager: "pnpm@10.28.0", dependencies: { esbuild: "1.0.0" }, devDependencies: { tsx: "1.0.0" }, scripts });
  write("pnpm-lock.yaml", "root-lock-v1\n");
  write("pnpm-workspace.yaml", 'packages:\n  - "apps/marketing"\n  - "packages/*"\n');
  write("apps/control-plane/package.json", { dependencies: { "@aws-sdk/client-s3": "1.0.0", pg: "1.0.0" } });
  write("apps/control-plane/pnpm-lock.yaml", "backend-lock-v1\n");
  write("apps/control-plane/pnpm-workspace.yaml", "onlyBuiltDependencies: []\n");
  write("apps/web/package.json", { devDependencies: { wrangler: "1.0.0" } });
  write("apps/web/package-lock.json", { lockfileVersion: 3, packages: {} });
  write("apps/marketing/package.json", { devDependencies: { astro: "1.0.0" } });
  write("packages/protocol/package.json", { dependencies: { zod: "1.0.0" } });
  for (const name of ["hosted-entry.mjs", "dependencies.mjs", "processes.mjs", "state.mjs", "provider-http.mjs"]) {
    const source = path.join(repository, "scripts/dev-environment", name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dev, name));
  }
  write("scripts/dev-environment/hosted-launcher.mjs", `
    import 'esbuild';
    import { createRequire } from 'node:module';
    import fs from 'node:fs';
    const require = createRequire(new URL('../../apps/control-plane/package.json', import.meta.url));
    require('@aws-sdk/client-s3'); require('pg');
    fs.statSync(new URL('../../apps/web/node_modules/wrangler/package.json', import.meta.url));
    console.log('HOSTED_READY ' + process.argv.slice(2).join(' '));
  `);
  const installer = path.join(directory, "install.cjs");
  fs.writeFileSync(installer, `
    const fs = require('node:fs'), path = require('node:path');
    const root = ${JSON.stringify(root)};
    const args = process.argv.slice(2), command = args.shift();
    const options = fs.existsSync(path.join(root, 'installer.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'installer.json'))) : {};
    const index = args.findIndex(arg => ['--dir', '--prefix'].includes(arg));
    const relative = index < 0 ? '.' : args[index + 1];
    if (process.env.ZEROS_DEV_PROFILE_B64 || process.env.DATABASE_URL) throw new Error('Provider credentials reached installer');
    fs.appendFileSync(path.join(root, 'installs.jsonl'), JSON.stringify({ command, args, relative }) + '\\n');
    if (options.fail === relative) process.exit(19);
    setTimeout(() => {
      const base = path.join(root, relative);
      const folders = relative === '.' ? ['.', 'apps/marketing', 'packages/protocol'] : [relative];
      for (const folder of folders) {
        const owner = path.join(root, folder), manifest = JSON.parse(fs.readFileSync(path.join(owner, 'package.json')));
        for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
          const location = path.join(owner, 'node_modules', name);
          fs.rmSync(location, { recursive: true, force: true });
          fs.mkdirSync(location, { recursive: true });
          fs.writeFileSync(path.join(location, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs' }));
          fs.writeFileSync(path.join(location, 'index.cjs'), 'module.exports = {};');
        }
      }
      const lock = command === 'npm' ? ['package-lock.json', '.package-lock.json'] : ['pnpm-lock.yaml', '.pnpm/lock.yaml'];
      const destination = path.join(base, 'node_modules', lock[1]);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(base, lock[0]), destination);
    }, options.delay || 0);
  `);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  for (const command of ["pnpm", "npm"]) {
    // argv[2] is the package-manager name, independent of the executable path.
    fs.writeFileSync(path.join(bin, command), `#!${process.execPath}\nprocess.argv.splice(2, 0, ${JSON.stringify(command)}); require(${JSON.stringify(installer)});\n`, { mode: 0o755 });
  }
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ZEROS_DEV_PROFILE_B64: "private-profile-sentinel", DATABASE_URL: "private-dsn-sentinel" };
  const installs = () => fs.existsSync(path.join(root, "installs.jsonl"))
    ? fs.readFileSync(path.join(root, "installs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const run = (script = "electron:dev") => spawnSync("/bin/sh", ["-c", scripts[script]], { cwd: root, env, encoding: "utf8", timeout: 15000 });
  const runAsync = (script = "electron:dev") => new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", scripts[script]], { cwd: root, env });
    let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("error", reject); child.on("close", status => resolve({ status, output }));
  });
  // Reproduce the user's root-only installation without touching a real store.
  spawnSync(process.execPath, [installer, "pnpm", "install", "--frozen-lockfile"], { cwd: root, env: { HOME: home, PATH: env.PATH } });
  fs.unlinkSync(path.join(root, "installs.jsonl"));
  const start = () => spawn(process.execPath, ["scripts/dev-environment/hosted-entry.mjs", "start"], { cwd: root, env });
  return { root, write, run, runAsync, installs, start };
}

describe("hosted Dev dependency preparation", () => {
  it("repairs a root-only synced checkout before loading the R2 client", () => {
    const f = fixture(), result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("HOSTED_READY start");
    expect(f.installs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "pnpm", args: ["--dir", "apps/control-plane", "install", "--frozen-lockfile"] }),
      expect.objectContaining({ command: "npm", args: ["--prefix", "apps/web", "ci"] }),
    ]));
  });

  it("boots without tsx or esbuild installed and reuses every healthy graph on later runs", () => {
    const f = fixture();
    fs.rmSync(path.join(f.root, "node_modules"), { recursive: true });
    const first = f.run();
    expect(first.status, first.stderr).toBe(0);
    const installed = f.installs();
    expect(installed).toHaveLength(3);
    const second = f.run();
    expect(second.status, second.stderr).toBe(0);
    expect(f.installs()).toEqual(installed);
  });

  it.each(["dev:backend", "dev:archive", "dev:doctor", "dev:adopt", "dev:reconcile", "dev:agents", "dev:seed", "electron:run", "electron:dev:watch"])("prepares dependencies for %s, preserving its action", script => {
    const f = fixture(), result = f.run(script);
    expect(result.status, result.stderr).toBe(0);
    const action = script === "electron:run" ? "start --run-only" : script.startsWith("electron:") ? "start" : script.slice(4);
    expect(result.stdout).toContain(`HOSTED_READY ${action}`);
  });

  it("refreshes the changed lockfile's graph without reinstalling the other graphs", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const count = f.installs().length;
    f.write("apps/control-plane/pnpm-lock.yaml", "backend-lock-v2\n");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.installs().slice(count).map(entry => entry.relative)).toEqual(["apps/control-plane"]);
  });

  it("rechecks control-plane install policy changes even before its lockfile changes", () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const count = f.installs().length;
    f.write("apps/control-plane/pnpm-workspace.yaml", "onlyBuiltDependencies: []\noverrides:\n  pg: 2.0.0\n");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.installs().slice(count).map(entry => entry.relative)).toEqual(["apps/control-plane"]);
  });

  it.each(["apps/control-plane/node_modules/@aws-sdk/client-s3", "packages/protocol/node_modules/zod"])("repairs dangling dependency links at %s", relative => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const target = path.join(f.root, relative);
    fs.rmSync(target, { recursive: true }); fs.symlinkSync(path.join(f.root, "missing-package"), target);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(path.join(target, "package.json")).isFile()).toBe(true);
  });

  it("stops before hosted startup if installation fails and retries on the next Run", () => {
    const f = fixture();
    f.write("installer.json", { fail: "apps/control-plane" });
    const failed = f.run();
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).not.toContain("HOSTED_READY");
    expect(failed.stderr).toMatch(/dependenc|install/i);
    f.write("installer.json", {});
    const retried = f.run();
    expect(retried.status, retried.stderr).toBe(0);
  });

  it("serializes simultaneous Runs against one checkout and rechecks after waiting", async () => {
    const f = fixture();
    f.write("installer.json", { delay: 120 });
    const results = await Promise.all([f.runAsync(), f.runAsync()]);
    for (const result of results) expect(result.status, result.output).toBe(0);
    expect(f.installs().map(entry => entry.relative).sort()).toEqual([".", "apps/control-plane", "apps/web"]);
  });

  it("cancels an in-flight install, releases its local lock and retries on Run", async () => {
    const f = fixture();
    f.write("installer.json", { delay: 60000 });
    const child = f.start();
    let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const closed = new Promise<number | null>(resolve => child.on("close", resolve));
    try {
      const deadline = Date.now() + 5000;
      while (!f.installs().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(f.installs()).toHaveLength(1);
      child.kill("SIGTERM");
      expect(await closed).toBe(1);
      expect(output).toContain("interrupted");
      expect(output).not.toContain("HOSTED_READY");
      f.write("installer.json", {});
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(f.installs().map(entry => entry.relative)).toEqual([".", ".", "apps/control-plane", "apps/web"]);
    } finally { child.kill("SIGKILL"); }
  });
});
